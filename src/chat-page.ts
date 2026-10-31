import type { Message } from "discord.js";
import allLanguages from "./all-languages.json";
import { handleAdminRequest, isAdminRequest } from "./admin";
import { handleAuthRequest } from "./auth";

type ChatLine = { id: string; channel: string; author: string; text: string; time: number };

// Kept in memory only, so the list starts again each time the bot restarts.
const MAX_LINES = 1000;
const lines = new Map<string, ChatLine>();

export function addMessage(message: Message) {
  const channel = "name" in message.channel && message.channel.name ? message.channel.name : "unknown";
  lines.set(message.id, {
    id: message.id,
    channel,
    author: message.member?.displayName ?? message.author.username,
    text: message.content || (message.attachments.size ? "[attachment]" : "[no text]"),
    time: message.createdTimestamp,
  });
  while (lines.size > MAX_LINES) {
    const oldest = sortedLines()[0];
    if (!oldest) break;
    lines.delete(oldest.id);
  }
}

function sortedLines() {
  return [...lines.values()].sort((a, b) => a.time - b.time);
}

const styles = `<style>
  :root { color-scheme: light dark; --bg: #f6f6f4; --text: #1d1d1b; --muted: #6b6b66; --line: #ddddd8; --accent: #2f7d4f; }
  @media (prefers-color-scheme: dark) { :root { --bg: #1b1c1a; --text: #ecece8; --muted: #a0a09a; --line: #333431; --accent: #6cc48f; } }
  body { margin: 0 auto; max-width: 900px; padding: 16px; background: var(--bg); color: var(--text); font: 16px/1.45 system-ui, sans-serif; }
  h1 { font-size: 1.3rem; margin: 0 0 12px; }
  .line { padding: 8px 0; border-top: 1px solid var(--line); overflow-wrap: anywhere; white-space: pre-wrap; }
  .meta { display: block; font-size: .85rem; color: var(--muted); }
  #empty[hidden] { display: none; }
  .source { margin: 0 0 8px; font-size: .85rem; }
  .channel { color: var(--accent); font-weight: 600; }
  .author { font-weight: 600; color: var(--text); }
  main { padding-bottom: 230px; }
  .row + .row { margin-top: 8px; }
  #voiceChannel { flex: 1 1 200px; min-width: 0; }
  form { position: fixed; left: 0; right: 0; bottom: 0; padding: 12px 16px; background: var(--bg); border-top: 1px solid var(--line); }
  .row { display: flex; flex-wrap: wrap; gap: 8px; max-width: 900px; margin: 0 auto; }
  select, input, button { font: inherit; padding: 8px; color: var(--text); background: transparent; border: 1px solid var(--line); border-radius: 6px; }
  option { color: #1d1d1b; background: #fff; }
  input { flex: 1 1 200px; min-width: 0; }
  button { cursor: pointer; border-color: var(--accent); color: var(--accent); font-weight: 600; }
  #error { max-width: 900px; margin: 0 auto 6px; color: #c0392b; }
  /* Stays at the top while scrolling, because the page jumps down to the newest message. */
  #top { position: sticky; top: 0; z-index: 1; margin-bottom: 12px; padding-bottom: 8px; background: var(--bg); border-bottom: 1px solid var(--line); }
  #account { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding-bottom: 4px; }
  #account [hidden] { display: none; }
  #accountName { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
  .button { padding: 8px; border: 1px solid var(--accent); border-radius: 6px; color: var(--accent); font-weight: 600; text-decoration: none; }
  #top summary { padding: 4px 0; cursor: pointer; color: var(--accent); font-weight: 600; }
  #languageSearch { display: block; width: 100%; box-sizing: border-box; margin-top: 4px; }
  #languageStatus { margin: 6px 0; font-size: .85rem; color: var(--muted); }
  /* A short scrolling list, so the search box and the fixed form both stay in view. */
  #languageList { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 2px 12px; max-height: 30vh; margin: 0; padding: 0; overflow-y: auto; overscroll-behavior: contain; overflow-wrap: anywhere; list-style: none; }
  #languageList[hidden] { display: none; }
  #gamesStatus { margin: 6px 0; font-size: .85rem; color: var(--muted); }
  /* Scrolls by itself, like the language list, so the fixed form can't cover the end of it. */
  #gamesList { max-height: 35vh; overflow-y: auto; overscroll-behavior: contain; overflow-wrap: anywhere; }
  #gamesList[hidden] { display: none; }
  .game { padding: 8px 0; border-top: 1px solid var(--line); }
  .game ol { margin: 4px 0 0; padding: 0; list-style: none; }
  .game li { padding: 2px 0; }
  .game .language { font-weight: 600; }
  .game .right { color: var(--accent); font-weight: 600; }
</style>`;

