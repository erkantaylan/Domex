import { eq } from "drizzle-orm";
import { db } from "./db";
import { clips, games, guesses, languages, rounds } from "./db/schema";

const ROUNDS_PER_GAME = 3;
const SECONDS_AFTER_CLIP = 30;

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
};

type RoundOutcome = "correct" | "timeout" | "stopped";

type OpenRound = { id: number; language: string; finish: (outcome: RoundOutcome) => void };

type Game = {
  id: number;
  table: GameTable;
  scores: Map<string, number>;
  round: OpenRound | null;
  stopped: boolean;
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

export async function startGame(table: GameTable) {
  if (activeGames.has(table.guildId)) throw new Error("A game is already running");

  // Hold the server's place right away, so a second /game start can't slip in.
  const game: Game = { id: 0, table, scores: new Map(), round: null, stopped: false };
  activeGames.set(table.guildId, game);

  try {
    const picked = await pickClips(ROUNDS_PER_GAME);
    if (picked.length < ROUNDS_PER_GAME) throw new Error("Not enough clips imported");

    const [row] = await db
      .insert(games)
      .values({ guildId: table.guildId, channelId: table.channelId, startedBy: table.startedBy })
      .returning({ id: games.id });
    if (!row) throw new Error("Couldn't save the game");
    game.id = row.id;

    await table.join();
    // Runs in the background so /game start can answer straight away.
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
    await table.say(`Language Jungle! ${picked.length} clips are coming. Type the language here in this chat.`);

    for (const [index, clip] of picked.entries()) {
      if (game.stopped) break;
      await playRound(game, clip, index + 1, picked.length);
    }

    if (game.stopped) {
      status = "stopped";
      await table.say("Game stopped.");
    } else {
      await table.say(`Game over! ${scoreboard(game)}`);
    }
  } catch (error) {
    status = "failed";
    console.error("Game failed:", error);
    await table.say("Something went wrong, so the game has ended.").catch(() => {});
  } finally {
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
  const { table } = game;
  const [row] = await db.insert(rounds).values({ gameId: game.id, clipId: clip.id, number }).returning({ id: rounds.id });
  if (!row) throw new Error("Couldn't save the round");

  await table.say(`Round ${number} of ${total}. Listen!`);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await new Promise<RoundOutcome>((resolve, reject) => {
    // Answers count from the moment the clip starts.
    game.round = { id: row.id, language: clip.language, finish: resolve };
    if (game.stopped) return resolve("stopped");

    table
      .play(clip.filePath)
      .then(() => {
        if (game.round?.id !== row.id) return;
        timer = setTimeout(() => resolve("timeout"), table.answerWindowMs ?? SECONDS_AFTER_CLIP * 1000);
        return table.say(`${SECONDS_AFTER_CLIP} seconds left to answer!`);
      })
      .catch(reject);
  }).finally(() => {
    clearTimeout(timer);
    game.round = null;
    table.stopAudio();
  });

  await db.update(rounds).set({ endedAt: new Date() }).where(eq(rounds.id, row.id));
  if (outcome === "timeout") await table.say(`Time's up! It was ${clip.language}.`);
}

function scoreboard(game: Game) {
  const ranked = [...game.scores.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return "Nobody got one right this time.";
  return ranked.map(([userId, score]) => `<@${userId}>: ${score}`).join(", ");
}

// Called for every chat message. Only messages in the game's channel during a round count.
export async function handleGuess(guildId: string, channelId: string, userId: string, text: string) {
  const game = activeGames.get(guildId);
  if (!game || game.table.channelId !== channelId) return;
  const round = game.round;
  if (!round) return;

  const correct = normalise(text) === normalise(round.language);
  // Close the round before any waiting, so two right answers can't both win.
  if (correct) game.round = null;

  try {
    if (correct) game.scores.set(userId, (game.scores.get(userId) ?? 0) + 1);
    await db.insert(guesses).values({ roundId: round.id, userId, text, correct });
    if (correct) await game.table.say(`<@${userId}> got it! It was ${round.language}.`);
  } finally {
    // Even if saving or announcing fails, the game has to move on.
    if (correct) round.finish("correct");
  }
}

export function stopGame(guildId: string) {
  const game = activeGames.get(guildId);
  if (!game) return false;
  game.stopped = true;
  game.round?.finish("stopped");
  return true;
}

// A restart loses the games in memory, so don't leave them marked as running.
export async function closeLeftoverGames() {
  await db.update(games).set({ status: "failed", endedAt: new Date() }).where(eq(games.status, "running"));
}
