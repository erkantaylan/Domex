import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { clips, languages } from "./db/schema";

export const MAX_CLIP_BYTES = 50 * 1024 * 1024;

// Folders in the collection that aren't languages, so they can't be answers in the game.
const NOT_LANGUAGES = new Set(["The apple is red"]);

// Names become folders and files on the server, so they can't be allowed to point anywhere else.
function isSafeName(name: string) {
  return (
    name.length > 0 &&
    name.length <= 150 &&
    name === name.trim() &&
    !name.startsWith(".") &&
    !/[/\\\u0000-\u001f]/.test(name)
  );
}

export function checkClipNames(language: string, fileName: string) {
  if (!isSafeName(language) || !isSafeName(fileName)) return "Bad language or file name";
  if (NOT_LANGUAGES.has(language)) return "That folder isn't a language";
  if (!fileName.toLowerCase().endsWith(".mp3")) return "Only MP3 files can be uploaded";
  return null;
}

// MP3 files start with an ID3 tag or an audio frame.
export function looksLikeMp3(bytes: Uint8Array) {
  const isId3 = bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33;
  const isFrame = bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0;
  return isId3 || isFrame;
}

export async function listClipPaths() {
  const rows = await db.select({ filePath: clips.filePath }).from(clips);
  return rows.map((row) => row.filePath);
}

// Saves the file, then records it, so games can use it right away with no restart.
export async function saveClip(language: string, fileName: string, bytes: Uint8Array) {
  const folder = join("assets", language);
  const filePath = join(folder, fileName);
  const partial = `${filePath}.partial`;

  await mkdir(folder, { recursive: true });
  try {
    await Bun.write(partial, bytes);
    // A file only gets its real name once it's complete, so a dropped upload can't leave half a clip.
    await rename(partial, filePath);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }

  await db.insert(languages).values({ name: language }).onConflictDoNothing();
  const [row] = await db.select().from(languages).where(eq(languages.name, language));
  if (!row) throw new Error("Couldn't save the language");
  await db.insert(clips).values({ languageId: row.id, filePath }).onConflictDoNothing();
}