// The public page: anyone can see the languages and log in to see their own games.
const homePage = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Language Jungle</title>
${styles}
<h1>Language Jungle</h1>
<p class="source"><a href="https://github.com/erkantaylan/Domex" target="_blank" rel="noopener">GitHub</a></p>
<div id="top">
<div id="account">
  <span id="accountName"></span>
  <a id="loginLink" class="button" href="/auth/login" hidden>Log in with Discord</a>
  <button type="button" id="logoutButton" hidden>Log out</button>
</div>
<details id="languages" name="topSections">
  <summary>Languages</summary>
  <input id="languageSearch" type="search" autocomplete="off" placeholder="Search languages" aria-label="Search languages">
  <p id="languageStatus" role="status">Loading...</p>
  <ul id="languageList"></ul>
</details>
<details id="myGames" name="topSections">
  <summary>My games</summary>
  <p id="gamesStatus" role="status">Loading...</p>
  <div id="gamesList" hidden></div>
</details>
</div>
<script>
  function span(className, text) {
    const el = document.createElement("span");
    el.className = className;
    el.textContent = text;
    return el;
  }

  const languageBox = document.getElementById("languages");
  const languageSearch = document.getElementById("languageSearch");
  const languageStatus = document.getElementById("languageStatus");
  const languageList = document.getElementById("languageList");
  let languages = null;

  function showLanguages() {
    if (!languages) return;
    const typed = languageSearch.value.trim();
    const matches = languages.filter((l) => l.name.toLowerCase().includes(typed.toLowerCase()));
    languageList.replaceChildren(...matches.map((l) => {
      const item = document.createElement("li");
      item.textContent = l.name;
      return item;
    }));
    languageList.hidden = matches.length === 0;
    languageStatus.textContent = matches.length
      ? matches.length + " of " + languages.length
      : "0 of " + languages.length + ". No languages match \\"" + typed + "\\".";
  }

  // Fetched the first time the section opens. If that fails, opening it again retries.
  async function loadLanguages() {
    languageStatus.textContent = "Loading...";
    try {
      const response = await fetch("/api/languages");
      if (!response.ok) throw new Error();
      languages = await response.json();
      showLanguages();
    } catch {
      languageStatus.textContent = "Couldn't load the languages. Close this section and open it again to retry.";
    }
  }

  languageBox.addEventListener("toggle", () => {
    if (languageBox.open && !languages) loadLanguages();
  });
  languageSearch.addEventListener("input", showLanguages);

  const accountName = document.getElementById("accountName");
  const loginLink = document.getElementById("loginLink");
  const logoutButton = document.getElementById("logoutButton");
  const gamesBox = document.getElementById("myGames");
  const gamesStatus = document.getElementById("gamesStatus");
  const gamesList = document.getElementById("gamesList");
  const statusNames = { finished: "Finished", stopped: "Stopped", failed: "Ended early" };
  let loggedOutNote = "Loading...";

  function showLoggedOut(loginAvailable) {
    loggedOutNote = loginAvailable ? "Log in to see your games." : "Login isn't set up yet.";
    accountName.textContent = loginAvailable ? "" : loggedOutNote;
    loginLink.hidden = !loginAvailable;
    logoutButton.hidden = true;
    gamesStatus.textContent = loggedOutNote;
    gamesList.hidden = true;
    gamesList.replaceChildren();
  }

  async function loadAccount() {
    try {
      const response = await fetch("/api/me");
      const body = await response.json();
      if (response.status === 401) return showLoggedOut(body.loginAvailable);
      if (!response.ok) throw new Error();
      accountName.textContent = "Logged in as " + body.name;
      loginLink.hidden = true;
      logoutButton.hidden = false;
      if (gamesBox.open) loadGames();
    } catch {
      accountName.textContent = "Couldn't check your login.";
    }
  }

  function roundItem(round) {
    const item = document.createElement("li");
    const result = round.correct ? "Right" : round.guessed ? "Wrong" : "No guess";
    item.append(span("language", "Round " + round.number + ": " + round.language), " · ", span(round.correct ? "right" : "", result));
    for (const guess of round.guesses) {
      item.append(span("meta", "You said: " + guess.text + " (" + (guess.correct ? "right" : "wrong") + ")"));
    }
    return item;
  }

  function gameCard(game) {
    const card = document.createElement("div");
    card.className = "game";
    const rounds = document.createElement("ol");
    rounds.append(...game.rounds.map(roundItem));
    card.append(
      span("meta", new Date(game.date).toLocaleString() + " · " + (statusNames[game.status] ?? game.status)),
      game.correctRounds + " of " + game.rounds.length + " rounds right",
      rounds,
    );
    return card;
  }

  // Fetched each time the section opens, so a game that just ended shows up.
  async function loadGames() {
    gamesStatus.textContent = "Loading...";
    try {
      const response = await fetch("/api/history");
      if (response.status === 401) {
        const body = await response.json();
        return showLoggedOut(body.loginAvailable);
      }
      if (!response.ok) throw new Error();
      const { games } = await response.json();
      gamesList.replaceChildren(...games.map(gameCard));
      gamesList.hidden = games.length === 0;
      gamesStatus.textContent = games.length
        ? games.length + (games.length === 1 ? " game" : " games")
        : "No games yet. A game shows up here once it has ended.";
    } catch {
      gamesStatus.textContent = "Couldn't load your games. Close this section and open it again to retry.";
    }
  }

  gamesBox.addEventListener("toggle", () => {
    if (gamesBox.open && !logoutButton.hidden) loadGames();
  });

  logoutButton.addEventListener("click", async () => {
    logoutButton.disabled = true;
    const response = await fetch("/auth/logout", { method: "POST" }).catch(() => null);
    logoutButton.disabled = false;
    if (response?.ok) showLoggedOut(true);
    else accountName.textContent = "Couldn't log out. Please try again.";
  });

  loadAccount();
