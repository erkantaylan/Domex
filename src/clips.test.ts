import { afterAll, beforeAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { startChatPage, type ChatActions } from "./chat-page";
import { checkClipNames, looksLikeMp3 } from "./clips";
import { db, runMigrations } from "./db";
import { clips, languages } from "./db/schema";

const LANGUAGE = "Zz Upload Test";
const mp3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]);
const actions = {} as ChatActions;
const saved = { username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD };
let server: ReturnType<typeof startChatPage>;
let base = "";
let cookie = "";

const upload = (language: string, name: string, body: Uint8Array, withCookie = cookie) =>
  fetch(`${base}/api/admin/clips?language=${encodeURIComponent(language)}&name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { origin: base, cookie: withCookie },
    body,
  });

beforeAll(async () => {
  await runMigrations();
  process.env.ADMIN_USERNAME = "test-admin";
  process.env.ADMIN_PASSWORD = "test-password";
  server = startChatPage(0, actions);
  base = `http://127.0.0.1:${server.port}`;
  const login = await fetch(base + "/dashboard/login", {
    method: "POST",
    headers: { origin: base, "content-type": "application/json" },
    body: JSON.stringify({ username: "test-admin", password: "test-password" }),
  });
  cookie = login.headers.get("set-cookie")!.split(";")[0]!;
});

afterAll(async () => {
  server.stop(true);
  process.env.ADMIN_USERNAME = saved.username;
  process.env.ADMIN_PASSWORD = saved.password;
  await rm(`assets/${LANGUAGE}`, { recursive: true, force: true });
  const [row] = await db.select().from(languages).where(eq(languages.name, LANGUAGE));
  if (row) {
    await db.delete(clips).where(eq(clips.languageId, row.id));
    await db.delete(languages).where(eq(languages.id, row.id));
  }
});

test("names that could point outside the clips folder are refused", () => {
  for (const [language, name] of [
    ["..", "a.mp3"],
    ["../etc", "a.mp3"],
    ["Spanish", "../a.mp3"],
    ["Spanish", "..\\a.mp3"],
    ["Spanish", ".hidden.mp3"],
    ["", "a.mp3"],
    ["Spanish", "a.exe"],
    ["The apple is red", "a.mp3"],
  ]) {
    expect(checkClipNames(language!, name!)).not.toBeNull();
  }
  expect(checkClipNames("Old Church Slavonic", "Clip_1.mp3")).toBeNull();
});

test("only MP3 content counts as an MP3", () => {
  expect(looksLikeMp3(mp3)).toBe(true);
  expect(looksLikeMp3(new Uint8Array([0xff, 0xfb, 0x90]))).toBe(true);
  expect(looksLikeMp3(new TextEncoder().encode("<html>"))).toBe(false);
});

test("uploading needs the admin login", async () => {
  expect((await upload(LANGUAGE, "a.mp3", mp3, "")).status).toBe(401);
  expect((await fetch(base + "/api/admin/clips")).status).toBe(401);
  expect(await Bun.file(`assets/${LANGUAGE}/a.mp3`).exists()).toBe(false);
});

test("an upload is saved and recorded, and can safely be repeated", async () => {
  expect((await upload(LANGUAGE, "a.mp3", mp3)).status).toBe(204);
  expect((await upload(LANGUAGE, "a.mp3", mp3)).status).toBe(204);
  expect(await Bun.file(`assets/${LANGUAGE}/a.mp3`).exists()).toBe(true);
  expect(await Bun.file(`assets/${LANGUAGE}/a.mp3.partial`).exists()).toBe(false);

  const response = await fetch(base + "/api/admin/clips", { headers: { cookie } });
  const { paths } = (await response.json()) as { paths: string[] };
  expect(paths.filter((path) => path === `assets/${LANGUAGE}/a.mp3`).length).toBe(1);
});

test("bad uploads are refused and leave nothing behind", async () => {
  expect((await upload(LANGUAGE, "../../evil.mp3", mp3)).status).toBe(400);
  expect((await upload(LANGUAGE, "b.mp3", new TextEncoder().encode("<html>"))).status).toBe(400);
  expect(await Bun.file(`assets/${LANGUAGE}/b.mp3`).exists()).toBe(false);
  expect(await Bun.file("evil.mp3").exists()).toBe(false);
});
