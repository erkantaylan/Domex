import { afterAll, afterEach, beforeAll, expect, setSystemTime, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { eq, like } from "drizzle-orm";
import { startChatPage } from "./chat-page";
import { db, runMigrations } from "./db";
import { adminTokens } from "./db/schema";
import { addLog, captureLogs, recentLogs } from "./logs";
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "./settings";

// Goes through the real server, like admin.test.ts, so the same-page check is part of what's tested.
const USERNAME = "test-token-admin";
const PASSWORD = "test-token-words";
const NAME_PREFIX = "test-token-";
const SETTINGS_URL = "/api/admin/settings";
const GOOD = { countdownSeconds: 7, answersOpen: "after", answerSeconds: 33, timerStart: "clip-end" };
const DAY_MS = 24 * 60 * 60 * 1000;

const savedEnv = { username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD };
const savedConsole = { log: console.log, warn: console.warn, error: console.error };

let server: ReturnType<typeof startChatPage>;
let origin = "";
let names = 0;
let clients = 0;

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function setCredentials(username = USERNAME, password = PASSWORD) {
  process.env.ADMIN_USERNAME = username;
  process.env.ADMIN_PASSWORD = password;
}

beforeAll(async () => {
  await runMigrations();
  await saveSettings(DEFAULT_SETTINGS);
  // The bot does this at startup. It's what puts console.log lines in the dashboard's log.
  captureLogs();
  const none = async () => [];
  server = startChatPage(0, {
    listChannels: none,
    send: async () => {},
    listVoiceChannels: none,
    currentVoiceChannelId: () => null,
    joinVoice: async () => {},
    leaveVoice: () => {},
    playClip: async () => {},
  });
  origin = `http://127.0.0.1:${server.port}`;
});

afterEach(() => {
  setSystemTime();
  setCredentials();
});

afterAll(async () => {
  server.stop(true);
  await db.delete(adminTokens).where(like(adminTokens.name, `${NAME_PREFIX}%`));
  await saveSettings(DEFAULT_SETTINGS);
  Object.assign(console, savedConsole);
  restoreEnv("ADMIN_USERNAME", savedEnv.username);
  restoreEnv("ADMIN_PASSWORD", savedEnv.password);
});

type Options = { method?: string; body?: unknown; cookie?: string; auth?: string; origin?: string | null };

// An agent with a token sends no Origin. The dashboard page sends its own.
function call(path: string, options: Options = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.cookie) headers.cookie = options.cookie;
  if (options.auth !== undefined) headers.authorization = options.auth;
  const from = options.origin === undefined ? (options.auth === undefined ? origin : null) : options.origin;
  if (from) headers.origin = from;
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  return fetch(origin + path, { method: options.method ?? "GET", headers, body, redirect: "manual" });
}

const withToken = (token: string, path: string, options: Options = {}) => call(path, { ...options, auth: `Bearer ${token}` });

