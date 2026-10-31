import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import { db } from "./db";
import { clips, games, guesses, languages, rounds } from "./db/schema";

// The games this player has at least one guess in, newest first, with only their own guesses.
// Running games stay out: the language of a round in play is the answer.
export async function getHistory(userId: string) {
  const played = await db
    .selectDistinct({ id: games.id, status: games.status, startedAt: games.startedAt })
    .from(guesses)
    .innerJoin(rounds, eq(guesses.roundId, rounds.id))
    .innerJoin(games, eq(rounds.gameId, games.id))
    .where(and(eq(guesses.userId, userId), ne(games.status, "running")))
    .orderBy(desc(games.startedAt), desc(games.id));
  if (played.length === 0) return [];

  const allRounds = await db
    .select({ id: rounds.id, gameId: rounds.gameId, number: rounds.number, language: languages.name })
    .from(rounds)
    .innerJoin(clips, eq(rounds.clipId, clips.id))
    .innerJoin(languages, eq(clips.languageId, languages.id))
    .where(
      inArray(
        rounds.gameId,
        played.map((game) => game.id),
      ),
    )
    .orderBy(asc(rounds.number));

  const ownGuesses = await db
    .select({ roundId: guesses.roundId, text: guesses.text, correct: guesses.correct })
    .from(guesses)
    .where(
      and(
        eq(guesses.userId, userId),
        inArray(
          guesses.roundId,
          allRounds.map((round) => round.id),
        ),
      ),
    )
    .orderBy(asc(guesses.createdAt), asc(guesses.id));

  return played.map((game) => {
    const gameRounds = allRounds
      .filter((round) => round.gameId === game.id)
      .map((round) => {
        const roundGuesses = ownGuesses
          .filter((guess) => guess.roundId === round.id)
          .map(({ text, correct }) => ({ text, correct }));
        return {
          number: round.number,
          language: round.language,
          guessed: roundGuesses.length > 0,
          correct: roundGuesses.some((guess) => guess.correct),
          guesses: roundGuesses,
        };
      });
    return {
      date: game.startedAt.toISOString(),
      status: game.status,
      correctRounds: gameRounds.filter((round) => round.correct).length,
      rounds: gameRounds,
    };
  });
}
