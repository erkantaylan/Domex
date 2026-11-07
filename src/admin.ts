import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, count, desc, eq, gt, isNull } from "drizzle-orm";
import { readAuthSettings, readCookie } from "./auth";
import { checkClipNames, listClipPaths, looksLikeMp3, MAX_CLIP_BYTES, saveClip } from "./clips";
import { dashboardPage, lockedPage, loginPage } from "./dashboard-page";
import { db } from "./db";
import { adminTokens, clips, languages } from "./db/schema";
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
const TOKEN_PREFIX = "lj_";
const TOKEN_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_TOKEN_NAME = 40;

// The only addresses a token may use. Everything else the admin can do needs the password
// login: making and revoking tokens, the dashboard pages, posting as the bot and voice.
const TOKEN_PATHS = new Set(["/api/admin/settings", "/api/admin/logs", "/api/admin/clips"]);

// Who a request comes from. A token carries its name, so the log can say which one did what.
export type Admin = { by: "login" } | { by: "token"; name: string };

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

function hasLoginCookie(request: Request) {
  const sessionId = readCookie(request, ADMIN_COOKIE);
  if (!sessionId) return false;
  const hash = hashOf(sessionId);
  const expiresAt = adminSessions.get(hash);
  if (expiresAt === undefined) return false;
  if (expiresAt > Date.now()) return true;
  adminSessions.delete(hash);
  return false;
}

// One update finds the token and marks it used, so a revoked or expired token never counts.
async function tokenName(token: string) {
  const now = new Date();
  const [row] = await db
    .update(adminTokens)
    .set({ lastUsedAt: now })
    .where(and(eq(adminTokens.tokenHash, hashOf(token)), isNull(adminTokens.revokedAt), gt(adminTokens.expiresAt, now)))
    .returning({ name: adminTokens.name });
  return row?.name ?? null;
}

// The one place that decides whether a request comes from the admin, and how.
export async function adminOf(request: Request, settings: AdminSettings = readAdminSettings()): Promise<Admin | null> {
  if (!settings.ready) return null;
  const header = request.headers.get("authorization");
  // A request with a token is judged on the token alone and its cookie is ignored. That's what
  // lets token requests skip the same-page check: another site can't add this header.
  if (header !== null) {
    if (!TOKEN_PATHS.has(new URL(request.url).pathname)) return null;
    const token = /^Bearer (lj_[A-Za-z0-9_-]{43})$/.exec(header.trim())?.[1];
    const name = token ? await tokenName(token) : null;
    return name === null ? null : { by: "token", name };
  }
  return hasLoginCookie(request) ? { by: "login" } : null;
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
  const admin = await adminOf(request, settings);
  if (!admin) return json({ error: "Not logged in" }, 401);
  if (request.method === "GET") return json({ settings: await loadSettings() });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const checked = checkSettings(await readBody(request));
  if (!checked.ok) return json({ errors: checked.errors }, 400);
  await saveSettings(checked.settings);
  logChange(admin, "saved the game timings.");
  return json({ settings: checked.settings });
}

async function logsApi(request: Request, settings: AdminSettings) {
  if (!(await adminOf(request, settings))) return json({ error: "Not logged in" }, 401);
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  const [languageCount] = await db.select({ total: count() }).from(languages);
  const [clipCount] = await db.select({ total: count() }).from(clips);
  return json({ logs: recentLogs(), languages: languageCount?.total ?? 0, clips: clipCount?.total ?? 0 });
}

async function clipsApi(request: Request, settings: AdminSettings) {
  const admin = await adminOf(request, settings);
  if (!admin) return json({ error: "Not logged in" }, 401);
  if (request.method === "GET") return json({ paths: await listClipPaths() });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const { searchParams } = new URL(request.url);
  const problem = checkClipNames(searchParams.get("language") ?? "", searchParams.get("name") ?? "");
  if (problem) return json({ error: problem }, 400);
  if (Number(request.headers.get("content-length") ?? 0) > MAX_CLIP_BYTES) return json({ error: "File too big" }, 413);

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > MAX_CLIP_BYTES) return json({ error: "File too big" }, 413);
  if (!looksLikeMp3(bytes)) return json({ error: "That isn't an MP3 file" }, 400);

  await saveClip(searchParams.get("language")!, searchParams.get("name")!, bytes);
  logChange(admin, `uploaded the clip ${searchParams.get("language")}/${searchParams.get("name")}.`);
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

