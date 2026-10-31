import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import { handleAuthRequest, type AuthSettings, type Fetcher } from "./auth";
import { startChatPage } from "./chat-page";
import { db, runMigrations } from "./db";
import { clips, games, guesses, languages, rounds, sessions } from "./db/schema";

// Real database, Discord faked. Games reuse existing clips: a made-up clip in the table
// could be picked by a real game running on the bot at the same moment.
const ORIGIN = "https://test.invalid";
const SETTINGS: AuthSettings = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  publicOrigin: ORIGIN,
  secure: true,
  ready: true,
};
const ALICE = "test-auth-user-alice";
const BOB = "test-auth-user-bob";
const NEW_USER = "test-auth-user-new";
const GUILD = "test-auth-guild";

let known: { clipId: number; filePath: string; language: string }[] = [];
const hash = (id: string) => createHash("sha256").update(id).digest("hex");

function get(path: string, cookie?: string) {
  return new Request(ORIGIN + path, { headers: cookie ? { cookie } : {} });
}

function request(req: Request, settings = SETTINGS, fetcher: Fetcher = neverCalled) {
  return handleAuthRequest(req, settings, fetcher) as Promise<Response>;
}

const neverCalled: Fetcher = async () => {
  throw new Error("Discord should not have been called");
};

async function addSession(sessionId: string, userId: string, expiresAt: Date) {
  await db.insert(sessions).values({ idHash: hash(sessionId), userId, displayName: "Test Player", expiresAt });
}

async function addGame(status: "running" | "finished" | "stopped", startedAt: Date) {
  const [game] = await db.insert(games).values({ guildId: GUILD, channelId: "test-channel", startedBy: BOB, status, startedAt }).returning();
  return game!.id;
}

async function addRound(gameId: number, number: number, clipId: number) {
  const [round] = await db.insert(rounds).values({ gameId, number, clipId }).returning();
  return round!.id;
}

async function addGuess(roundId: number, userId: string, text: string, correct: boolean) {
  await db.insert(guesses).values({ roundId, userId, text, correct });
}

beforeAll(async () => {
  await runMigrations();
  const rows = await db
    .select({ clipId: clips.id, filePath: clips.filePath, language: languages.name })
    .from(clips)
    .innerJoin(languages, eq(clips.languageId, languages.id));
  known = [...new Map(rows.map((row) => [row.language, row])).values()];
  if (known.length < 4) throw new Error("These tests need clips in at least 4 languages.");
});

afterAll(async () => {
  await db.delete(games).where(eq(games.guildId, GUILD));
  await db.delete(sessions).where(like(sessions.userId, "test-auth-user-%"));
});

test("login sends only the identify scope and a state that matches its short-lived cookie", async () => {
  const response = await request(get("/auth/login"));
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location")!);
  expect(location.origin + location.pathname).toBe("https://discord.com/oauth2/authorize");
  expect(location.searchParams.get("scope")).toBe("identify");
  expect(location.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/callback`);
  const state = location.searchParams.get("state")!;
  expect(state.length).toBeGreaterThanOrEqual(32);
  const [cookie] = response.headers.getSetCookie();
  expect(cookie).toStartWith(`lj_login_state=${state};`);
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("SameSite=Lax");
  expect(cookie).toContain("Secure");
});

test("redirect_uri ignores the request's Host and only uses PUBLIC_URL", async () => {
  const response = await request(new Request(`${ORIGIN}/auth/login`, { headers: { host: "evil.invalid", "x-forwarded-host": "evil.invalid" } }));
  expect(new URL(response.headers.get("location")!).searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/callback`);
});

test("login opened on another address goes to PUBLIC_URL first", async () => {
  const response = await request(new Request("http://127.0.0.1:3100/auth/login"));
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe(`${ORIGIN}/auth/login`);
  expect(response.headers.getSetCookie()).toEqual([]);
});

test.each([
  ["a different state", "/auth/callback?code=abc&state=wrong", "lj_login_state=right"],
  ["no state cookie", "/auth/callback?code=abc&state=right", undefined],
  ["no state in the address", "/auth/callback?code=abc", "lj_login_state=right"],
])("callback with %s is refused without calling Discord", async (_name, path, cookie) => {
  const response = await request(get(path, cookie));
  expect(response.status).toBe(400);
  expect(response.headers.getSetCookie().join()).not.toContain("lj_session=");
});

