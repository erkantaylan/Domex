import { afterAll, beforeAll, expect, test } from "bun:test";
import { startChatPage, type ChatActions } from "./chat-page";

// The chat and voice controls are for the admin only, with Discord swapped out here.
const calls: string[] = [];
const actions: ChatActions = {
  listChannels: async () => [{ id: "c1", name: "general" }],
  send: async () => void calls.push("send"),
  listVoiceChannels: async () => [{ id: "v1", name: "voice" }],
  currentVoiceChannelId: () => null,
  joinVoice: async () => void calls.push("join"),
  leaveVoice: () => void calls.push("leave"),
  playClip: async () => void calls.push("play"),
};

const saved = { username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD };
let server: ReturnType<typeof startChatPage>;
let base = "";

const post = (path: string, body: unknown, cookie = "") =>
  fetch(base + path, {
    method: "POST",
    redirect: "manual",
    headers: { origin: base, "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });

beforeAll(() => {
  process.env.ADMIN_USERNAME = "test-admin";
  process.env.ADMIN_PASSWORD = "test-password";
  server = startChatPage(0, actions);
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  process.env.ADMIN_USERNAME = saved.username;
  process.env.ADMIN_PASSWORD = saved.password;
});

test("the public page has no chat or voice controls, and still has the languages", async () => {
  const page = await (await fetch(base + "/")).text();
  expect(page).toContain("languageSearch");
  expect(page).toContain("Log in with Discord");
  for (const hidden of ["Send a message", "voiceButton", "/api/messages", "/api/send", "/api/voice"]) {
    expect(page).not.toContain(hidden);
  }
  expect((await fetch(base + "/api/languages")).status).toBe(200);
});

test("logged out, nothing from the testing page is reachable", async () => {
  const page = await fetch(base + "/dashboard/testing", { redirect: "manual" });
  expect(page.status).toBe(302);
  expect(page.headers.get("location")).toBe("/dashboard");
  expect(await page.text()).not.toContain("Send a message");

  for (const path of ["/api/messages", "/api/channels", "/api/voice"]) {
    expect((await fetch(base + path)).status).toBe(401);
  }
  const body = { channelId: "c1", text: "hello" };
  for (const path of ["/api/send", "/api/voice/join", "/api/voice/leave", "/api/voice/play"]) {
    expect((await post(path, body)).status).toBe(401);
  }
  expect(calls).toEqual([]);
});

test("a Discord login cookie doesn't open the testing page", async () => {
  const cookie = "lj_session=not-an-admin; session=not-an-admin";
  expect((await fetch(base + "/api/messages", { headers: { cookie } })).status).toBe(401);
});

test("logged in as admin, the testing page and its controls work", async () => {
  const login = await post("/dashboard/login", { username: "test-admin", password: "test-password" });
  expect(login.status).toBe(204);
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;

  const page = await fetch(base + "/dashboard/testing", { headers: { cookie } });
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("Send a message");

  expect((await fetch(base + "/api/messages", { headers: { cookie } })).status).toBe(200);
  expect((await post("/api/send", { channelId: "c1", text: "hello" }, cookie)).status).toBe(204);
  expect((await post("/api/voice/play", {}, cookie)).status).toBe(204);
  expect(calls).toEqual(["send", "play"]);
});
