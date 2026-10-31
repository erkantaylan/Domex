import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gt, lte } from "drizzle-orm";
import { db } from "./db";
import { sessions } from "./db/schema";
import { getHistory } from "./history";

const DISCORD_API = "https://discord.com/api/v10";
const STATE_COOKIE = "lj_login_state";
const SESSION_COOKIE = "lj_session";
const STATE_SECONDS = 10 * 60;
const SESSION_SECONDS = 7 * 24 * 60 * 60;

export type AuthSettings = {
  clientId: string;
  clientSecret: string;
  publicOrigin: string;
  secure: boolean;
  // False when a setting is missing. The bot and the page still run, only login is off.
  ready: boolean;
};

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export function readAuthSettings(): AuthSettings {
  const clientId = process.env.DISCORD_CLIENT_ID ?? "";
  const clientSecret = process.env.DISCORD_CLIENT_SECRET ?? "";
  let publicUrl: URL | null = null;
  try {
    publicUrl = new URL(process.env.PUBLIC_URL ?? "");
  } catch {}
  const web = publicUrl?.protocol === "https:" || publicUrl?.protocol === "http:";
  return {
    clientId,
    clientSecret,
    publicOrigin: web ? publicUrl!.origin : "",
    secure: publicUrl?.protocol === "https:",
    ready: Boolean(clientId && clientSecret && web),
  };
}

function readCookie(request: Request, name: string) {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, value] = part.trim().split("=");
    if (key === name) return value || null;
  }
  return null;
}

function cookie(name: string, value: string, maxAge: number, path: string, secure: boolean) {
  return `${name}=${value}; Max-Age=${maxAge}; Path=${path}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

function hashOf(sessionId: string) {
  return createHash("sha256").update(sessionId).digest("hex");
}

function sameText(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function redirect(location: string, cookies: string[] = []) {
  const headers = new Headers({ location, "cache-control": "no-store" });
  for (const value of cookies) headers.append("set-cookie", value);
  return new Response(null, { status: 302, headers });
}

function messagePage(status: number, message: string, cookies: string[] = []) {
  const headers = new Headers({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  for (const value of cookies) headers.append("set-cookie", value);
  // Only fixed sentences from this file ever go in here, never anything from the request.
  const body = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Login</title><p>${message}</p><p><a href="/">Back to the page</a></p>`;
  return new Response(body, { status, headers });
}

function privateJson(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}

function login(settings: AuthSettings) {
  const state = randomBytes(32).toString("base64url");
  const authorize = new URL("https://discord.com/oauth2/authorize");
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: settings.clientId,
    scope: "identify",
    state,
    redirect_uri: `${settings.publicOrigin}/auth/callback`,
  }).toString();
  return redirect(authorize.toString(), [cookie(STATE_COOKIE, state, STATE_SECONDS, "/auth", settings.secure)]);
}

