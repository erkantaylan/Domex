import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, runMigrations } from "./db";
import { clips, gameSettings, games, guesses, languages, rounds } from "./db/schema";
import { handleGuess, isGameRunning, normalise, startGame, stopGame, type GameTable } from "./game";
import { DEFAULT_SETTINGS, saveSettings, type GameSettings } from "./settings";

// Runs real games against the database with Discord swapped out.
const GUILD = "test-guild";
const CHANNEL = "test-channel";
const createdGames: number[] = [];

beforeAll(async () => {
  await runMigrations();
  await saveSettings(DEFAULT_SETTINGS);
});

// Stop anything a failed test left running, so one failure doesn't take the next tests with it.
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

// A clip that keeps playing until the test ends it or the game cuts it off, like a long real one.
function longClipTable() {
  const { table, said } = fakeTable(() => {});
  const clip = { played: [] as string[], cutOff: 0, end: () => {} };
  table.play = (filePath) => {
    clip.played.push(filePath);
    return new Promise<void>((resolve) => {
      clip.end = resolve;
    });
  };
  table.stopAudio = () => {
    clip.cutOff++;
    clip.end();
  };
  table.answerWindowMs = 60_000;
  return { table, said, clip };
}

async function startWith(settings: Partial<GameSettings>, table: GameTable) {
  await saveSettings({ ...DEFAULT_SETTINGS, ...settings });
  const id = await startGame(table);
  createdGames.push(id);
  return id;
}

async function savedGuesses(gameId: number) {
  return db
    .select({ userId: guesses.userId, correct: guesses.correct })
    .from(guesses)
    .innerJoin(rounds, eq(guesses.roundId, rounds.id))
    .where(eq(rounds.gameId, gameId));
}

const announcements = (said: string[]) => said.filter((text) => text.includes("seconds left"));

test("default settings: answers and the timer start with the clip, announced at round start", async () => {
  const { table, said, clip } = longClipTable();
  const id = await startWith({ answerSeconds: 12 }, table);

  await until(() => clip.played.length === 1);
  // The clip is still playing.
  expect(announcements(said)).toEqual(["12 seconds left to answer!"]);
  await handleGuess(GUILD, CHANNEL, "right-player", await languageOf(clip.played[0]!));
  expect(clip.cutOff).toBe(1);
  expect(said).toContainEqual(expect.stringContaining("<@right-player> got it!"));

  expect(await savedGuesses(id)).toEqual([{ userId: "right-player", correct: true }]);
});

test("the timer ends a round before a long clip finishes, and stops the clip", async () => {
  const { table, said, clip } = longClipTable();
  table.answerWindowMs = 50;
  await startWith({}, table);

  await until(() => said.some((text) => text.startsWith("Time's up!")));
  // Nobody ended the clip, so only the game can have cut it off.
  expect(clip.cutOff).toBe(1);
  await until(() => clip.played.length === 2);
  expect(said.indexOf("Round 2 of 3 starts in 5 seconds...")).toBeGreaterThan(-1);
});

test("the timer still counts down after a short clip ends, without a second announcement", async () => {
  const { table, said, clip } = longClipTable();
  table.answerWindowMs = 150;
  await startWith({}, table);

  await until(() => clip.played.length === 1);
  clip.end();
  await Bun.sleep(30);
  expect(said.some((text) => text.startsWith("Time's up!"))).toBe(false);
  await until(() => said.some((text) => text.startsWith("Time's up!")));
  expect(announcements(said).length).toBe(1);
});

test("answers during, timer from clip end: guesses count in the clip and the timer waits for its end", async () => {
  const { table, said, clip } = longClipTable();
  table.answerWindowMs = 50;
  const id = await startWith({ timerStart: "clip-end", answerSeconds: 45 }, table);

  await until(() => clip.played.length === 1);
  await handleGuess(GUILD, CHANNEL, "wrong-player", "not a language");
  // Longer than the answer time, and still no timer: the clip hasn't ended.
  await Bun.sleep(100);
  expect(announcements(said)).toEqual([]);
  expect(said.some((text) => text.startsWith("Time's up!"))).toBe(false);

  clip.end();
  await until(() => said.some((text) => text.startsWith("Time's up!")));
  expect(announcements(said)).toEqual(["45 seconds left to answer!"]);
  expect(await savedGuesses(id)).toEqual([{ userId: "wrong-player", correct: false }]);
});

