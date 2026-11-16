import { readFileSync } from "node:fs";
import { addSecret } from "./log.js";
import { QuorumError } from "./errors.js";

/**
 * Runtime configuration, read once from the environment. Every numeric limit is an env var with
 * the default shown in DEFAULTS (docs/contract.md: "Every numeric limit in this file is an env var
 * with the default shown"). Secrets are never held here: only the paths of the files hive writes
 * them to, read on use so hive can rotate a key without restarting quorum.
 */

export const DEFAULTS = {
  listen: "127.0.0.1:8765",
  chatMaxChars: 2000,
  sayMaxChars: 1000,
  transcriptBuffer: 2000,
  lobbyTimeoutS: 600,
  vexaTimeoutMs: 15_000,
  wsBackoffMinMs: 1000,
  wsBackoffMaxMs: 30_000,
  sseHeartbeatS: 15,
  meetingRetentionS: 3600,
  maxBodyBytes: 1_048_576,
  echoWindowS: 120,
  discordSilenceMs: 800,
  discordMinSegmentMs: 300,
  discordMaxSegmentS: 30,
  discordJoinTimeoutS: 20,
  discordRequestTtlS: 300,
  transcribeTimeoutMs: 60_000,
  ttsVoice: "af_heart",
  ttsTimeoutMs: 30_000,
} as const;

export type DiscordCommandScope = "guild" | "global" | "off";

export interface Config {
  host: string;
  port: number;
  tokenFile: string | undefined;
  vexaUrl: string | undefined;
  vexaApiKeyFile: string | undefined;
  discordTokenFile: string | undefined;
  discordCommands: DiscordCommandScope;
  vexaVoiceDefault: boolean;
  transcribeUrl: string | undefined;
  transcribeTokenFile: string | undefined;
  transcribeLanguage: string | undefined;
  ttsUrl: string | undefined;
  ttsTokenFile: string | undefined;
  ttsVoice: string;
  ttsTimeoutMs: number;
  chatMaxChars: number;
  sayMaxChars: number;
  transcriptBuffer: number;
  lobbyTimeoutS: number;
  vexaTimeoutMs: number;
  wsBackoffMinMs: number;
  wsBackoffMaxMs: number;
  sseHeartbeatS: number;
  meetingRetentionS: number;
  maxBodyBytes: number;
  echoWindowS: number;
  discordSilenceMs: number;
  discordMinSegmentMs: number;
  discordMaxSegmentS: number;
  discordJoinTimeoutS: number;
  discordRequestTtlS: number;
  transcribeTimeoutMs: number;
  logLevel: string | undefined;
}

type Env = Record<string, string | undefined>;

function optional(env: Env, name: string): string | undefined {
  const v = env[name]?.trim();
  return v ? v : undefined;
}

function positiveInt(env: Env, name: string, fallback: number): number {
  const raw = optional(env, name);
  if (raw === undefined) {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

/** Parses "host:port", "[v6]:port" or ":port" (loopback host). */
export function parseListen(raw: string): { host: string; port: number } {
  const m = /^(?:\[([^\]]+)\]|([^:]*)):(\d{1,5})$/.exec(raw.trim());
  const port = m ? Number(m[3]) : NaN;
  const MAX_PORT = 65_535;
  if (!m || port > MAX_PORT) {
    throw new Error(`QUORUM_LISTEN must be host:port, got ${JSON.stringify(raw)}`);
  }
  const host = m[1] ?? (m[2] || "127.0.0.1");
  return { host, port };
}

function bool(env: Env, name: string): boolean {
  const v = (optional(env, name) ?? "false").toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(v)) {
    return false;
  }
  throw new Error(`${name} must be true or false, got ${JSON.stringify(v)}`);
}

function commandScope(env: Env): DiscordCommandScope {
  const v = optional(env, "QUORUM_DISCORD_COMMANDS") ?? "guild";
  if (v === "guild" || v === "global" || v === "off") {
    return v;
  }
  throw new Error(`QUORUM_DISCORD_COMMANDS must be guild, global or off, got ${JSON.stringify(v)}`);
}