test("a good callback saves a hashed session and keeps no Discord token", async () => {
  const calls: { url: string; body: string }[] = [];
  const discord: Fetcher = async (url, init) => {
    calls.push({ url, body: String(init?.body ?? "") });
    if (url.endsWith("/oauth2/token")) {
      return Response.json({ access_token: "fake-access", refresh_token: "fake-refresh", token_type: "Bearer" });
    }
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fake-access");
    return Response.json({ id: NEW_USER, username: "new_user", global_name: "New Player" });
  };
  const response = await request(get("/auth/callback?code=fake-code&state=right", "lj_login_state=right"), SETTINGS, discord);
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe("/");

  const form = new URLSearchParams(calls[0]!.body);
  expect(form.get("code")).toBe("fake-code");
  expect(form.get("redirect_uri")).toBe(`${ORIGIN}/auth/callback`);

  const sessionCookie = response.headers.getSetCookie().find((value) => value.startsWith("lj_session="))!;
  expect(sessionCookie).toContain("HttpOnly");
  expect(sessionCookie).toContain("SameSite=Lax");
  expect(sessionCookie).toContain("Secure");
  const sessionId = sessionCookie.split(";")[0]!.split("=")[1]!;
  expect(Buffer.from(sessionId, "base64url").length).toBe(32);

  const [row] = await db.select().from(sessions).where(eq(sessions.userId, NEW_USER));
  expect(row!.idHash).toBe(hash(sessionId));
  expect(row!.displayName).toBe("New Player");
  expect(JSON.stringify(row)).not.toContain("fake-access");
  const days = (row!.expiresAt.getTime() - Date.now()) / 86_400_000;
  expect(days).toBeGreaterThan(6.99);
  expect(days).toBeLessThanOrEqual(7);

  const me = await request(get("/api/me", `lj_session=${sessionId}`));
  expect(await me.json()).toEqual({ id: NEW_USER, name: "New Player" });

  // The stored hash on its own must not work as a cookie.
  expect((await request(get("/api/me", `lj_session=${row!.idHash}`))).status).toBe(401);
});

test("a refusal from Discord creates no session and logs no code or secret", async () => {
  const logged: unknown[][] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => logged.push(args);
  try {
    const refused: Fetcher = async () => new Response('{"error":"invalid_grant"}', { status: 400 });
    const response = await request(get("/auth/callback?code=fake-secret-code&state=s", "lj_login_state=s"), SETTINGS, refused);
    expect(response.status).toBe(502);
    expect(response.headers.getSetCookie().join()).not.toContain("lj_session=");
  } finally {
    console.error = realError;
  }
  const text = JSON.stringify(logged);
  expect(text).not.toContain("fake-secret-code");
  expect(text).not.toContain(SETTINGS.clientSecret);
});

test("missing settings show that login isn't set up, without calling Discord", async () => {
  const off = { ...SETTINGS, clientSecret: "", ready: false };
  const page = await request(get("/auth/login"), off);
  expect(page.status).toBe(503);
  expect(await page.text()).toContain("isn't set up");
  expect((await request(get("/auth/callback?code=a&state=b", "lj_login_state=b"), off)).status).toBe(503);
  const me = await request(get("/api/me"), off);
  expect(me.status).toBe(401);
  expect(await me.json()).toMatchObject({ loginAvailable: false });
});

test.each(["/api/me", "/api/history"])("%s answers 401 for no, unknown or expired sessions", async (path) => {
  await addSession("test-expired-session", ALICE, new Date(Date.now() - 1000));
  expect((await request(get(path))).status).toBe(401);
  expect((await request(get(path, "lj_session=test-unknown-session"))).status).toBe(401);
  expect((await request(get(path, "lj_session=test-expired-session"))).status).toBe(401);
  await db.delete(sessions).where(eq(sessions.idHash, hash("test-expired-session")));
});

test("logout deletes the session and clears the cookie", async () => {
  await addSession("test-logout-session", ALICE, new Date(Date.now() + 60_000));
  const response = await request(
    new Request(`${ORIGIN}/auth/logout`, { method: "POST", headers: { cookie: "lj_session=test-logout-session" } }),
  );
  expect(response.status).toBe(204);
  expect(response.headers.getSetCookie()[0]).toContain("Max-Age=0");
  expect(await db.select().from(sessions).where(eq(sessions.idHash, hash("test-logout-session")))).toEqual([]);
});

