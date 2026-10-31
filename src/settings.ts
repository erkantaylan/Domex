import { db } from "./db";
import { gameSettings } from "./db/schema";

export type GameSettings = {
  countdownSeconds: number;
  answersOpen: "during" | "after";
  answerSeconds: number;
  timerStart: "answers-open" | "clip-end";
};

export const DEFAULT_SETTINGS: GameSettings = {
  countdownSeconds: 5,
  answersOpen: "during",
  answerSeconds: 30,
  timerStart: "answers-open",
};

const isWholeBetween = (value: unknown, low: number, high: number) =>
  typeof value === "number" && Number.isInteger(value) && value >= low && value <= high;

// Each setting's rule. A rule returns what's wrong, or null if the value is fine.
const RULES: Record<keyof GameSettings, (value: unknown) => string | null> = {
  countdownSeconds: (value) => (isWholeBetween(value, 0, 60) ? null : "Use a whole number from 0 to 60."),
  answersOpen: (value) => (value === "during" || value === "after" ? null : "Choose during or after."),
  answerSeconds: (value) => (isWholeBetween(value, 5, 300) ? null : "Use a whole number from 5 to 300."),
  timerStart: (value) => (value === "answers-open" || value === "clip-end" ? null : "Choose answers-open or clip-end."),
};

export type SettingsCheck =
  | { ok: true; settings: GameSettings }
  | { ok: false; errors: Record<string, string> };

// The server's own check of what the dashboard sends. Every setting is required, and nothing else is allowed.
export function checkSettings(input: unknown): SettingsCheck {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errors: { form: "Send the settings as an object." } };
  }
  const values = input as Record<string, unknown>;
  const errors: Record<string, string> = {};
  for (const [name, rule] of Object.entries(RULES)) {
    const problem = rule(values[name]);
    if (problem) errors[name] = problem;
  }
  if (Object.keys(values).some((name) => !(name in RULES))) errors.form = "Unknown setting.";
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const { countdownSeconds, answersOpen, answerSeconds, timerStart } = values as GameSettings;
  return { ok: true, settings: { countdownSeconds, answersOpen, answerSeconds, timerStart } };
}

// The saved settings. No row yet means the defaults, and so does a number someone changed by hand to a bad one.
export async function loadSettings(): Promise<GameSettings> {
  const [row] = await db.select().from(gameSettings).limit(1);
  if (!row) return { ...DEFAULT_SETTINGS };
  const settings = { ...DEFAULT_SETTINGS };
  if (!RULES.countdownSeconds(row.countdownSeconds)) settings.countdownSeconds = row.countdownSeconds;
  if (!RULES.answerSeconds(row.answerSeconds)) settings.answerSeconds = row.answerSeconds;
  settings.answersOpen = row.answersOpen;
  settings.timerStart = row.timerStart;
  return settings;
}

export async function saveSettings(settings: GameSettings) {
  await db
    .insert(gameSettings)
    .values({ id: 1, ...settings })
    .onConflictDoUpdate({ target: gameSettings.id, set: settings });
}

// For a game about to start: a settings problem must never stop the game.
export async function settingsForNewGame() {
  try {
    return await loadSettings();
  } catch {
    // No error details: a database error message includes the values in the query.
    console.error("Couldn't read the game settings, so this game uses the defaults.");
    return { ...DEFAULT_SETTINGS };
  }
}
