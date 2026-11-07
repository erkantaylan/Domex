import { sql } from "drizzle-orm";
import { boolean, check, integer, pgEnum, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

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
// Easy mode answers with buttons, normal mode by typing. Kept on the game so leaderboards can be split by it.
export const difficulty = pgEnum("difficulty", ["easy", "normal"]);

export const games = pgTable("games", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  channelId: text("channel_id").notNull(),
  startedBy: text("started_by").notNull(),
  status: gameStatus("status").notNull().default("running"),
  difficulty: difficulty("difficulty").notNull().default("normal"),
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
    // The 5 buttons of an easy round, in the order shown. Null in normal mode.
    // A column, not a table: the options are always read with their round, never on their own.
    options: text("options").array(),
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

// A website login. The id itself lives only in the player's cookie: a stolen copy of this table can't log anyone in.
export const sessions = pgTable("sessions", {
  idHash: text("id_hash").primaryKey(),
  userId: text("user_id").notNull(),
  displayName: text("display_name").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const answersOpen = pgEnum("answers_open", ["during", "after"]);
export const timerStart = pgEnum("timer_start", ["answers-open", "clip-end"]);

// The game timings set on the dashboard. The check keeps this table to one row.
export const gameSettings = pgTable(
  "game_settings",
  {
    id: integer("id").primaryKey().default(1),
    countdownSeconds: integer("countdown_seconds").notNull().default(5),
    answersOpen: answersOpen("answers_open").notNull().default("during"),
    answerSeconds: integer("answer_seconds").notNull().default(30),
    timerStart: timerStart("timer_start").notNull().default("answers-open"),
  },
  (table) => [check("game_settings_single_row", sql`${table.id} = 1`)],
);

// A key the admin makes on the dashboard so an agent can use the admin API.
// Only the hash is kept: the token itself is shown once, when it's made.
export const adminTokens = pgTable("admin_tokens", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});
