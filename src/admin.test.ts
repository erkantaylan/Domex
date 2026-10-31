import { afterAll, afterEach, beforeAll, expect, setSystemTime, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { handleAdminRequest, type AdminSettings } from "./admin";
import { startChatPage } from "./chat-page";
import { db, runMigrations } from "./db";
import { gameSettings, sessions } from "./db/schema";
import { checkSettings, DEFAULT_SETTINGS, loadSettings, saveSettings, settingsForNewGame } from "./settings";

// Goes through the real server, so the same-origin check is part of what's tested. Discord is faked.
const USERNAME = "test-admin-name";
const PASSWORD = "test-admin-words";
const DISCORD_SESSION = "test-admin-discord-session";
const DISCORD_USER = "test-admin-discord-user";
const SETTINGS_URL = "/api/admin/settings";
const GOOD = { countdownSeconds: 12, answersOpen: "after", answerSeconds: 45, timerStart: "clip-end" };

const savedEnv = {
  username: process.env.ADMIN_USERNAME,
  password: process.env.ADMIN_PASSWORD,
  publicUrl: process.env.PUBLIC_URL,
};

let server: ReturnType<typeof startChatPage>;
let origin = "";
// Each test gets its own "client", so failures in one can't throttle another.
let clients = 0;
const newClient = () => `198.51.100.${++clients}`;

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
  await db.insert(sessions).values({
    idHash: createHash("sha256").update(DISCORD_SESSION).digest("hex"),
    userId: DISCORD_USER,
    displayName: "Test Player",
    expiresAt: new Date(Date.now() + 60_000),
  });
});

afterEach(() => {
  setSystemTime();
  setCredentials();
  process.env.PUBLIC_URL = "http://test.invalid";
});

afterAll(async () => {
  server.stop(true);
  await db.delete(sessions).where(eq(sessions.userId, DISCORD_USER));
  await saveSettings(DEFAULT_SETTINGS);
  restoreEnv("ADMIN_USERNAME", savedEnv.username);
  restoreEnv("ADMIN_PASSWORD", savedEnv.password);
  restoreEnv("PUBLIC_URL", savedEnv.publicUrl);
});

function get(path: string, cookie?: string) {
  return fetch(origin + path, { headers: cookie ? { cookie } : {} });
}