// Trades the one-time code for who this person is. Discord's token is used once and then forgotten.
// Logs say only which step failed: errors and bodies here could hold the code or a token.
async function askDiscordWhoItIs(code: string, settings: AuthSettings, fetcher: Fetcher) {
  let step = "token request";
  try {
    const tokenResponse = await fetcher(`${DISCORD_API}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: settings.clientId,
        client_secret: settings.clientSecret,
        redirect_uri: `${settings.publicOrigin}/auth/callback`,
      }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!tokenResponse.ok) throw new Error();
    const { access_token: accessToken } = (await tokenResponse.json()) as { access_token?: unknown };
    if (typeof accessToken !== "string") throw new Error();

    step = "user request";
    const userResponse = await fetcher(`${DISCORD_API}/users/@me`, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!userResponse.ok) throw new Error();
    const user = (await userResponse.json()) as { id?: unknown; username?: unknown; global_name?: unknown };
    const name = user.global_name || user.username;
    if (typeof user.id !== "string" || typeof name !== "string") throw new Error();
    return { id: user.id, name };
  } catch {
    console.error(`Discord login failed at the ${step}.`);
    return null;
  }
}

async function callback(request: Request, settings: AuthSettings, fetcher: Fetcher) {
  const clearState = cookie(STATE_COOKIE, "", 0, "/auth", settings.secure);
  const params = new URL(request.url).searchParams;
  const expected = readCookie(request, STATE_COOKIE);
  const state = params.get("state");
  if (!expected || !state || !sameText(expected, state)) {
    return messagePage(400, "That login link wasn't valid or has expired. Please try again.", [clearState]);
  }

  // The player pressed Cancel on Discord's page.
  if (params.has("error")) return redirect("/", [clearState]);

  const code = params.get("code");
  if (!code) return messagePage(400, "Discord didn't finish the login. Please try again.", [clearState]);

  const user = await askDiscordWhoItIs(code, settings, fetcher);
  if (!user) return messagePage(502, "Discord couldn't confirm the login. Please try again.", [clearState]);

  await db.delete(sessions).where(lte(sessions.expiresAt, new Date()));
  const sessionId = randomBytes(32).toString("base64url");
  await db.insert(sessions).values({
    idHash: hashOf(sessionId),
    userId: user.id,
    displayName: user.name,
    expiresAt: new Date(Date.now() + SESSION_SECONDS * 1000),
  });
  return redirect("/", [clearState, cookie(SESSION_COOKIE, sessionId, SESSION_SECONDS, "/", settings.secure)]);
}

async function currentUser(request: Request) {
  const sessionId = readCookie(request, SESSION_COOKIE);
  if (!sessionId) return null;
  const [session] = await db
    .select({ id: sessions.userId, name: sessions.displayName })
    .from(sessions)
    .where(and(eq(sessions.idHash, hashOf(sessionId)), gt(sessions.expiresAt, new Date())));
  return session ?? null;
}

async function route(request: Request, settings: AuthSettings, fetcher: Fetcher) {
  const url = new URL(request.url);
  const { pathname } = url;
  const { method } = request;

  if (pathname === "/auth/login" && method === "GET") {
    if (!settings.ready) return messagePage(503, "Login isn't set up yet.");
    // The state cookie has to land on the address Discord will send the player back to.
    if (url.origin !== settings.publicOrigin) return redirect(`${settings.publicOrigin}/auth/login`);
    return login(settings);
  }

  if (pathname === "/auth/callback" && method === "GET") {
    if (!settings.ready) return messagePage(503, "Login isn't set up yet.");
    return callback(request, settings, fetcher);
  }

  // The caller has already checked that this POST came from our own page.
  if (pathname === "/auth/logout" && method === "POST") {
    const sessionId = readCookie(request, SESSION_COOKIE);
    if (sessionId) await db.delete(sessions).where(eq(sessions.idHash, hashOf(sessionId)));
    const headers = new Headers({ "cache-control": "no-store" });
    headers.append("set-cookie", cookie(SESSION_COOKIE, "", 0, "/", settings.secure));
    return new Response(null, { status: 204, headers });
  }

  if ((pathname === "/api/me" || pathname === "/api/history") && method === "GET") {
    const user = await currentUser(request);
    if (!user) return privateJson({ error: "Not logged in", loginAvailable: settings.ready }, 401);
    if (pathname === "/api/me") return privateJson(user);
    // Whose games comes only from the session, never from anything in the request.
    return privateJson({ games: await getHistory(user.id) });
  }

  return null;
}

// Answers the login and history addresses, or returns null if the request is for something else.
export async function handleAuthRequest(
  request: Request,
  settings: AuthSettings = readAuthSettings(),
  fetcher: Fetcher = fetch,
) {
  try {
    return await route(request, settings, fetcher);
  } catch {
    // No error details: a database error message includes the values in the query.
    console.error("A login or history request failed.");
    return new Response("Something went wrong", { status: 500 });
  }
}
