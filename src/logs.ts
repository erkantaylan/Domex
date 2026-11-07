// Keeps the bot's recent log lines in memory, so the admin can read them on the dashboard.
// They go away on restart.
export type LogEntry = { time: number; level: "info" | "error"; text: string };

const MAX_ENTRIES = 500;
const MAX_TEXT = 4000;
const SECRET_SETTINGS = ["DISCORD_TOKEN", "DISCORD_CLIENT_SECRET", "ADMIN_PASSWORD", "POSTGRES_PASSWORD", "DATABASE_URL"];

const entries: LogEntry[] = [];

// An error message could quote a setting, so secrets are removed before anything is kept.
export function redact(text: string) {
  let clean = text;
  for (const name of SECRET_SETTINGS) {
    const value = process.env[name];
    if (value && value.length >= 4) clean = clean.replaceAll(value, "[hidden]");
  }
  return clean
    .replace(/[A-Za-z0-9_-]{23,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/g, "[hidden]")
    // Admin tokens: "lj_" and 43 base64url characters.
    .replace(/lj_[A-Za-z0-9_-]{43}/g, "[hidden]")
    .replace(/(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+@/g, "$1[hidden]@");
}

export function addLog(level: LogEntry["level"], parts: unknown[]) {
  const text = parts.map((part) => (typeof part === "string" ? part : Bun.inspect(part))).join(" ");
  // Bun.stripANSI removes terminal colours, which would show up as junk on a web page.
  entries.push({ time: Date.now(), level, text: redact(Bun.stripANSI(text)).slice(0, MAX_TEXT) });
  if (entries.length > MAX_ENTRIES) entries.shift();
}

export function recentLogs() {
  return [...entries];
}

// Everything still goes to the normal output as well.
export function captureLogs() {
  const { log, warn, error } = console;
  console.log = (...parts: unknown[]) => {
    addLog("info", parts);
    log(...parts);
  };
  console.warn = (...parts: unknown[]) => {
    addLog("error", parts);
    warn(...parts);
  };
  console.error = (...parts: unknown[]) => {
    addLog("error", parts);
    error(...parts);
  };
}