function post(path: string, body: unknown, options: { cookie?: string; client?: string; origin?: string } = {}) {
  const headers: Record<string, string> = { origin: options.origin ?? origin, "content-type": "application/json" };
  if (options.cookie) headers.cookie = options.cookie;
  if (options.client) headers["cf-connecting-ip"] = options.client;
  return fetch(origin + path, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
}

const tryLogin = (client: string | undefined, password = PASSWORD, username = USERNAME) =>
  post("/dashboard/login", { username, password }, { client });

async function logIn() {
  setCredentials();
  const response = await tryLogin(newClient());
  expect(response.status).toBe(204);
  return response.headers.get("set-cookie")!.split(";")[0]!;
}

test("logged out: the page is only a login form, and the settings API refuses GET and POST", async () => {
  setCredentials();
  await saveSettings({ ...DEFAULT_SETTINGS, answerSeconds: 271 });

  const page = await get("/dashboard");
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain('type="password"');
  expect(html).not.toContain("271");
  expect(html).not.toContain("answerSeconds");
  expect(html).not.toContain(SETTINGS_URL);

  expect((await get(SETTINGS_URL)).status).toBe(401);
  expect((await post(SETTINGS_URL, GOOD)).status).toBe(401);
  expect((await fetch(origin + SETTINGS_URL, { method: "PUT", headers: { origin } })).status).toBe(401);
  expect((await loadSettings()).answerSeconds).toBe(271);
  await saveSettings(DEFAULT_SETTINGS);
});

test("the main page has no dashboard in it and no link to it", async () => {
  const html = await (await get("/")).text();
  expect(html.toLowerCase()).not.toContain("dashboard");
  expect(html).not.toContain("/api/admin");
});

test("POSTs from another site are refused, whether logging in or saving", async () => {
  const cookie = await logIn();
  const elsewhere = { origin: "https://elsewhere.invalid", cookie };
  expect((await post("/dashboard/login", { username: USERNAME, password: PASSWORD }, elsewhere)).status).toBe(403);
  expect((await post(SETTINGS_URL, GOOD, elsewhere)).status).toBe(403);
  expect((await post("/dashboard/logout", {}, elsewhere)).status).toBe(403);
});

test("a wrong password or username is refused without a session", async () => {
  setCredentials();
  const client = newClient();
  for (const [username, password] of [
    [USERNAME, "wrong"],
    ["wrong", PASSWORD],
    ["", ""],
  ]) {
    const response = await tryLogin(client, password, username);
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
  }
});

test("a login with the wrong shape is a bad request", async () => {
  setCredentials();
  expect((await post("/dashboard/login", "not json", { client: newClient() })).status).toBe(400);
  expect((await post("/dashboard/login", { username: 1, password: [] }, { client: newClient() })).status).toBe(400);
  const huge = { username: USERNAME, password: "x".repeat(5000) };
  expect((await post("/dashboard/login", huge, { client: newClient() })).status).toBe(400);
});

test("the session cookie is locked down, 12 hours long, and random", async () => {
  setCredentials();
  process.env.PUBLIC_URL = "https://test.invalid";
  const first = (await tryLogin(newClient())).headers.get("set-cookie")!;
  const second = (await tryLogin(newClient())).headers.get("set-cookie")!;
  expect(first).toMatch(/^lj_admin_session=[\w-]{43,}; /);
  expect(first).toContain("Max-Age=43200");
  expect(first).toContain("HttpOnly");
  expect(first).toContain("SameSite=Strict");
  expect(first).toContain("Secure");
  expect(first.split(";")[0]).not.toBe(second.split(";")[0]);

  process.env.PUBLIC_URL = "http://test.invalid";
  expect((await tryLogin(newClient())).headers.get("set-cookie")).not.toContain("Secure");
});

test("five wrong passwords are refused for 15 minutes, even with the right one, per client", async () => {
  setCredentials();
  const client = newClient();
  const start = Date.now();
  setSystemTime(start);
  for (let i = 0; i < 5; i++) expect((await tryLogin(client, "wrong")).status).toBe(401);

  const refused = await tryLogin(client);
  expect(refused.status).toBe(429);
  expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);

  // Someone else isn't affected.
  expect((await tryLogin(newClient())).status).toBe(204);

  setSystemTime(start + 15 * 60 * 1000 + 1000);
  expect((await tryLogin(client)).status).toBe(204);
});

test("old failures fall out of the window, and a right password clears them", async () => {
  setCredentials();
  const client = newClient();
  const start = Date.now();
  setSystemTime(start);
  for (let i = 0; i < 4; i++) expect((await tryLogin(client, "wrong")).status).toBe(401);
  setSystemTime(start + 16 * 60 * 1000);
  for (let i = 0; i < 4; i++) expect((await tryLogin(client, "wrong")).status).toBe(401);
  expect((await tryLogin(client)).status).toBe(204);
  for (let i = 0; i < 5; i++) expect((await tryLogin(client, "wrong")).status).toBe(401);
  expect((await tryLogin(client)).status).toBe(429);
});

test("wrong tries sent at the same moment can't get past the limit", async () => {
  setCredentials();
  const client = newClient();
  const results = await Promise.all(Array.from({ length: 20 }, () => tryLogin(client, "wrong")));
  expect(results.filter((response) => response.status === 401).length).toBe(5);
  expect(results.filter((response) => response.status === 429).length).toBe(15);
});

test("without the tunnel's header everyone shares one bucket", async () => {
  setCredentials();
  const start = Date.now();
  setSystemTime(start);
  for (let i = 0; i < 5; i++) expect((await tryLogin(undefined, "wrong")).status).toBe(401);
  expect((await tryLogin(undefined)).status).toBe(429);
});

