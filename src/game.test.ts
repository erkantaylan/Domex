import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { clips, games, guesses, languages, rounds } from "./db/schema";
import { handleGuess, isGameRunning, normalise, startGame, stopGame, type GameTable } from "./game";

// Runs real games against the database with Discord swapped out.
const GUILD = "test-guild";
const CHANNEL = "test-channel";
const createdGames: number[] = [];

afterAll(async () => {
  for (const id of createdGames) await db.delete(games).where(eq(games.id, id));
});

function fakeTable(onPlay: (filePath: string) => void) {
  const said: string[] = [];
  const table: GameTable = {
    guildId: GUILD,
    channelId: CHANNEL,
    startedBy: "starter",
    answerWindowMs: 500,
    say: async (text) => said.push(text),
    join: async () => {},
    play: async (filePath) => onPlay(filePath),
    stopAudio: () => {},
    leave: () => {},
  };
  return { table, said };
}

async function until(check: () => boolean) {
  for (let i = 0; i < 300 && !check(); i++) await Bun.sleep(10);
  expect(check()).toBe(true);
}

async function languageOf(filePath: string) {
  const [row] = await db
    .select({ name: languages.name })
    .from(clips)
    .innerJoin(languages, eq(clips.languageId, languages.id))
    .where(eq(clips.filePath, filePath));
  return row!.name;
}

test("capitals and extra spaces don't matter", () => {
  expect(normalise("  SPANish ")).toBe("spanish");
});

test("a full game saves rounds and guesses and scores the right answer", async () => {
  const played: string[] = [];
  const { table, said } = fakeTable((filePath) => played.push(filePath));
  const id = await startGame(table);
  createdGames.push(id);

  await until(() => played.length === 1);
  await handleGuess(GUILD, "other-channel", "ignored", "nonsense");
  await handleGuess(GUILD, CHANNEL, "wrong-player", "not a language");
  await handleGuess(GUILD, CHANNEL, "right-player", (await languageOf(played[0]!)).toUpperCase());

  await until(() => !isGameRunning(GUILD));

  expect(played.length).toBe(3);
  expect(new Set(await Promise.all(played.map(languageOf))).size).toBe(3);
  expect(said.at(-1)).toContain("<@right-player>: 1");

  const [game] = await db.select().from(games).where(eq(games.id, id));
  expect(game?.status).toBe("finished");
  expect(game?.endedAt).not.toBeNull();

  const savedRounds = await db.select().from(rounds).where(eq(rounds.gameId, id));
  expect(savedRounds.length).toBe(3);

  const saved = await db.select().from(guesses).where(eq(guesses.roundId, savedRounds.find((r) => r.number === 1)!.id));
  expect(saved.map((g) => [g.userId, g.correct]).sort()).toEqual([
    ["right-player", true],
    ["wrong-player", false],
  ]);
});

test("stopping ends the game and a second game can't start during one", async () => {
  const played: string[] = [];
  const { table, said } = fakeTable((filePath) => played.push(filePath));
  table.answerWindowMs = 60_000;
  const id = await startGame(table);
  createdGames.push(id);

  await until(() => played.length === 1);
  await expect(startGame(table)).rejects.toThrow("already running");

  expect(stopGame(GUILD)).toBe(true);
  await until(() => !isGameRunning(GUILD));

  expect(played.length).toBe(1);
  expect(said.at(-1)).toBe("Game stopped.");
  const [game] = await db.select().from(games).where(eq(games.id, id));
  expect(game?.status).toBe("stopped");
});