// Changes made with a token go in the dashboard's log, with the token's name. The admin's own
// changes don't: a folder upload would fill the log with one line per clip.
function logChange(admin: Admin, what: string) {
  if (admin.by === "token") console.log(`Admin token "${admin.name}" ${what}`);
}

function tokenStatus(row: { revokedAt: Date | null; expiresAt: Date }) {
  if (row.revokedAt) return "revoked";
  return row.expiresAt.getTime() > Date.now() ? "active" : "expired";
}

// Only the password login gets here: these addresses aren't in TOKEN_PATHS.
async function tokensApi(request: Request, settings: AdminSettings) {
  if (!(await adminOf(request, settings))) return json({ error: "Not logged in" }, 401);
  if (request.method === "GET") {
    const rows = await db.select().from(adminTokens).orderBy(desc(adminTokens.createdAt)).limit(100);
    return json({
      tokens: rows.map((row) => ({
        id: row.id,
        name: row.name,
        createdAt: row.createdAt,
        lastUsedAt: row.lastUsedAt,
        expiresAt: row.expiresAt,
        status: tokenStatus(row),
      })),
    });
  }
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const body = (await readBody(request)) as { name?: unknown } | null;
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name || name.length > MAX_TOKEN_NAME || /[\p{Cc}]/u.test(name)) {
    return json({ error: `Give the token a name of up to ${MAX_TOKEN_NAME} characters.` }, 400);
  }

  const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
  const [row] = await db
    .insert(adminTokens)
    .values({ name, tokenHash: hashOf(token), expiresAt: new Date(Date.now() + TOKEN_MS) })
    .returning({ id: adminTokens.id, expiresAt: adminTokens.expiresAt });
  console.log(`The admin made a token named "${name}".`);
  // The only time the token itself leaves the server.
  return json({ id: row!.id, name, expiresAt: row!.expiresAt, token }, 201);
}

async function revokeApi(request: Request, settings: AdminSettings) {
  if (!(await adminOf(request, settings))) return json({ error: "Not logged in" }, 401);
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const body = (await readBody(request)) as { id?: unknown } | null;
  // Ids outside Postgres's integer range would make the query fail, so they're a bad request too.
  const id = body?.id;
  if (typeof id !== "number" || !Number.isInteger(id) || id < 1 || id > 2_147_483_647) {
    return json({ error: "Bad request" }, 400);
  }
  // The row stays, so the list and old log lines still show the name.
  const [row] = await db
    .update(adminTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(adminTokens.id, id), isNull(adminTokens.revokedAt)))
    .returning({ name: adminTokens.name });
  if (!row) return json({ error: "No such token, or it's already revoked." }, 404);
  console.log(`The admin revoked the token named "${row.name}".`);
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

async function route(request: Request, settings: AdminSettings) {
  const { pathname } = new URL(request.url);
  const { method } = request;

  if (pathname === "/dashboard" && method === "GET") {
    if (!settings.ready) return html(lockedPage, 503);
    return html((await adminOf(request, settings)) ? dashboardPage : loginPage);
  }
  // The caller has already checked that POSTs come from our own page.
  if (pathname === "/dashboard/login" && method === "POST") return login(request, settings);
  if (pathname === "/dashboard/logout" && method === "POST") return logout(request, settings);
  if (pathname === "/api/admin/settings") return settingsApi(request, settings);
  if (pathname === "/api/admin/logs") return logsApi(request, settings);
  if (pathname === "/api/admin/clips") return clipsApi(request, settings);
  if (pathname === "/api/admin/tokens") return tokensApi(request, settings);
  if (pathname === "/api/admin/tokens/revoke") return revokeApi(request, settings);
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