async function logIn() {
  setCredentials();
  const response = await fetch(origin + "/dashboard/login", {
    method: "POST",
    headers: { origin, "content-type": "application/json", "cf-connecting-ip": `203.0.113.${++clients}` },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  expect(response.status).toBe(204);
  return response.headers.get("set-cookie")!.split(";")[0]!;
}

type Made = { id: number; name: string; expiresAt: string; token: string };

async function makeToken(cookie: string) {
  const name = `${NAME_PREFIX}${++names}`;
  const response = await call("/api/admin/tokens", { method: "POST", body: { name }, cookie });
  expect(response.status).toBe(201);
  return (await response.json()) as Made;
}

type Listed = { id: number; name: string; lastUsedAt: string | null; status: string };

async function listed(cookie: string, id: number) {
  const response = await call("/api/admin/tokens", { cookie });
  expect(response.status).toBe(200);
  return ((await response.json()) as { tokens: Listed[] }).tokens.find((token) => token.id === id);
}

test("making a token needs the login, and the database keeps only its hash", async () => {
  expect((await call("/api/admin/tokens", { method: "POST", body: { name: `${NAME_PREFIX}x` } })).status).toBe(401);
  expect((await call("/api/admin/tokens")).status).toBe(401);

  const cookie = await logIn();
  const made = await makeToken(cookie);
  expect(made.token).toMatch(/^lj_[\w-]{43}$/);

  const [row] = await db.select().from(adminTokens).where(eq(adminTokens.id, made.id));
  expect(row!.tokenHash).toBe(createHash("sha256").update(made.token).digest("hex"));
  expect(JSON.stringify(row)).not.toContain(made.token);
  expect(JSON.stringify(await (await call("/api/admin/tokens", { cookie })).json())).not.toContain(made.token);

  // A token can't make more tokens or revoke any, even with the login cookie next to it.
  for (const extra of [{}, { cookie }]) {
    expect((await withToken(made.token, "/api/admin/tokens", { method: "POST", body: { name: `${NAME_PREFIX}y` }, ...extra })).status).toBe(401);
    expect((await withToken(made.token, "/api/admin/tokens", extra)).status).toBe(401);
    expect((await withToken(made.token, "/api/admin/tokens/revoke", { method: "POST", body: { id: made.id }, ...extra })).status).toBe(401);
  }
  expect((await listed(cookie, made.id))!.status).toBe("active");
});

test("a bad token name is refused", async () => {
  const cookie = await logIn();
  for (const name of ["", "   ", "x".repeat(41), "line\nbreak", 5]) {
    expect((await call("/api/admin/tokens", { method: "POST", body: { name }, cookie })).status).toBe(400);
  }
});

test("a token reads settings, logs and clips, and saves settings with no Origin, which the log records", async () => {
  const { token, name } = await makeToken(await logIn());
  for (const path of [SETTINGS_URL, "/api/admin/logs", "/api/admin/clips"]) {
    expect((await withToken(token, path)).status).toBe(200);
  }

  const saved = await withToken(token, SETTINGS_URL, { method: "POST", body: GOOD });
  expect(saved.status).toBe(200);
  expect(await loadSettings()).toEqual(GOOD as typeof DEFAULT_SETTINGS);
  expect(recentLogs().some((entry) => entry.text.includes(`"${name}" saved the game timings`))).toBe(true);
  await saveSettings(DEFAULT_SETTINGS);
});

test("a token is refused everywhere else, and its cookie doesn't help", async () => {
  const cookie = await logIn();
  const { token } = await makeToken(cookie);
  for (const extra of [{}, { cookie }]) {
    expect((await withToken(token, "/api/send", { method: "POST", body: { channelId: "1", text: "hi" }, ...extra })).status).toBe(401);
    expect((await withToken(token, "/api/voice/play", { method: "POST", body: {}, ...extra })).status).toBe(401);
    expect((await withToken(token, "/api/voice", extra)).status).toBe(401);
    expect((await withToken(token, "/api/channels", extra)).status).toBe(401);
    expect((await withToken(token, "/api/messages", extra)).status).toBe(401);

    const page = await (await withToken(token, "/dashboard", extra)).text();
    expect(page).toContain('type="password"');
    expect(page).not.toContain(SETTINGS_URL);

    const testing = await withToken(token, "/dashboard/testing", extra);
    expect(testing.status).toBe(302);
    expect(testing.headers.get("location")).toBe("/dashboard");
  }
  // The same cookie on its own still works, so it really was the token that was judged.
  expect((await call("/api/messages", { cookie })).status).toBe(200);
});

test("unknown, malformed and empty tokens are refused, even next to a good login cookie", async () => {
  const cookie = await logIn();
  const { token } = await makeToken(cookie);
  const bad = [
    `Bearer lj_${randomBytes(32).toString("base64url")}`,
    `Bearer ${token.slice(0, -1)}`,
    `Bearer ${token}x`,
    `Bearer ${token.slice(3)}`,
    `bearer ${token}`,
    token,
    "Bearer ",
    "Bearer",
    "",
    "Basic dXNlcjpwYXNz",
  ];
  for (const auth of bad) {
    expect((await call(SETTINGS_URL, { auth })).status).toBe(401);
    expect((await call(SETTINGS_URL, { auth, cookie })).status).toBe(401);
  }

  // Another site sending the cookie with a made-up token gets nowhere and changes nothing.
  for (const auth of [`Bearer lj_${randomBytes(32).toString("base64url")}`, "Bearer x"]) {
    const crossSite = await call(SETTINGS_URL, { method: "POST", body: GOOD, cookie, auth, origin: "https://elsewhere.invalid" });
    expect(crossSite.status).toBe(401);
  }
  expect(await loadSettings()).toEqual(DEFAULT_SETTINGS);
});

test("a token stops working after 7 days", async () => {
  const start = Date.now();
  setSystemTime(start);
  const { id, token } = await makeToken(await logIn());

  setSystemTime(start + 7 * DAY_MS - 60_000);
  expect((await withToken(token, SETTINGS_URL)).status).toBe(200);
  setSystemTime(start + 7 * DAY_MS + 1000);
  expect((await withToken(token, SETTINGS_URL)).status).toBe(401);
  // The 12-hour login from the start has ended too, so log in again to see the list.
  expect((await listed(await logIn(), id))!.status).toBe("expired");
});

test("using a token marks it used, and a revoked token is refused but stays in the list", async () => {
  const cookie = await logIn();
  const { id, token } = await makeToken(cookie);
  expect((await listed(cookie, id))!.lastUsedAt).toBeNull();
  expect((await withToken(token, "/api/admin/logs")).status).toBe(200);
  expect((await listed(cookie, id))!.lastUsedAt).not.toBeNull();

  for (const body of [{ id: String(id) }, { id: 1.5 }, { id: 2 ** 40 }, {}]) {
    expect((await call("/api/admin/tokens/revoke", { method: "POST", body, cookie })).status).toBe(400);
  }
  expect((await call("/api/admin/tokens/revoke", { method: "POST", body: { id } })).status).toBe(401);
  expect((await call("/api/admin/tokens/revoke", { method: "POST", body: { id }, cookie })).status).toBe(204);
  expect((await withToken(token, SETTINGS_URL)).status).toBe(401);
  expect((await call("/api/admin/tokens/revoke", { method: "POST", body: { id }, cookie })).status).toBe(404);

  const row = await listed(cookie, id);
  expect(row!.status).toBe("revoked");
  expect(row!.name).toStartWith(NAME_PREFIX);
});

test("tokens stop working while the admin login isn't set up", async () => {
  const { token } = await makeToken(await logIn());
  for (const [username, password] of [
    ["", ""],
    ["", PASSWORD],
    [USERNAME, ""],
  ]) {
    setCredentials(username, password);
    expect((await withToken(token, SETTINGS_URL)).status).toBe(401);
    expect((await withToken(token, SETTINGS_URL, { method: "POST", body: GOOD })).status).toBe(401);
  }
  expect(await loadSettings()).toEqual(DEFAULT_SETTINGS);

  setCredentials();
  expect((await withToken(token, SETTINGS_URL)).status).toBe(200);
});

test("the token itself never reaches the log", async () => {
  const cookie = await logIn();
  const { id, token } = await makeToken(cookie);
  await withToken(token, SETTINGS_URL, { method: "POST", body: GOOD });
  await call("/api/admin/tokens/revoke", { method: "POST", body: { id }, cookie });
  await saveSettings(DEFAULT_SETTINGS);
  // Even if some code logged it by mistake. addLog is what console.log feeds, without printing it here.
  addLog("info", ["Oops, printed", token]);
  addLog("error", [`Authorization: Bearer ${token}`]);

  const logs = recentLogs().map((entry) => entry.text).join("\n");
  expect(logs).not.toContain(token);
  expect(logs).not.toContain(token.slice(3));
  expect(logs).toContain("Oops, printed [hidden]");
});