for (const timerStart of ["answers-open", "clip-end"] as const) {
  test(`answers after, timer ${timerStart}: guesses in the clip are ignored and the timer starts at its end`, async () => {
    const { table, said, clip } = longClipTable();
    table.answerWindowMs = 50;
    const id = await startWith({ answersOpen: "after", timerStart, answerSeconds: 20 }, table);

    await until(() => clip.played.length === 1);
    expect(said).toContain("Listen! Answers open when the clip ends.");
    const language = await languageOf(clip.played[0]!);
    await handleGuess(GUILD, CHANNEL, "too-early", language);
    await handleGuess(GUILD, CHANNEL, "too-early", "not a language");
    await Bun.sleep(100);
    expect(said.some((text) => text.includes("got it!") || text.startsWith("Time's up!"))).toBe(false);
    expect(announcements(said)).toEqual([]);
    expect(clip.cutOff).toBe(0);
    expect(await savedGuesses(id)).toEqual([]);

    table.answerWindowMs = 60_000;
    clip.end();
    await until(() => announcements(said).length === 1);
    expect(announcements(said)).toEqual(["Answers are open! 20 seconds left to answer!"]);
    await handleGuess(GUILD, CHANNEL, "on-time", language);
    expect(said).toContainEqual(expect.stringContaining("<@on-time> got it!"));
    expect(await savedGuesses(id)).toEqual([{ userId: "on-time", correct: true }]);
  });

  test(`answers after, timer ${timerStart}: the answer time runs out after the clip`, async () => {
    const { table, said, clip } = longClipTable();
    table.answerWindowMs = 50;
    await startWith({ answersOpen: "after", timerStart }, table);

    await until(() => clip.played.length === 1);
    clip.end();
    await until(() => said.some((text) => text.startsWith("Time's up!")));
  });
}

test("the timer running out while a right answer is being saved doesn't also say time's up", async () => {
  const { table, said, clip } = longClipTable();
  table.answerWindowMs = 50;
  const say = table.say;
  table.say = async (text) => {
    // The announcement of the win is slower than the time left.
    if (text.includes("got it!")) await Bun.sleep(150);
    return say(text);
  };
  await startWith({}, table);

  await until(() => clip.played.length === 1);
  await handleGuess(GUILD, CHANNEL, "right-player", await languageOf(clip.played[0]!));
  expect(said.filter((text) => text.startsWith("Time's up!"))).toEqual([]);
});

test("settings changed during a game wait for the next game", async () => {
  const { table, said, clip } = longClipTable();
  await startWith({ countdownSeconds: 7, answerSeconds: 11 }, table);

  await until(() => clip.played.length === 1);
  await saveSettings({ countdownSeconds: 33, answersOpen: "after", answerSeconds: 99, timerStart: "clip-end" });

  await handleGuess(GUILD, CHANNEL, "right-player", await languageOf(clip.played[0]!));
  await until(() => clip.played.length === 2);
  // Answers still open during the clip, and the old numbers are still used.
  await handleGuess(GUILD, CHANNEL, "right-player", await languageOf(clip.played[1]!));
  await until(() => clip.played.length === 3);

  expect(said).toContain("Round 2 of 3 starts in 7 seconds...");
  expect(said).toContain("Round 3 of 3 starts in 7 seconds...");
  expect(said.filter((text) => text === "Listen!").length).toBe(3);
  expect(announcements(said)).toEqual(Array(3).fill("11 seconds left to answer!"));

  stopGame(GUILD);
  await until(() => !isGameRunning(GUILD));

  // The next game picks the change up.
  const next = longClipTable();
  createdGames.push(await startGame(next.table));
  await until(() => next.said.includes("Listen! Answers open when the clip ends."));
  expect(next.said).toContain("Round 1 of 3 starts in 33 seconds...");
});

test("a missing settings row means the defaults", async () => {
  await db.delete(gameSettings);
  const { table, said, clip } = longClipTable();
  createdGames.push(await startGame(table));

  await until(() => clip.played.length === 1);
  expect(said).toContain("Round 1 of 3 starts in 5 seconds...");
  expect(said).toContain("Listen!");
  expect(announcements(said)).toEqual(["30 seconds left to answer!"]);
});

test("a countdown of zero goes straight to the clip and says so", async () => {
  const { table, said, clip } = longClipTable();
  table.countdownMs = undefined;
  await startWith({ countdownSeconds: 0 }, table);

  await until(() => clip.played.length === 1);
  expect(said).toContain("Round 1 of 3!");
  expect(said.some((text) => text.includes("starts in"))).toBe(false);
});

