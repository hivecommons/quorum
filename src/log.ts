/**
 * Structured JSON logging to stderr. Secret values registered with `addSecret` are replaced with
 * "[redacted]" wherever they appear in a log line, so a token read from a file can never be
 * printed even if it ends up inside an upstream error message.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_SECRET_LENGTH = 4;
const REDACTED = "[redacted]";

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

const secrets = new Set<string>();

/** Registers a value that must never appear in a log line. Very short values are ignored. */
export function addSecret(value: string | undefined): void {
  if (value && value.length >= MIN_SECRET_LENGTH) {
    secrets.add(value);
  }
}

/** For tests: forget every registered secret. */
export function clearSecrets(): void {
  secrets.clear();
}

export function redact(text: string): string {
  let out = text;
  for (const s of secrets) {
    out = out.split(s).join(REDACTED);
  }
  return out;
}

export function parseLevel(raw: string | undefined): LogLevel {
  const v = (raw ?? "").toLowerCase();
  return v === "debug" || v === "warn" || v === "error" ? v : "info";
}

export function createLogger(
  level: LogLevel = "info",
  write: (line: string) => void = (line) => process.stderr.write(line + "\n"),
): Logger {
  const emit = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>): void => {
    if (LEVEL_RANK[lvl] < LEVEL_RANK[level]) {
      return;
    }
    const line = JSON.stringify({ ts: new Date().toISOString(), level: lvl, msg, ...fields });
    write(redact(line));
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
  };
}

/** A logger that drops everything; the default in tests. */
export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
