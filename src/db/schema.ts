import { boolean, integer, pgEnum, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const languages = pgTable("languages", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
});

// The audio stays as files. The database only records where each clip is.
export const clips = pgTable("clips", {
  id: serial("id").primaryKey(),
  languageId: integer("language_id")
    .notNull()
    .references(() => languages.id),
  filePath: text("file_path").notNull().unique(),
});

export const gameStatus = pgEnum("game_status", ["running", "finished", "stopped", "failed"]);

export const games = pgTable("games", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  channelId: text("channel_id").notNull(),
  startedBy: text("started_by").notNull(),
  status: gameStatus("status").notNull().default("running"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
});

export const rounds = pgTable(
  "rounds",
  {
    id: serial("id").primaryKey(),
    gameId: integer("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "cascade" }),
    clipId: integer("clip_id")
      .notNull()
      .references(() => clips.id),
    number: integer("number").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("rounds_game_number").on(table.gameId, table.number)],
);

export const guesses = pgTable("guesses", {
  id: serial("id").primaryKey(),
  roundId: integer("round_id")
    .notNull()
    .references(() => rounds.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  text: text("text").notNull(),
  correct: boolean("correct").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
