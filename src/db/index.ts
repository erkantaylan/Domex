import { drizzle } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is missing in .env. See .env.example for the list.");
}

export const db = drizzle(process.env.DATABASE_URL);

// Brings the database up to date with the files in drizzle/.
export async function runMigrations() {
  await migrate(db, { migrationsFolder: "drizzle" });
}
