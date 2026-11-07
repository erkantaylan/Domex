import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, runMigrations } from "./db";
import { clips, games, guesses, languages, rounds } from "./db/schema";
import {
  NOT_A_PLAYER,
  handleEasyPick,
  handleGuess,
  isGameRunning,
  startGame,
  stopGame,
  type EasyTable,
  type GameTable,
} from "./game";
import { DEFAULT_SETTINGS, saveSettings, type GameSettings } from "./settings";

// Easy games against the real database, with Discord's buttons swapped for a fake.
const GUILD = "easy-test-guild";
const CHANNEL = "easy-test-channel";
const createdGames: number[] = [];

beforeAll(async () => {
  await runMigrations();
  await saveSettings(DEFAULT_SETTINGS);
});

afterEach(async () => {
  if (isGameRunning(GUILD)) {
    stopGame(GUILD);
    for (let i = 0; i < 100 && isGameRunning(GUILD); i++) await Bun.sleep(10);
  }
  await saveSettings(DEFAULT_SETTINGS);
});

afterAll(async () => {
  for (const id of createdGames) await db.delete(games).where(eq(games.id, id));
  await saveSettings(DEFAULT_SETTINGS);
});

type Shown = { roundId: number; options: string[]; total: number };

// A table with a clip that plays until the test ends it, and buttons that only record what happens to them.
function easyGame(players: string[]) {
  const said: string[] = [];
  const clip = { played: [] as string[], end: () => {} };
  const inVoice = new Set(players);
  const shown: Shown[] = [];
  const edits: string[] = [];
  const easy: EasyTable = {
    players,
    inVoice: (userId) => inVoice.has(userId),
    showOptions: async (roundId, options, total) => {
      shown.push({ roundId, options, total });
      return {
        showPicked: async (picked, of) => edits.push(`${picked}/${of} picked`),
        close: async (rightIndex) => edits.push(`closed ${options[rightIndex]}`),
      };
    },
  };
  const table: GameTable = {
    guildId: GUILD,
    channelId: CHANNEL,
    startedBy: "starter",
    answerWindowMs: 60_000,
    countdownMs: 10,
    say: async (text) => said.push(text),
    join: async () => {},
    play: (filePath) => {
      clip.played.push(filePath);
      return new Promise<void>((resolve) => {
        clip.end = resolve;
      });
    },
    stopAudio: () => clip.end(),
    leave: () => {},
    easy,
  };
  return { table, said, clip, inVoice, shown, edits };
}

async function until(check: () => boolean) {
  for (let i = 0; i < 300 && !check(); i++) await Bun.sleep(10);
  expect(check()).toBe(true);
}

async function start(table: GameTable, settings: Partial<GameSettings> = {}) {
  await saveSettings({ ...DEFAULT_SETTINGS, ...settings });
  const id = await startGame(table);
  createdGames.push(id);
  return id;
}

async function languageOf(filePath: string) {
  const [row] = await db
    .select({ name: languages.name })
    .from(clips)
    .innerJoin(languages, eq(clips.languageId, languages.id))
    .where(eq(clips.filePath, filePath));
  return row!.name;
}

async function savedGuesses(gameId: number) {
  return db
    .select({ userId: guesses.userId, text: guesses.text, correct: guesses.correct })
    .from(guesses)
    .innerJoin(rounds, eq(guesses.roundId, rounds.id))
    .where(eq(rounds.gameId, gameId));
}

// The index of the right button, and of one wrong one.
async function buttons(shown: Shown, filePath: string) {
  const right = shown.options.indexOf(await languageOf(filePath));
  const wrong = right === 0 ? 1 : 0;
  return { right, wrong };
}

