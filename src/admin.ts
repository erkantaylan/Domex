import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { count } from "drizzle-orm";
import { readAuthSettings, readCookie } from "./auth";
import { dashboardPage, lockedPage, loginPage } from "./dashboard-page";
import { db } from "./db";
import { clips, languages } from "./db/schema";
import { recentLogs } from "./logs";
import { checkSettings, loadSettings, saveSettings } from "./settings";

// The dashboard's own login: one shared admin from the environment, separate from Discord login.
// A Discord session is never looked at here, so it can't grant admin.
const ADMIN_COOKIE = "lj_admin_session";
const SESSION_MS = 12 * 60 * 60 * 1000;
const MAX_SESSIONS = 100;
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_TRACKED_CLIENTS = 2000;
const MAX_BODY_CHARS = 4096;
const SHARED_BUCKET = "shared";
const OVERFLOW_BUCKET = "overflow";

export type AdminSettings = {
  username: string;
  password: string;
  secure: boolean;
  // False when either setting is empty. The dashboard stays locked, and the bot runs as normal.
  ready: boolean;
};

export function readAdminSettings(): AdminSettings {
  const username = process.env.ADMIN_USERNAME ?? "";
  const password = process.env.ADMIN_PASSWORD ?? "";
  return {
    username,
    password,
    secure: readAuthSettings().secure,
    ready: Boolean(username.trim() && password.trim()),
  };
}

const sha256 = (text: string) => createHash("sha256").update(text).digest();
const hashOf = (sessionId: string) => sha256(sessionId).toString("hex");

// Hashing first makes both sides the same length, so the comparison can't leak the length.
function sameSecret(a: string, b: string) {
  return timingSafeEqual(sha256(a), sha256(b));
}

// Only hashes are kept, with their expiry. A restart logs admins out.
const adminSessions = new Map<string, number>();

function createSession() {
  const now = Date.now();
  for (const [hash, expiresAt] of adminSessions) {
    if (expiresAt <= now) adminSessions.delete(hash);
  }
  // Maps keep their insertion order, so the first key is the oldest login.
  while (adminSessions.size >= MAX_SESSIONS) adminSessions.delete(adminSessions.keys().next().value!);
  const sessionId = randomBytes(32).toString("base64url");
  adminSessions.set(hashOf(sessionId), now + SESSION_MS);
  return sessionId;
}

function isAdmin(request: Request, settings: AdminSettings) {
  if (!settings.ready) return false;
  const sessionId = readCookie(request, ADMIN_COOKIE);
  if (!sessionId) return false;
  const hash = hashOf(sessionId);
  const expiresAt = adminSessions.get(hash);
  if (expiresAt === undefined) return false;
  if (expiresAt > Date.now()) return true;
  adminSessions.delete(hash);
  return false;
}

export function isAdminRequest(request: Request) {
  return isAdmin(request, readAdminSettings());
}

