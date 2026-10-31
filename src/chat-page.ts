import type { Message } from "discord.js";

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

// Messages are shown with textContent, so nothing a person types can run as code on the page.
const page = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Server Chats</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f6f4; --text: #1d1d1b; --muted: #6b6b66; --line: #ddddd8; --accent: #2f7d4f; }
  @media (prefers-color-scheme: dark) { :root { --bg: #1b1c1a; --text: #ecece8; --muted: #a0a09a; --line: #333431; --accent: #6cc48f; } }
  body { margin: 0 auto; max-width: 900px; padding: 16px; background: var(--bg); color: var(--text); font: 16px/1.45 system-ui, sans-serif; }
  h1 { font-size: 1.3rem; margin: 0 0 12px; }
  .line { padding: 8px 0; border-top: 1px solid var(--line); overflow-wrap: anywhere; white-space: pre-wrap; }
  .meta { display: block; font-size: .85rem; color: var(--muted); }
  .channel { color: var(--accent); font-weight: 600; }
  .author { font-weight: 600; color: var(--text); }
  main { padding-bottom: 96px; }
  form { position: fixed; left: 0; right: 0; bottom: 0; padding: 12px 16px; background: var(--bg); border-top: 1px solid var(--line); }
  .row { display: flex; flex-wrap: wrap; gap: 8px; max-width: 900px; margin: 0 auto; }
  select, input, button { font: inherit; padding: 8px; color: var(--text); background: transparent; border: 1px solid var(--line); border-radius: 6px; }
  option { color: #1d1d1b; background: #fff; }
  input { flex: 1 1 200px; min-width: 0; }
  button { cursor: pointer; border-color: var(--accent); color: var(--accent); font-weight: 600; }
  #error { max-width: 900px; margin: 0 auto 6px; color: #c0392b; }
</style>
<h1>Server Chats</h1>
<p id="empty" class="meta">Waiting for messages...</p>
<main id="list"></main>
<form id="form">
  <p id="error" hidden></p>
  <div class="row">
    <select id="channel" aria-label="Channel"></select>
    <input id="text" maxlength="2000" autocomplete="off" placeholder="Send a message as the bot" aria-label="Message">
    <button>Send</button>
  </div>
</form>
<script>
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
};

export function startChatPage(port: number, actions: ChatActions) {
  // The server itself only listens on this computer. A tunnel can publish it.
  Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(request) {
      const { pathname } = new URL(request.url);

      if (pathname === "/api/send" && request.method === "POST") {
        // Other websites open in a browser can try to post here too, so
        // sending must come from our own page, whichever address it's on.
        const origin = request.headers.get("origin");
        const host = request.headers.get("host");
        if (!origin || !host || new URL(origin).host !== host) {
          return new Response("Forbidden", { status: 403 });
        }
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

      if (pathname === "/api/channels") return Response.json(await actions.listChannels());
      if (pathname === "/api/messages") return Response.json(sortedLines());
      if (pathname === "/") return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
      return new Response("Not found", { status: 404 });
    },
  });
  console.log(`Chat page: http://127.0.0.1:${port}`);
}