// Each state a /game stop can land in. The answer time is a minute, so only the stop can end these in time.
const stopCases: { name: string; settings: Partial<GameSettings>; clipEnded: boolean }[] = [
  { name: "the timer running during the clip", settings: {}, clipEnded: false },
  { name: "the timer running after the clip", settings: {}, clipEnded: true },
  { name: "the wait for the clip to end, answers open", settings: { timerStart: "clip-end" }, clipEnded: false },
  { name: "the timer running from the clip's end", settings: { timerStart: "clip-end" }, clipEnded: true },
  { name: "the wait for answers to open", settings: { answersOpen: "after" }, clipEnded: false },
  { name: "the timer running once answers opened", settings: { answersOpen: "after" }, clipEnded: true },
];

for (const { name, settings, clipEnded } of stopCases) {
  test(`stopping during ${name} ends the game promptly`, async () => {
    const { table, said, clip } = longClipTable();
    const id = await startWith(settings, table);

    await until(() => clip.played.length === 1);
    if (clipEnded) {
      clip.end();
      await until(() => announcements(said).length === 1);
    }
    const stoppedAt = Date.now();
    expect(stopGame(GUILD)).toBe(true);
    await until(() => !isGameRunning(GUILD));
    expect(Date.now() - stoppedAt).toBeLessThan(500);

    expect(clip.played.length).toBe(1);
    expect(said.at(-1)).toBe("Game stopped.");
    expect(await finalStatus(id)).toBe("stopped");
  });
}

test("the bot reacts to guesses that count: a tick when right, a cross when wrong, nothing otherwise", async () => {
  const reactions: string[] = [];
  const reactAs = (who: string) => async (emoji: string) => reactions.push(`${who} ${emoji}`);

  await handleGuess(GUILD, CHANNEL, "no-game", "anything", reactAs("no-game"));

  const { table, said, clip } = longClipTable();
  const id = await startWith({ answersOpen: "after" }, table);
  await until(() => clip.played.length === 1);
  const language = await languageOf(clip.played[0]!);

  await handleGuess(GUILD, "other-channel", "elsewhere", language, reactAs("elsewhere"));
  await handleGuess(GUILD, CHANNEL, "too-early", language, reactAs("too-early"));

  clip.end();
  await until(() => announcements(said).length === 1);
  await handleGuess(GUILD, CHANNEL, "wrong", "not a language", reactAs("wrong"));
  // A long countdown before round 2, so the round stays over while the late guess comes in.
  table.countdownMs = 60_000;
  await handleGuess(GUILD, CHANNEL, "right", language, reactAs("right"));
  await handleGuess(GUILD, CHANNEL, "late", language, reactAs("late"));

  await until(() => reactions.length === 2);
  await Bun.sleep(20);
  expect(reactions).toEqual(["wrong ❌", "right ✅"]);
  expect(await savedGuesses(id)).toEqual([
    { userId: "wrong", correct: false },
    { userId: "right", correct: true },
  ]);
});

test("a reaction that fails or hangs doesn't hold up or break the round", async () => {
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    const { table, said, clip } = longClipTable();
    const id = await startWith({}, table);
    await until(() => clip.played.length === 1);

    await handleGuess(GUILD, CHANNEL, "throws", "secret words one", () => {
      throw new Error("Missing Permissions");
    });
    await handleGuess(GUILD, CHANNEL, "rejects", "secret words two", () => Promise.reject(new Error("Unknown Message")));
    // Never settles: the round must not wait for it.
    await handleGuess(GUILD, CHANNEL, "right", await languageOf(clip.played[0]!), () => new Promise(() => {}));

    expect(said).toContainEqual(expect.stringContaining("<@right> got it!"));
    expect(clip.cutOff).toBe(1);
    await until(() => clip.played.length === 2);
    expect(await savedGuesses(id)).toEqual([
      { userId: "throws", correct: false },
      { userId: "rejects", correct: false },
      { userId: "right", correct: true },
    ]);

    const lines = logged.mock.calls.map((args) => args.join(" "));
    expect(lines).toContain("Couldn't react to a guess: Missing Permissions");
    expect(lines).toContain("Couldn't react to a guess: Unknown Message");
    expect(lines.some((line) => line.includes("secret words"))).toBe(false);
  } finally {
    logged.mockRestore();
  }
});
