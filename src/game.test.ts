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
    countdownMs: 10,
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

// The game frees its place just before saving its final status, so give the save a moment.
async function finalStatus(id: number) {
  for (let i = 0; i < 100; i++) {
    const [game] = await db.select().from(games).where(eq(games.id, id));
    if (game?.status !== "running") return game?.status;
    await Bun.sleep(10);
  }
  return "running";
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

test("a countdown comes before every round's clip", async () => {
  const { table, said } = fakeTable(() => said.push("(clip)"));
  table.countdownMs = 100;
  table.answerWindowMs = 10;
  const playedAt: number[] = [];
  const countdownAt: number[] = [];
  const say = table.say;
  table.say = async (text) => {
    if (text.includes("starts in")) countdownAt.push(Date.now());
    return say(text);
  };
  const play = table.play;
  table.play = async (filePath) => {
    playedAt.push(Date.now());
    return play(filePath);
  };
  createdGames.push(await startGame(table));

  await until(() => !isGameRunning(GUILD));

  const steps = said.filter((text) => text.includes("starts in") || text === "Listen!" || text === "(clip)");
  expect(steps).toEqual(
    [1, 2, 3].flatMap((round) => [`Round ${round} of 3 starts in 5 seconds...`, "Listen!", "(clip)"]),
  );
  // Timers can fire a hair early, so allow a little slack.
  playedAt.forEach((time, i) => expect(time - countdownAt[i]!).toBeGreaterThanOrEqual(95));
});

test("guesses during a countdown aren't saved or scored", async () => {
  const played: string[] = [];
  const { table, said } = fakeTable((filePath) => played.push(filePath));
  table.countdownMs = 200;
  table.answerWindowMs = 10;
  const id = await startGame(table);
  createdGames.push(id);

  // The clip isn't known yet, so try every language: one of them is the right answer.
  const everyLanguage = await db.select({ name: languages.name }).from(languages);
  const guessEverything = () =>
    Promise.all(everyLanguage.map(({ name }) => handleGuess(GUILD, CHANNEL, "too-early", name)));

  await until(() => said.includes("Round 1 of 3 starts in 5 seconds..."));
  await guessEverything();
  expect(played.length).toBe(0);

  await until(() => said.includes("Round 2 of 3 starts in 5 seconds..."));
  await guessEverything();
  expect(played.length).toBe(1);

  await until(() => !isGameRunning(GUILD));

  expect(played.length).toBe(3);
  expect(said.at(-1)).toContain("Nobody got one right");
  const saved = await db
    .select({ id: guesses.id })
    .from(guesses)
    .innerJoin(rounds, eq(guesses.roundId, rounds.id))
    .where(eq(rounds.gameId, id));
  expect(saved.length).toBe(0);
});

test("stopping during the first countdown ends the game promptly with no clip", async () => {
  const played: string[] = [];
  const { table, said } = fakeTable((filePath) => played.push(filePath));
  // The real 5 seconds: the game can only end in time if the stop cuts the wait short.
  table.countdownMs = undefined;
  const id = await startGame(table);
  createdGames.push(id);

  await until(() => said.includes("Round 1 of 3 starts in 5 seconds..."));
  await Bun.sleep(100);
  expect(played.length).toBe(0);

  const stoppedAt = Date.now();
  expect(stopGame(GUILD)).toBe(true);
  await until(() => !isGameRunning(GUILD));
  expect(Date.now() - stoppedAt).toBeLessThan(500);

  expect(played.length).toBe(0);
  expect(said.at(-1)).toBe("Game stopped.");
  expect(await finalStatus(id)).toBe("stopped");
  expect((await db.select().from(rounds).where(eq(rounds.gameId, id))).length).toBe(0);
});

test("stopping during a countdown between rounds ends the game with no new clip", async () => {
  const played: string[] = [];
  const { table, said } = fakeTable((filePath) => {
    played.push(filePath);
    table.countdownMs = 60_000;
  });
  table.answerWindowMs = 10;
  const id = await startGame(table);
  createdGames.push(id);

  await until(() => said.includes("Round 2 of 3 starts in 5 seconds..."));
  const stoppedAt = Date.now();
  expect(stopGame(GUILD)).toBe(true);
  await until(() => !isGameRunning(GUILD));
  expect(Date.now() - stoppedAt).toBeLessThan(500);

  expect(played.length).toBe(1);
  expect(said.at(-1)).toBe("Game stopped.");
  expect(await finalStatus(id)).toBe("stopped");
  expect((await db.select().from(rounds).where(eq(rounds.gameId, id))).length).toBe(1);
});