</script>
</html>`;

// The admin's testing page: every chat the bot can read, sending as the bot, and voice controls.
// Messages are shown with textContent, so nothing a person types can run as code on the page.
const testingPage = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Testing</title>
${styles}
<h1>Testing</h1>
<p class="source"><a href="https://github.com/erkantaylan/Domex" target="_blank" rel="noopener">GitHub</a></p>
<p><a href="/dashboard">Back to the dashboard</a></p>
<p id="empty" class="meta">Waiting for messages...</p>
<main id="list"></main>
<form id="form">
  <p id="error" hidden></p>
  <div class="row">
    <select id="channel" aria-label="Channel"></select>
    <input id="text" maxlength="2000" autocomplete="off" placeholder="Send a message as the bot" aria-label="Message">
    <button>Send</button>
  </div>
  <div class="row">
    <select id="voiceChannel" aria-label="Voice channel"></select>
    <button type="button" id="voiceButton">Join voice</button>
    <button type="button" id="playButton" disabled>Play a clip</button>
  </div>
</form>
<script>
  const voiceBox = document.getElementById("voiceChannel");
  const voiceButton = document.getElementById("voiceButton");
  const playButton = document.getElementById("playButton");
  let voiceBusy = false;
  let inChannel = null;

  function showError(text) {
    errorBox.textContent = text;
    errorBox.hidden = false;
  }

  async function refreshVoice() {
    if (voiceBusy) return;
    const response = await fetch("/api/voice");
    const voice = await response.json();
    if (voiceBusy) return;
    if (voiceBox.options.length !== voice.channels.length) {
      const selected = voiceBox.value;
      voiceBox.replaceChildren(...voice.channels.map((c) => {
        const option = document.createElement("option");
        option.value = c.id;
        option.textContent = "🔊 " + c.name;
        return option;
      }));
      if (selected) voiceBox.value = selected;
    }
    inChannel = voice.current;
    if (inChannel) voiceBox.value = inChannel;
    voiceBox.disabled = Boolean(inChannel);
    voiceButton.textContent = inChannel ? "Leave voice" : "Join voice";
    voiceButton.disabled = !inChannel && voice.channels.length === 0;
    playButton.disabled = !inChannel;
  }

  playButton.addEventListener("click", async () => {
    playButton.disabled = true;
    errorBox.hidden = true;
    const response = await fetch("/api/voice/play", { method: "POST" }).catch(() => null);
    if (!response?.ok) showError("The bot couldn't play a clip.");
    playButton.disabled = !inChannel;
  });

  voiceButton.addEventListener("click", async () => {
    const leaving = Boolean(inChannel);
    voiceBusy = true;
    voiceButton.disabled = true;
    voiceButton.textContent = leaving ? "Leaving..." : "Joining...";
    errorBox.hidden = true;
    const response = await fetch(leaving ? "/api/voice/leave" : "/api/voice/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channelId: voiceBox.value }),
    }).catch(() => null);
    if (!response?.ok) showError(leaving ? "The bot couldn't leave the channel." : "The bot couldn't join the channel.");
    voiceBusy = false;
    await refreshVoice().catch(() => {});
    voiceButton.disabled = false;
  });

  refreshVoice().catch(() => {});
  setInterval(() => refreshVoice().catch(() => {}), 2000);

  const form = document.getElementById("form");
  const channelBox = document.getElementById("channel");
  const textBox = document.getElementById("text");
  const errorBox = document.getElementById("error");

  async function loadChannels() {
    const response = await fetch("/api/channels");
    for (const c of await response.json()) {
      const option = document.createElement("option");
      option.value = c.id;
      option.textContent = "#" + c.name;
      channelBox.append(option);
    }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = textBox.value.trim();
    if (!text) return;
    errorBox.hidden = true;
    const response = await fetch("/api/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channelId: channelBox.value, text }),
    }).catch(() => null);
    if (response?.ok) {
      textBox.value = "";
    } else {
      errorBox.textContent = "The message wasn't sent. It's still in the box, so you can try again.";
      errorBox.hidden = false;
    }
  });

  loadChannels();

  const list = document.getElementById("list");
  const empty = document.getElementById("empty");
  const seen = new Set();

  function span(className, text) {
    const el = document.createElement("span");
    el.className = className;
    el.textContent = text;
    return el;
  }

  async function refresh() {
    const response = await fetch("/api/messages");
    const messages = await response.json();
    const atBottom = innerHeight + scrollY >= document.body.scrollHeight - 40;
    for (const m of messages) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      const row = document.createElement("div");
      row.className = "line";
      const meta = span("meta", "");
      meta.append(span("channel", "#" + m.channel), " · ", span("author", m.author), " · " + new Date(m.time).toLocaleTimeString());
      row.append(meta, document.createTextNode(m.text));
      list.append(row);
    }
    empty.hidden = seen.size > 0;
    if (atBottom) scrollTo(0, document.body.scrollHeight);
  }

  refresh();
  setInterval(() => refresh().catch(() => {}), 2000);
</script>
</html>`;