test("an easy round shows 5 different options with the right one among them, and saves them in order", async () => {
  const { table, clip, shown } = easyGame(["ana", "ben", "cy"]);
  const id = await start(table);

  await until(() => shown.length === 1);
  const { roundId, options, total } = shown[0]!;
  expect(options.length).toBe(5);
  expect(new Set(options).size).toBe(5);
  expect(options).toContain(await languageOf(clip.played[0]!));
  expect(total).toBe(3);

  const [round] = await db.select().from(rounds).where(eq(rounds.id, roundId));
  expect(round?.gameId).toBe(id);
  expect(round?.options).toEqual(options);
  const [game] = await db.select().from(games).where(eq(games.id, id));
  expect(game?.difficulty).toBe("easy");
});

test("a click from someone not on the list, or not in voice, is refused and not saved", async () => {
  const { table, clip, shown, inVoice, edits } = easyGame(["ana", "ben"]);
  const id = await start(table);
  await until(() => shown.length === 1);
  const { right } = await buttons(shown[0]!, clip.played[0]!);
  const roundId = shown[0]!.roundId;

  expect(await handleEasyPick(GUILD, roundId, right, "stranger")).toBe(NOT_A_PLAYER);
  inVoice.delete("ana");
  expect(await handleEasyPick(GUILD, roundId, right, "ana")).toBe(NOT_A_PLAYER);
  expect(await savedGuesses(id)).toEqual([]);
  expect(edits).toEqual([]);

  // A player who comes back can play again.
  inVoice.add("ana");
  expect(await handleEasyPick(GUILD, roundId, right, "ana")).toStartWith("You picked ");
  expect(await savedGuesses(id)).toEqual([{ userId: "ana", text: shown[0]!.options[right]!, correct: true }]);
});

test("each player picks once per round, even with a quick double click, and the count goes up", async () => {
  const { table, clip, shown, edits } = easyGame(["ana", "ben", "cy"]);
  const id = await start(table);
  await until(() => shown.length === 1);
  const { right, wrong } = await buttons(shown[0]!, clip.played[0]!);
  const { roundId, options } = shown[0]!;

  const replies = await Promise.all([
    handleEasyPick(GUILD, roundId, wrong, "ana"),
    handleEasyPick(GUILD, roundId, right, "ana"),
  ]);
  expect(replies).toEqual([`You picked ${options[wrong]}.`, "You already picked."]);
  expect(await handleEasyPick(GUILD, roundId, right, "ben")).toBe(`You picked ${options[right]}.`);
  expect(await handleEasyPick(GUILD, roundId, right, "ben")).toBe("You already picked.");

  await until(() => edits.length === 2);
  expect(edits).toEqual(["1/3 picked", "2/3 picked"]);
  expect(isGameRunning(GUILD)).toBe(true);
  expect(await savedGuesses(id)).toEqual([
    { userId: "ana", text: options[wrong]!, correct: false },
    { userId: "ben", text: options[right]!, correct: true },
  ]);
});

test("the round ends early when everyone has picked, then the buttons switch off and the winners are named", async () => {
  const { table, said, clip, shown, edits } = easyGame(["ana", "ben"]);
  await start(table);
  await until(() => shown.length === 1);
  const { right, wrong } = await buttons(shown[0]!, clip.played[0]!);
  const { roundId, options } = shown[0]!;
  const language = options[right]!;

  await handleEasyPick(GUILD, roundId, right, "ana");
  await handleEasyPick(GUILD, roundId, wrong, "ben");

  // The answer time is a minute, so only everyone picking can have ended the round.
  await until(() => said.some((text) => text.startsWith("Everyone picked!")));
  expect(said).toContain(`Everyone picked! It was ${language}. <@ana> got it!`);
  expect(edits).toEqual(["1/2 picked", "2/2 picked", `closed ${language}`]);
  expect(await handleEasyPick(GUILD, roundId, right, "ana")).toBe("This round is over.");
  await until(() => clip.played.length === 2);
});

