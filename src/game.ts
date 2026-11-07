import { eq } from "drizzle-orm";
import { db } from "./db";
import { clips, games, guesses, languages, rounds } from "./db/schema";
import { DEFAULT_SETTINGS, settingsForNewGame, type GameSettings } from "./settings";

const ROUNDS_PER_GAME = 3;
const OPTIONS_PER_ROUND = 5;

export const NOT_A_PLAYER = "Only players who were in voice when the game started can answer.";

// An easy round's message, once its buttons are posted.
export type EasyRoundView = {
  // Shows how many players have picked, like "4/6 picked".
  showPicked: (picked: number, total: number) => Promise<unknown>;
  // Switches the buttons off and shows the right answer.
  close: (rightIndex: number) => Promise<unknown>;
};

// What easy mode needs from Discord on top of the table. A game with this is an easy game.
export type EasyTable = {
  // Fixed when the game starts: the people in the voice channel, not counting bots.
  players: string[];
  // Whether the player is in the game's voice channel right now.
  inVoice: (userId: string) => boolean;
  // Posts the round's buttons, one per option, in this order.
  showOptions: (roundId: number, options: string[], total: number) => Promise<EasyRoundView>;
};

// What the game needs from Discord. Keeping it separate lets tests run a game without Discord.
export type GameTable = {
  guildId: string;
  channelId: string;
  startedBy: string;
  say: (text: string) => Promise<unknown>;
  join: () => Promise<void>;
  // Resolves when the clip has finished or been stopped.
  play: (filePath: string) => Promise<void>;
  stopAudio: () => void;
  leave: () => void;
  answerWindowMs?: number;
  countdownMs?: number;
  easy?: EasyTable;
};

type RoundOutcome = "correct" | "all-picked" | "timeout" | "stopped";

type EasyRound = {
  options: string[];
  picked: Set<string>;
  winners: string[];
  // Edits to the round's message wait for each other, so a late count can't switch the buttons back on.
  edits: Promise<EasyRoundView | null>;
};

// Exists for the whole round, so a stop can always end it. Guesses count only while answersOpen is true.
type OpenRound = {
  id: number;
  language: string;
  answersOpen: boolean;
  finish: (outcome: RoundOutcome) => void;
  easy?: EasyRound;
};

type Game = {
  id: number;
  table: GameTable;
  // Read once at the start, so changes on the dashboard wait for the next game.
  settings: GameSettings;
  scores: Map<string, number>;
  round: OpenRound | null;
  stopped: boolean;
  // Ends the countdown early. Only set during a countdown.
  endCountdown: (() => void) | null;
  // Easy mode only: every language with a clip, for the wrong options.
  languages: string[];
};

// At most one game per server. Everything that should last is in the database.
const activeGames = new Map<string, Game>();

export function isGameRunning(guildId: string) {
  return activeGames.has(guildId);
}