function adminCookie(value: string, maxAgeSeconds: number, secure: boolean) {
  return `${ADMIN_COOKIE}=${value}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

// Wrong passwords per client: the times of recent failures.
const failures = new Map<string, number[]>();

function recentFailures(client: string, now: number) {
  const times = (failures.get(client) ?? []).filter((time) => time > now - FAILURE_WINDOW_MS);
  if (times.length > 0) failures.set(client, times);
  else failures.delete(client);
  return times;
}

// Cloudflare sets this header on everything through the tunnel. Without it, everyone shares one bucket.
function clientOf(request: Request) {
  const client = request.headers.get("cf-connecting-ip")?.trim().slice(0, 64);
  return client ? `ip:${client}` : SHARED_BUCKET;
}

// When the map is full of recent failures, new clients share a bucket. Dropping an old
// entry instead would let someone wipe their own failures by flooding the map.
function bucketFor(client: string, now: number) {
  if (failures.has(client) || failures.size < MAX_TRACKED_CLIENTS) return client;
  for (const key of failures.keys()) recentFailures(key, now);
  return failures.size < MAX_TRACKED_CLIENTS ? client : OVERFLOW_BUCKET;
}

// Seconds until this client may try again, or 0 if it may try now.
function refusedForSeconds(bucket: string, now: number) {
  const times = recentFailures(bucket, now);
  if (times.length < MAX_FAILURES) return 0;
  return Math.ceil((times[0]! + FAILURE_WINDOW_MS - now) / 1000);
}

function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return Response.json(data, { status, headers: { "cache-control": "no-store", ...extraHeaders } });
}

// Nothing here loads from elsewhere, so the page can't be framed or send data to another site.
const PAGE_POLICY =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";

function html(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": PAGE_POLICY,
    },
  });
}

// Both forms send small JSON. Anything else counts as a bad request.
async function readBody(request: Request) {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_CHARS) return null;
  const text = await request.text().catch(() => "");
  if (text.length > MAX_BODY_CHARS) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function tooManyTries(seconds: number) {
  return json({ error: "Too many wrong tries. Try again later." }, 429, { "retry-after": String(seconds) });
}

async function login(request: Request, settings: AdminSettings) {
  if (!settings.ready) return json({ error: "Admin login isn't set up." }, 503);

  const client = clientOf(request);
  const earlyRefusal = refusedForSeconds(bucketFor(client, Date.now()), Date.now());
  if (earlyRefusal > 0) return tooManyTries(earlyRefusal);

  const body = (await readBody(request)) as { username?: unknown; password?: unknown } | null;
  if (typeof body?.username !== "string" || typeof body.password !== "string") {
    return json({ error: "Bad request" }, 400);
  }

  // From here to the end nothing waits, so tries sent at the same moment can't slip past the count.
  const now = Date.now();
  const bucket = bucketFor(client, now);
  const refusal = refusedForSeconds(bucket, now);
  if (refusal > 0) return tooManyTries(refusal);

  // Both are always compared, so the timing can't show that the username alone was right.
  const usernameRight = sameSecret(body.username, settings.username);
  const passwordRight = sameSecret(body.password, settings.password);
  if (!usernameRight || !passwordRight) {
    failures.set(bucket, [...recentFailures(bucket, now), now]);
    return json({ error: "Wrong username or password." }, 401);
  }

  failures.delete(bucket);
  const cookie = adminCookie(createSession(), SESSION_MS / 1000, settings.secure);
  return new Response(null, { status: 204, headers: { "cache-control": "no-store", "set-cookie": cookie } });
}

function logout(request: Request, settings: AdminSettings) {
  const sessionId = readCookie(request, ADMIN_COOKIE);
  if (sessionId) adminSessions.delete(hashOf(sessionId));
  const cookie = adminCookie("", 0, settings.secure);
  return new Response(null, { status: 204, headers: { "cache-control": "no-store", "set-cookie": cookie } });
}

async function settingsApi(request: Request, settings: AdminSettings) {
  // The login check comes first, for every method.
  if (!isAdmin(request, settings)) return json({ error: "Not logged in" }, 401);
  if (request.method === "GET") return json({ settings: await loadSettings() });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const checked = checkSettings(await readBody(request));
  if (!checked.ok) return json({ errors: checked.errors }, 400);
  await saveSettings(checked.settings);
  return json({ settings: checked.settings });
}

async function logsApi(request: Request, settings: AdminSettings) {
  if (!isAdmin(request, settings)) return json({ error: "Not logged in" }, 401);
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  const [languageCount] = await db.select({ total: count() }).from(languages);
  const [clipCount] = await db.select({ total: count() }).from(clips);
  return json({ logs: recentLogs(), languages: languageCount?.total ?? 0, clips: clipCount?.total ?? 0 });
}

function route(request: Request, settings: AdminSettings) {
  const { pathname } = new URL(request.url);
  const { method } = request;

  if (pathname === "/dashboard" && method === "GET") {
    if (!settings.ready) return html(lockedPage, 503);
    return html(isAdmin(request, settings) ? dashboardPage : loginPage);
  }
  // The caller has already checked that POSTs come from our own page.
  if (pathname === "/dashboard/login" && method === "POST") return login(request, settings);
  if (pathname === "/dashboard/logout" && method === "POST") return logout(request, settings);
  if (pathname === "/api/admin/settings") return settingsApi(request, settings);
  if (pathname === "/api/admin/logs") return logsApi(request, settings);
  return null;
}

// Answers the dashboard's addresses, or returns null if the request is for something else.
export async function handleAdminRequest(request: Request, settings: AdminSettings = readAdminSettings()) {
  try {
    return await route(request, settings);
  } catch {
    // No error details: they could hold what was sent, or the values in a database query.
    console.error("A dashboard request failed.");
    return json({ error: "Something went wrong" }, 500);
  }
}