test("otherwise the round ends on the timer, and a click on an old round's button is turned away", async () => {
  const { table, said, clip, shown, edits } = easyGame(["ana", "ben"]);
  table.answerWindowMs = 100;
  await start(table);
  await until(() => shown.length === 1);
  const { right } = await buttons(shown[0]!, clip.played[0]!);
  const language = shown[0]!.options[right]!;
  await handleEasyPick(GUILD, shown[0]!.roundId, right, "ben");

  await until(() => said.some((text) => text.startsWith("Time's up!")));
  expect(said).toContain(`Time's up! It was ${language}. <@ben> got it!`);
  expect(edits).toEqual(["1/2 picked", `closed ${language}`]);

  await until(() => shown.length === 2);
  expect(await handleEasyPick(GUILD, shown[0]!.roundId, right, "ana")).toBe("This round is over.");
  expect(await handleEasyPick(GUILD, shown[1]!.roundId, 9, "ana")).toBe("This round is over.");
});

test("a round where nobody picks the right one says so", async () => {
  const { table, said, shown } = easyGame(["ana"]);
  table.answerWindowMs = 50;
  await start(table);
  await until(() => shown.length === 1);
  await until(() => said.some((text) => text.startsWith("Time's up!")));
  expect(said.find((text) => text.startsWith("Time's up!"))).toEndWith("Nobody got it.");
});

test("typed guesses don't count in easy mode: not saved, scored or reacted to", async () => {
  const { table, said, clip, shown } = easyGame(["ana"]);
  table.answerWindowMs = 100;
  const id = await start(table);
  await until(() => shown.length === 1);
  const reactions: string[] = [];
  await handleGuess(GUILD, CHANNEL, "ana", await languageOf(clip.played[0]!), async (emoji) => reactions.push(emoji));

  await until(() => said.some((text) => text.startsWith("Time's up!")));
  expect(said.some((text) => text.includes("got it!"))).toBe(false);
  expect(reactions).toEqual([]);
  expect(await savedGuesses(id)).toEqual([]);
});

test("with answers after the clip, the buttons appear when the clip ends", async () => {
  const { table, clip, shown } = easyGame(["ana"]);
  await start(table, { answersOpen: "after" });
  await until(() => clip.played.length === 1);
  await Bun.sleep(50);
  expect(shown).toEqual([]);

  clip.end();
  await until(() => shown.length === 1);
});

test("a full easy game scores the clicks and says it was easy mode", async () => {
  const { table, said, clip, shown } = easyGame(["ana", "ben"]);
  const id = await start(table);

  for (let round = 0; round < 3; round++) {
    await until(() => shown.length === round + 1);
    const { right, wrong } = await buttons(shown[round]!, clip.played[round]!);
    await handleEasyPick(GUILD, shown[round]!.roundId, right, "ana");
    await handleEasyPick(GUILD, shown[round]!.roundId, round === 0 ? right : wrong, "ben");
  }
  await until(() => !isGameRunning(GUILD));

  expect(said[0]).toStartWith("Language Jungle, easy mode!");
  expect(said.at(-1)).toBe("Game over! Easy mode. <@ana>: 3, <@ben>: 1");
  expect((await savedGuesses(id)).length).toBe(6);
});

test("an easy game won't start with nobody in voice", async () => {
  const { table } = easyGame([]);
  await expect(startGame(table)).rejects.toThrow("No players");
  expect(isGameRunning(GUILD)).toBe(false);
});

test("a normal game is saved as normal, with no options on its rounds", async () => {
  const { table, clip } = easyGame([]);
  delete table.easy;
  const id = await start(table);
  await until(() => clip.played.length === 1);
  stopGame(GUILD);
  await until(() => !isGameRunning(GUILD));

  const [game] = await db.select().from(games).where(eq(games.id, id));
  expect(game?.difficulty).toBe("normal");
  const saved = await db.select().from(rounds).where(eq(rounds.gameId, id));
  expect(saved.map((round) => round.options)).toEqual([null]);
});