// Capitals and extra spaces don't count against a player.
export function normalise(text: string) {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

// Picks clips from different languages, at random.
async function pickClips(howMany: number) {
  const all = await db
    .select({ id: clips.id, filePath: clips.filePath, language: languages.name })
    .from(clips)
    .innerJoin(languages, eq(clips.languageId, languages.id));

  const shuffled = all
    .map((clip) => ({ clip, order: Math.random() }))
    .sort((a, b) => a.order - b.order)
    .map(({ clip }) => clip);

  const picked = new Map<string, (typeof all)[number]>();
  for (const clip of shuffled) {
    if (!picked.has(clip.language)) picked.set(clip.language, clip);
    if (picked.size === howMany) break;
  }
  return [...picked.values()];
}

function shuffle<T>(items: T[]) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

// The right language and 4 random other ones, in a random order.
function pickOptions(right: string, all: string[]) {
  const wrong = shuffle(all.filter((name) => name !== right)).slice(0, OPTIONS_PER_ROUND - 1);
  return shuffle([right, ...wrong]);
}

async function languagesWithClips() {
  const rows = await db
    .selectDistinct({ name: languages.name })
    .from(languages)
    .innerJoin(clips, eq(clips.languageId, languages.id));
  return rows.map((row) => row.name);
}

export async function startGame(table: GameTable) {
  if (activeGames.has(table.guildId)) throw new Error("A game is already running");

  // Hold the server's place right away, so a second /game start can't slip in.
  const game: Game = {
    id: 0,
    table,
    settings: DEFAULT_SETTINGS,
    scores: new Map(),
    round: null,
    stopped: false,
    endCountdown: null,
    languages: [],
  };
  activeGames.set(table.guildId, game);

  try {
    game.settings = await settingsForNewGame();
    const picked = await pickClips(ROUNDS_PER_GAME);
    if (picked.length < ROUNDS_PER_GAME) throw new Error("Not enough clips imported");
    if (table.easy) {
      if (table.easy.players.length === 0) throw new Error("No players in voice");
      game.languages = await languagesWithClips();
      if (game.languages.length < OPTIONS_PER_ROUND) throw new Error("Not enough languages for easy mode");
    }

    const difficulty = table.easy ? "easy" : "normal";
    const [row] = await db
      .insert(games)
      .values({ guildId: table.guildId, channelId: table.channelId, startedBy: table.startedBy, difficulty })
      .returning({ id: games.id });
    if (!row) throw new Error("Couldn't save the game");
    game.id = row.id;

    await table.join();
    // Runs in the background so /game start can answer straight away.
    console.log(`Game ${game.id} started in channel ${table.channelId}`);
    void runGame(game, picked);
    return game.id;
  } catch (error) {
    activeGames.delete(table.guildId);
    if (game.id) await db.update(games).set({ status: "failed", endedAt: new Date() }).where(eq(games.id, game.id));
    throw error;
  }
}

async function runGame(game: Game, picked: Awaited<ReturnType<typeof pickClips>>) {
  const { table } = game;
  let status: "finished" | "stopped" | "failed" = "finished";
  try {
    await table.say(
      table.easy
        ? `Language Jungle, easy mode! ${picked.length} clips are coming. Pick the language with the buttons.`
        : `Language Jungle! ${picked.length} clips are coming. Type the language here in this chat.`,
    );

    for (const [index, clip] of picked.entries()) {
      if (game.stopped) break;
      await playRound(game, clip, index + 1, picked.length);
    }

    if (game.stopped) {
      status = "stopped";
      await table.say("Game stopped.");
    } else {
      await table.say(`Game over! ${table.easy ? "Easy mode. " : ""}${scoreboard(game)}`);
    }
  } catch (error) {
    status = "failed";
    console.error("Game failed:", error);
    await table.say("Something went wrong, so the game has ended.").catch(() => {});
  } finally {
    console.log(`Game ${game.id} ended: ${status}`);
    game.round = null;
    activeGames.delete(table.guildId);
    table.leave();
    await db
      .update(games)
      .set({ status, endedAt: new Date() })
      .where(eq(games.id, game.id))
      .catch((error) => console.error("Couldn't save the game's end:", error));
  }
}

async function playRound(
  game: Game,
  clip: { id: number; filePath: string; language: string },
  number: number,
  total: number,
) {
  const { table, settings } = game;

  // One message and a wait, not one per second: that would spam the chat and hit Discord's rate limits.
  // Answers aren't open yet, so answers during this wait don't count.
  const seconds = settings.countdownSeconds;
  await table.say(
    seconds === 0
      ? `Round ${number} of ${total}!`
      : `Round ${number} of ${total} starts in ${seconds} ${seconds === 1 ? "second" : "seconds"}...`,
  );
  await countdown(game, table.countdownMs ?? seconds * 1000);
  // A stopped game never reaches the database or the clip for this round.
  if (game.stopped) return;

  const options = table.easy ? pickOptions(clip.language, game.languages) : undefined;
  const [row] = await db
    .insert(rounds)
    .values({ gameId: game.id, clipId: clip.id, number, options })
    .returning({ id: rounds.id });
  if (!row) throw new Error("Couldn't save the round");
  const easy: EasyRound | undefined = options && {
    options,
    picked: new Set(),
    winners: [],
    edits: Promise.resolve(null),
  };

  const openFromStart = settings.answersOpen === "during";
  await table.say(openFromStart ? "Listen!" : "Listen! Answers open when the clip ends.");

  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await new Promise<RoundOutcome>((resolve, reject) => {
    const round: OpenRound = { id: row.id, language: clip.language, answersOpen: openFromStart, finish: resolve, easy };
    game.round = round;
    if (game.stopped) return resolve("stopped");

    // In easy mode the buttons appear when answers open.
    function showButtons() {
      if (!easy || !table.easy) return;
      const shown = table.easy.showOptions(round.id, easy.options, table.easy.players.length);
      shown.catch(reject);
      easy.edits = shown.catch(() => null);
    }
    if (openFromStart) showButtons();

    function startTimer(announcement: string) {
      timer = setTimeout(() => {
        // A right answer closes the round before it's saved, and that answer wins.
        if (game.round === round) resolve("timeout");
      }, table.answerWindowMs ?? settings.answerSeconds * 1000);
      table.say(announcement).catch(reject);
    }

    const timerFromStart = openFromStart && settings.timerStart === "answers-open";
    if (timerFromStart) startTimer(`${settings.answerSeconds} seconds left to answer!`);

    table
      .play(clip.filePath)
      .then(() => {
        // The clip ended by itself. If the round is already over, it was cut off and there's nothing to do.
        if (game.round !== round) return;
        round.answersOpen = true;
        if (!openFromStart) showButtons();
        if (timerFromStart) return;
        const opening = openFromStart ? "" : "Answers are open! ";
        startTimer(`${opening}${settings.answerSeconds} seconds left to answer!`);
      })
      .catch(reject);
  }).finally(() => {
    clearTimeout(timer);
    game.round = null;
    table.stopAudio();
  });

  await db.update(rounds).set({ endedAt: new Date() }).where(eq(rounds.id, row.id));
  if (easy) {
    await editRoundMessage(easy, (view) => view.close(easy.options.indexOf(clip.language)));
    if (outcome !== "stopped") await table.say(easyResult(outcome, clip.language, easy.winners));
  } else if (outcome === "timeout") await table.say(`Time's up! It was ${clip.language}.`);
}

function easyResult(outcome: RoundOutcome, language: string, winners: string[]) {
  const opening = outcome === "all-picked" ? "Everyone picked!" : "Time's up!";
  const who = winners.length === 0 ? "Nobody got it." : `${winners.map((id) => `<@${id}>`).join(", ")} got it!`;
  return `${opening} It was ${language}. ${who}`;
}

// Queues an edit of the round's message. A failed edit is only logged: the round goes on without it.
function editRoundMessage(easy: EasyRound, edit: (view: EasyRoundView) => Promise<unknown>) {
  easy.edits = easy.edits.then(async (view) => {
    if (view) {
      await edit(view).catch((error) =>
        console.error(`Couldn't update the round's buttons: ${error instanceof Error ? error.message : "unknown error"}`),
      );
    }
    return view;
  });
  return easy.edits;
}

// Waits out the countdown, or until the game is stopped.
function countdown(game: Game, ms: number) {
  return new Promise<void>((resolve) => {
    if (game.stopped) return resolve();
    const timer = setTimeout(end, ms);
    function end() {
      clearTimeout(timer);
      game.endCountdown = null;
      resolve();
    }
    game.endCountdown = end;
  });
}

function scoreboard(game: Game) {
  const ranked = [...game.scores.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return "Nobody got one right this time.";
  return ranked.map(([userId, score]) => `<@${userId}>: ${score}`).join(", ");
}

// Puts an emoji on the player's message, so they can see their guess was read.
export type ReactToGuess = (emoji: string) => Promise<unknown>;

// Fire and forget: the round never waits for the reaction, and a failed one (no permission, deleted message) is only logged.
function reactTo(react: ReactToGuess, emoji: string) {
  Promise.resolve()
    .then(() => react(emoji))
    .catch((error) => console.error(`Couldn't react to a guess: ${error instanceof Error ? error.message : "unknown error"}`));
}

// Called for every chat message. Only messages in the game's channel while answers are open count.
export async function handleGuess(guildId: string, channelId: string, userId: string, text: string, react?: ReactToGuess) {
  const game = activeGames.get(guildId);
  if (!game || game.table.channelId !== channelId) return;
  // Easy mode is played with buttons, so typing doesn't count.
  if (game.table.easy) return;
  const round = game.round;
  if (!round?.answersOpen) return;

  const correct = normalise(text) === normalise(round.language);
  // Close the round before any waiting, so two right answers can't both win.
  if (correct) game.round = null;

  try {
    if (correct) game.scores.set(userId, (game.scores.get(userId) ?? 0) + 1);
    await db.insert(guesses).values({ roundId: round.id, userId, text, correct });
    // Only a guess that counted and was saved gets a reaction.
    if (react) reactTo(react, correct ? "✅" : "❌");
    if (correct) await game.table.say(`<@${userId}> got it! It was ${round.language}.`);
  } finally {
    // Even if saving or announcing fails, the game has to move on.
    if (correct) round.finish("correct");
  }
}

// Called for every click on an easy round's button. Returns the private reply for the player who clicked.
export async function handleEasyPick(guildId: string, roundId: number, index: number, userId: string) {
  const game = activeGames.get(guildId);
  const round = game?.round;
  const easyTable = game?.table.easy;
  const easy = round?.easy;
  const option = easy?.options[index];
  if (!easyTable || !round?.answersOpen || round.id !== roundId || !easy || option === undefined) {
    return "This round is over.";
  }
  if (!easyTable.players.includes(userId) || !easyTable.inVoice(userId)) return NOT_A_PLAYER;
  // Marked before any waiting, so a quick double click only counts once.
  if (easy.picked.has(userId)) return "You already picked.";
  easy.picked.add(userId);

  const correct = option === round.language;
  if (correct) {
    easy.winners.push(userId);
    game.scores.set(userId, (game.scores.get(userId) ?? 0) + 1);
  }
  const everyone = easy.picked.size === easyTable.players.length;
  // Close the round before any waiting, so the timer can't also end it.
  if (everyone) game.round = null;

  try {
    await db.insert(guesses).values({ roundId: round.id, userId, text: option, correct });
  } finally {
    void editRoundMessage(easy, (view) => view.showPicked(easy.picked.size, easyTable.players.length));
    // Even if saving fails, the game has to move on.
    if (everyone) round.finish("all-picked");
  }
  return `You picked ${option}.`;
}

export function stopGame(guildId: string) {
  const game = activeGames.get(guildId);
  if (!game) return false;
  game.stopped = true;
  game.round?.finish("stopped");
  game.endCountdown?.();
  return true;
}

// A restart loses the games in memory, so don't leave them marked as running.
export async function closeLeftoverGames() {
  await db.update(games).set({ status: "failed", endedAt: new Date() }).where(eq(games.status, "running"));
}