test("logout from another website is refused and the session survives", async () => {
  await addSession("test-csrf-session", ALICE, new Date(Date.now() + 60_000));
  const server = startChatPage(0, {} as never);
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/auth/logout`, {
      method: "POST",
      headers: { origin: "https://evil.invalid", cookie: "lj_session=test-csrf-session" },
    });
    expect(response.status).toBe(403);
    expect(await db.select().from(sessions).where(eq(sessions.idHash, hash("test-csrf-session")))).toHaveLength(1);
  } finally {
    server.stop(true);
    await db.delete(sessions).where(eq(sessions.idHash, hash("test-csrf-session")));
  }
});

test("history shows only your games and guesses, and nothing from running games", async () => {
  const [older, newer, other] = known;
  // A language whose name isn't part of the other three, so finding it can only mean a leak.
  const spoiler = known.slice(3).find((clip) => ![older, newer, other].some((shown) => shown!.language.includes(clip.language)));
  await addSession("test-alice-session", ALICE, new Date(Date.now() + 60_000));

  // Alice played two rounds of three; Bob played too.
  const finished = await addGame("finished", new Date("2026-01-01T10:00:00Z"));
  const round1 = await addRound(finished, 1, older!.clipId);
  const round2 = await addRound(finished, 2, newer!.clipId);
  await addRound(finished, 3, other!.clipId);
  await addGuess(round1, ALICE, "test wrong answer", false);
  await addGuess(round1, ALICE, "test right answer", true);
  await addGuess(round1, BOB, "test bob guess", false);
  await addGuess(round2, ALICE, "test second wrong", false);

  // Newer game, stopped.
  const stopped = await addGame("stopped", new Date("2026-02-01T10:00:00Z"));
  await addGuess(await addRound(stopped, 1, newer!.clipId), ALICE, "test stopped guess", false);

  // Alice is in this running game, and its language must stay hidden.
  const running = await addGame("running", new Date("2026-03-01T10:00:00Z"));
  await addGuess(await addRound(running, 1, spoiler!.clipId), ALICE, "test running guess", false);

  // Only Bob played this one.
  const bobs = await addGame("finished", new Date("2026-02-15T10:00:00Z"));
  await addGuess(await addRound(bobs, 1, older!.clipId), BOB, "test bob only guess", true);

  // Asking for Bob in the address changes nothing.
  const response = await request(get(`/api/history?userId=${BOB}&user_id=${BOB}`, "lj_session=test-alice-session"));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const text = await response.clone().text();
  const { games: listed } = (await response.json()) as { games: any[] };

  expect(listed.map((game) => game.status)).toEqual(["stopped", "finished"]);
  expect(listed[0].date).toBe("2026-02-01T10:00:00.000Z");

  const game = listed[1];
  expect(game.correctRounds).toBe(1);
  expect(game.rounds).toEqual([
    {
      number: 1,
      language: older!.language,
      guessed: true,
      correct: true,
      guesses: [
        { text: "test wrong answer", correct: false },
        { text: "test right answer", correct: true },
      ],
    },
    { number: 2, language: newer!.language, guessed: true, correct: false, guesses: [{ text: "test second wrong", correct: false }] },
    { number: 3, language: other!.language, guessed: false, correct: false, guesses: [] },
  ]);

  expect(text).not.toContain(BOB);
  expect(text).not.toContain("test bob");
  expect(text).not.toContain("test running guess");
  expect(text).not.toContain(spoiler!.language);
  for (const clip of known) expect(text).not.toContain(clip.filePath);
  expect(text).not.toContain("userId");
  expect(text).not.toContain("clipId");
});

test("once a running game ends it appears, and a player with no games gets an empty list", async () => {
  await addSession("test-bob-session", BOB, new Date(Date.now() + 60_000));
  await addSession("test-new-session", NEW_USER, new Date(Date.now() + 60_000));

  const listFor = async (session: string) => {
    const response = await request(get("/api/history", `lj_session=${session}`));
    return ((await response.json()) as { games: { status: string; rounds: { language: string }[] }[] }).games;
  };
  expect(await listFor("test-new-session")).toEqual([]);

  const game = await addGame("running", new Date("2026-04-01T10:00:00Z"));
  await addGuess(await addRound(game, 1, known[0]!.clipId), BOB, "test bob running", false);
  const before = (await listFor("test-bob-session")).length;
  await db.update(games).set({ status: "finished" }).where(inArray(games.id, [game]));
  const after = await listFor("test-bob-session");
  expect(after.length).toBe(before + 1);
  expect(after[0]!.rounds[0]!.language).toBe(known[0]!.language);
});
