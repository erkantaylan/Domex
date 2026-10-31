// Records every clip in assets/<Language>/ in the database.
// Safe to run again: clips it already knows are left alone.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { count, eq } from "drizzle-orm";
import { clips, languages } from "../src/db/schema";
import { db, runMigrations } from "../src/db";

await runMigrations();

const folders = await readdir("assets", { withFileTypes: true });
for (const folder of folders.filter((entry) => entry.isDirectory())) {
  await db.insert(languages).values({ name: folder.name }).onConflictDoNothing();
  const [language] = await db.select().from(languages).where(eq(languages.name, folder.name));
  if (!language) throw new Error(`Couldn't save language ${folder.name}`);

  const files = (await readdir(join("assets", folder.name))).filter((name) => name.endsWith(".mp3"));
  for (const file of files) {
    await db
      .insert(clips)
      .values({ languageId: language.id, filePath: join("assets", folder.name, file) })
      .onConflictDoNothing();
  }
}

const [languageTotal] = await db.select({ total: count() }).from(languages);
const [clipTotal] = await db.select({ total: count() }).from(clips);
console.log(`Languages: ${languageTotal?.total}, clips: ${clipTotal?.total}`);
process.exit(0);