test("the failure map stays limited: when full, new clients share a bucket and old ones stay refused", async () => {
  const settings: AdminSettings = { username: USERNAME, password: PASSWORD, secure: false, ready: true };
  const attempt = (client: string, password = "wrong") =>
    handleAdminRequest(
      new Request(`${origin}/dashboard/login`, {
        method: "POST",
        headers: { "cf-connecting-ip": client },
        body: JSON.stringify({ username: USERNAME, password }),
      }),
      settings,
    ) as Promise<Response>;

  const start = Date.now();
  setSystemTime(start);
  const first = newClient();
  for (let i = 0; i < 5; i++) await attempt(first);
  for (let i = 0; i < 2100; i++) await attempt(`flood-${i}`);

  expect((await attempt(first, PASSWORD)).status).toBe(429);
  // The flood went over the limit, so the shared overflow bucket is already used up.
  expect((await attempt("late-other", PASSWORD)).status).toBe(429);

  // Once the failures age out, the map frees up.
  setSystemTime(start + 16 * 60 * 1000);
  expect((await attempt("late-other", PASSWORD)).status).toBe(204);
});

test("a very long client header can't grow the map's keys", async () => {
  setCredentials();
  const client = "x".repeat(70);
  for (let i = 0; i < 5; i++) await tryLogin(client, "wrong");
  // Same first 64 characters, so the same bucket.
  expect((await tryLogin("x".repeat(90))).status).toBe(429);
});

test("empty or missing settings lock the dashboard, and an existing session stops working", async () => {
  const cookie = await logIn();
  for (const [username, password] of [
    ["", PASSWORD],
    [USERNAME, ""],
    ["", ""],
    ["  ", "  "],
  ]) {
    setCredentials(username, password);
    const page = await get("/dashboard", cookie);
    expect(page.status).toBe(503);
    const html = await page.text();
    expect(html).toContain("isn't set up");
    expect(html).not.toContain("<form");
    expect((await tryLogin(newClient(), password!, username!)).status).toBe(503);
    expect((await get(SETTINGS_URL, cookie)).status).toBe(401);
    expect((await post(SETTINGS_URL, GOOD, { cookie })).status).toBe(401);
  }

  delete process.env.ADMIN_USERNAME;
  delete process.env.ADMIN_PASSWORD;
  expect((await get("/dashboard")).status).toBe(503);
  expect((await tryLogin(newClient(), "", "")).status).toBe(503);
  expect((await get(SETTINGS_URL)).status).toBe(401);
});

test("a Discord login never grants admin, and an admin session isn't a Discord login", async () => {
  setCredentials();
  const discord = `lj_session=${DISCORD_SESSION}`;
  // It really is a working Discord session.
  expect((await get("/api/me", discord)).status).toBe(200);

  for (const cookie of [discord, `lj_admin_session=${DISCORD_SESSION}`]) {
    expect(await (await get("/dashboard", cookie)).text()).not.toContain(SETTINGS_URL);
    expect((await get(SETTINGS_URL, cookie)).status).toBe(401);
    expect((await post(SETTINGS_URL, GOOD, { cookie })).status).toBe(401);
  }

  const admin = await logIn();
  expect((await get("/api/me", admin)).status).toBe(401);
  expect((await get("/api/me", admin.replace("lj_admin_session", "lj_session"))).status).toBe(401);
});

test("logging out ends the session", async () => {
  const cookie = await logIn();
  expect((await get(SETTINGS_URL, cookie)).status).toBe(200);
  const out = await post("/dashboard/logout", {}, { cookie });
  expect(out.status).toBe(204);
  expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
  expect((await get(SETTINGS_URL, cookie)).status).toBe(401);
});

test("a session ends after 12 hours", async () => {
  const start = Date.now();
  setSystemTime(start);
  const cookie = await logIn();
  setSystemTime(start + 11 * 60 * 60 * 1000);
  expect((await get(SETTINGS_URL, cookie)).status).toBe(200);
  setSystemTime(start + 12 * 60 * 60 * 1000 + 1000);
  expect((await get(SETTINGS_URL, cookie)).status).toBe(401);
});