export type ChatActions = {
  listChannels: () => Promise<{ id: string; name: string }[]>;
  send: (channelId: string, text: string) => Promise<void>;
  listVoiceChannels: () => Promise<{ id: string; name: string }[]>;
  currentVoiceChannelId: () => string | null;
  joinVoice: (channelId: string) => Promise<void>;
  leaveVoice: () => void;
  playClip: () => Promise<void>;
};

// Other websites open in a browser can try to post here too, so anything that
// changes something must come from our own page, whichever address it's on.
function isFromOurPage(request: Request) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

const ADMIN_ONLY_PATHS = new Set([
  "/api/voice",
  "/api/voice/join",
  "/api/voice/leave",
  "/api/voice/play",
  "/api/send",
  "/api/channels",
  "/api/messages",
]);

export function startChatPage(port: number, actions: ChatActions) {
  // The server itself only listens on this computer. A tunnel can publish it.
  const server = Bun.serve({
    hostname: process.env.HOST ?? "127.0.0.1",
    port,
    // Joining voice can take up to 20 seconds, so don't cut the request off sooner.
    idleTimeout: 30,
    async fetch(request) {
      const { pathname } = new URL(request.url);

      if (request.method === "POST" && !isFromOurPage(request)) {
        return new Response("Forbidden", { status: 403 });
      }

      const adminResponse = await handleAdminRequest(request);
      if (adminResponse) return adminResponse;

      const authResponse = await handleAuthRequest(request);
      if (authResponse) return authResponse;

      if (pathname === "/dashboard/testing" && request.method === "GET") {
        if (!isAdminRequest(request)) return new Response(null, { status: 302, headers: { location: "/dashboard" } });
        return new Response(testingPage, {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        });
      }

      // Reading the chats, posting as the bot and moving it in voice are for the admin only.
      if (ADMIN_ONLY_PATHS.has(pathname) && !isAdminRequest(request)) {
        return Response.json({ error: "Not logged in" }, { status: 401 });
      }

      if (pathname === "/api/voice") {
        return Response.json({
          channels: await actions.listVoiceChannels(),
          current: actions.currentVoiceChannelId(),
        });
      }

      if (pathname === "/api/voice/leave" && request.method === "POST") {
        actions.leaveVoice();
        return new Response(null, { status: 204 });
      }

      if (pathname === "/api/voice/play" && request.method === "POST") {
        try {
          await actions.playClip();
          return new Response(null, { status: 204 });
        } catch (error) {
          console.error("Play failed:", error);
          return new Response("Couldn't play", { status: 502 });
        }
      }

      if (pathname === "/api/voice/join" && request.method === "POST") {
        const body = (await request.json().catch(() => null)) as { channelId?: unknown } | null;
        const voiceChannels = await actions.listVoiceChannels();
        const channelId = body?.channelId;
        if (typeof channelId !== "string" || !voiceChannels.some((channel) => channel.id === channelId)) {
          return new Response("Unknown channel", { status: 400 });
        }
        try {
          await actions.joinVoice(channelId);
          return new Response(null, { status: 204 });
        } catch (error) {
          console.error("Voice join failed:", error);
          return new Response("Couldn't join", { status: 502 });
        }
      }

      if (pathname === "/api/send" && request.method === "POST") {
        const body = (await request.json().catch(() => null)) as { channelId?: unknown; text?: unknown } | null;
        const text = typeof body?.text === "string" ? body.text.trim() : "";
        const channelId = body?.channelId;
        if (!text || text.length > 2000 || typeof channelId !== "string") {
          return new Response("Bad request", { status: 400 });
        }
        const channels = await actions.listChannels();
        if (!channels.some((channel) => channel.id === channelId)) {
          return new Response("Unknown channel", { status: 400 });
        }
        try {
          await actions.send(channelId, text);
          return new Response(null, { status: 204 });
        } catch {
          return new Response("Discord refused the message", { status: 502 });
        }
      }

      // Every language in the clip collection, on purpose not only the ones the game uses:
      // the game keeps those hidden, so this list comes from the data file and not the database.
      if (pathname === "/api/languages" && request.method === "GET") return Response.json(allLanguages);
      if (pathname === "/api/channels") return Response.json(await actions.listChannels());
      if (pathname === "/api/messages") return Response.json(sortedLines());
      if (pathname === "/") return new Response(homePage, { headers: { "content-type": "text/html; charset=utf-8" } });
      return new Response("Not found", { status: 404 });
    },
  });
  console.log(`Chat page: http://127.0.0.1:${server.port}`);
  return server;
}