export function loadConfig(env: Env = process.env): Config {
  const { host, port } = parseListen(optional(env, "QUORUM_LISTEN") ?? DEFAULTS.listen);
  return {
    host,
    port,
    tokenFile: optional(env, "QUORUM_TOKEN_FILE"),
    vexaUrl: optional(env, "QUORUM_VEXA_URL")?.replace(/\/+$/, ""),
    vexaApiKeyFile: optional(env, "QUORUM_VEXA_API_KEY_FILE"),
    discordTokenFile: optional(env, "QUORUM_DISCORD_TOKEN_FILE"),
    discordCommands: commandScope(env),
    vexaVoiceDefault: bool(env, "QUORUM_VEXA_VOICE"),
    transcribeUrl: optional(env, "QUORUM_TRANSCRIBE_URL")?.replace(/\/+$/, ""),
    transcribeTokenFile: optional(env, "QUORUM_TRANSCRIBE_TOKEN_FILE"),
    transcribeLanguage: optional(env, "QUORUM_TRANSCRIBE_LANGUAGE"),
    ttsUrl: optional(env, "QUORUM_TTS_URL")?.replace(/\/+$/, ""),
    ttsTokenFile: optional(env, "QUORUM_TTS_TOKEN_FILE"),
    ttsVoice: optional(env, "QUORUM_TTS_VOICE") ?? DEFAULTS.ttsVoice,
    ttsTimeoutMs: positiveInt(env, "QUORUM_TTS_TIMEOUT_MS", DEFAULTS.ttsTimeoutMs),
    chatMaxChars: positiveInt(env, "QUORUM_CHAT_MAX_CHARS", DEFAULTS.chatMaxChars),
    sayMaxChars: positiveInt(env, "QUORUM_SAY_MAX_CHARS", DEFAULTS.sayMaxChars),
    transcriptBuffer: positiveInt(env, "QUORUM_TRANSCRIPT_BUFFER", DEFAULTS.transcriptBuffer),
    lobbyTimeoutS: positiveInt(env, "QUORUM_LOBBY_TIMEOUT_S", DEFAULTS.lobbyTimeoutS),
    vexaTimeoutMs: positiveInt(env, "QUORUM_VEXA_TIMEOUT_MS", DEFAULTS.vexaTimeoutMs),
    wsBackoffMinMs: positiveInt(env, "QUORUM_VEXA_WS_BACKOFF_MIN_MS", DEFAULTS.wsBackoffMinMs),
    wsBackoffMaxMs: positiveInt(env, "QUORUM_VEXA_WS_BACKOFF_MAX_MS", DEFAULTS.wsBackoffMaxMs),
    sseHeartbeatS: positiveInt(env, "QUORUM_SSE_HEARTBEAT_S", DEFAULTS.sseHeartbeatS),
    meetingRetentionS: positiveInt(env, "QUORUM_MEETING_RETENTION_S", DEFAULTS.meetingRetentionS),
    maxBodyBytes: positiveInt(env, "QUORUM_MAX_BODY_BYTES", DEFAULTS.maxBodyBytes),
    echoWindowS: positiveInt(env, "QUORUM_ECHO_WINDOW_S", DEFAULTS.echoWindowS),
    discordSilenceMs: positiveInt(env, "QUORUM_DISCORD_SILENCE_MS", DEFAULTS.discordSilenceMs),
    discordMinSegmentMs: positiveInt(
      env,
      "QUORUM_DISCORD_MIN_SEGMENT_MS",
      DEFAULTS.discordMinSegmentMs,
    ),
    discordMaxSegmentS: positiveInt(
      env,
      "QUORUM_DISCORD_MAX_SEGMENT_S",
      DEFAULTS.discordMaxSegmentS,
    ),
    discordJoinTimeoutS: positiveInt(
      env,
      "QUORUM_DISCORD_JOIN_TIMEOUT_S",
      DEFAULTS.discordJoinTimeoutS,
    ),
    discordRequestTtlS: positiveInt(
      env,
      "QUORUM_DISCORD_REQUEST_TTL_S",
      DEFAULTS.discordRequestTtlS,
    ),
    transcribeTimeoutMs: positiveInt(
      env,
      "QUORUM_TRANSCRIBE_TIMEOUT_MS",
      DEFAULTS.transcribeTimeoutMs,
    ),
    logLevel: optional(env, "QUORUM_LOG_LEVEL"),
  };
}

/**
 * Reads a secret from a file hive wrote, trimming the trailing newline, and registers it with the
 * logger's redaction list. Throws platform_unavailable when the file is unset, missing or empty.
 */
export function readSecretFile(path: string | undefined, what: string): string {
  if (!path) {
    throw new QuorumError("platform_unavailable", `${what} is not configured`);
  }
  let value: string;
  try {
    value = readFileSync(path, "utf8").trim();
  } catch {
    throw new QuorumError("platform_unavailable", `${what} file cannot be read`);
  }
  if (!value) {
    throw new QuorumError("platform_unavailable", `${what} file is empty`);
  }
  addSecret(value);
  return value;
}