test("an admin sees the form, saves settings, and they load back", async () => {
  const cookie = await logIn();
  const page = await get("/dashboard", cookie);
  const html = await page.text();
  expect(html).toContain(SETTINGS_URL);
  expect(html).toContain("from the next game");
  expect(page.headers.get("cache-control")).toBe("no-store");

  expect(await (await get(SETTINGS_URL, cookie)).json()).toEqual({ settings: DEFAULT_SETTINGS });

  const saved = await post(SETTINGS_URL, GOOD, { cookie });
  expect(saved.status).toBe(200);
  expect(await saved.json()).toEqual({ settings: GOOD });
  expect(await (await get(SETTINGS_URL, cookie)).json()).toEqual({ settings: GOOD });
  expect(await loadSettings()).toEqual(GOOD as typeof DEFAULT_SETTINGS);

  // Saving again changes the one row, it doesn't add another.
  await post(SETTINGS_URL, { ...GOOD, answerSeconds: 46 }, { cookie });
  expect((await db.select().from(gameSettings)).length).toBe(1);
  await saveSettings(DEFAULT_SETTINGS);
});

test("the server rejects bad values with a 400 and saves nothing", async () => {
  const cookie = await logIn();
  await saveSettings(DEFAULT_SETTINGS);
  const bad: unknown[] = [
    { ...GOOD, countdownSeconds: -1 },
    { ...GOOD, countdownSeconds: 61 },
    { ...GOOD, countdownSeconds: 1.5 },
    { ...GOOD, countdownSeconds: "5" },
    { ...GOOD, countdownSeconds: null },
    { ...GOOD, answerSeconds: 4 },
    { ...GOOD, answerSeconds: 301 },
    { ...GOOD, answerSeconds: 30.5 },
    { ...GOOD, answersOpen: "sometimes" },
    { ...GOOD, timerStart: "whenever" },
    { ...GOOD, extra: true },
    { countdownSeconds: 5 },
    [],
    null,
    "not json",
  ];
  for (const body of bad) {
    const response = await post(SETTINGS_URL, body, { cookie });
    expect(response.status).toBe(400);
    expect(Object.keys(((await response.json()) as { errors: object }).errors).length).toBeGreaterThan(0);
  }
  expect(await loadSettings()).toEqual(DEFAULT_SETTINGS);
});

test("the limits themselves are allowed", () => {
  for (const [countdownSeconds, answerSeconds] of [
    [0, 5],
    [60, 300],
  ]) {
    expect(checkSettings({ ...GOOD, countdownSeconds, answerSeconds }).ok).toBe(true);
  }
});

test("reading settings falls back to the defaults for a missing row or a bad number", async () => {
  await db.delete(gameSettings);
  expect(await loadSettings()).toEqual(DEFAULT_SETTINGS);
  expect(await settingsForNewGame()).toEqual(DEFAULT_SETTINGS);

  await db.insert(gameSettings).values({ id: 1, countdownSeconds: -3, answerSeconds: 9999, answersOpen: "after" });
  expect(await loadSettings()).toEqual({ ...DEFAULT_SETTINGS, answersOpen: "after" });
  await saveSettings(DEFAULT_SETTINGS);
});

test("nothing logs the username, the password or a cookie, even when a request fails", async () => {
  const cookie = await logIn();
  const logs = [spyOn(console, "error"), spyOn(console, "log"), spyOn(console, "warn")];
  const loggedOut = await post("/dashboard/login", { username: "typed-name", password: "typed-word" }, { client: newClient() });
  expect(loggedOut.status).toBe(401);
  await get(SETTINGS_URL, cookie);
  const written = logs.flatMap((log) => log.mock.calls.flat()).join(" ");
  logs.forEach((log) => log.mockRestore());
  expect(written).not.toContain("typed-name");
  expect(written).not.toContain("typed-word");
  expect(written).not.toContain(cookie);
});
