import { readFileSync } from "node:fs";
import { addSecret } from "./log.js";
import { QuorumError } from "./errors.js";
import { DEFAULT_ZOOM_HOSTED_DOMAINS, parseHostedZoomList } from "./urls.js";

/**
 * Runtime configuration, read once from the environment. Every numeric limit is an env var with
 * the default shown in DEFAULTS (docs/contract.md: "Every numeric limit in this file is an env var
 * with the default shown"). Secrets are never held here: only the paths of the files hive writes
 * them to, read on use so hive can rotate a key without restarting quorum.
 */

/**
 * Words a meeting with hive's attendant says that Whisper mishears without a hint ("pull request"
 * as "full requests", "Betty leave" as "Betty Lee", "hive queue" as "high school", "Kubernetes"
 * as "Cuba needs"), the hive's repository names and the project's vocabulary. Sent with
 * every transcription request as prompt and hotwords; QUORUM_TRANSCRIBE_HOTWORDS replaces it.
 * Order matters: Whisper weighs the first hints most, and with "leave" anywhere but right after
 * the name, "Betty leave." comes back as "Betty Lee".
 */
export const DEFAULT_TRANSCRIBE_HOTWORDS =
  "Betty, leave, hive, hive queue, pull request, PR, issue, board pressure, crux, dibs, docs, " +
  "homebrew-hive, hotshot, pluk, promptargs, rationguard, quorum, vexa, quorum-companion, " +
  "Kubernetes, KubeCon, CNCF, Spektacular, Spek, Plaud, RFC, inbox, spoke, hub";

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
  discordSilenceMs: 500,
  discordMinSegmentMs: 300,
  discordMaxSegmentS: 30,
  discordVadThreshold: 500,
  discordJoinTimeoutS: 20,
  discordRequestTtlS: 300,
  transcribeTimeoutMs: 60_000,
  transcribeMaxAttempts: 4,
  transcribeBackoffBaseMs: 250,
  transcribeBackoffMaxMs: 4000,
  ttsVoice: "af_heart",
  ttsTimeoutMs: 30_000,
  ttsCacheMaxBytes: 33_554_432,
  leaveDrainTimeoutMs: 8000,
  sayPrewarmMaxLines: 32,
  chatConfirmTimeoutMs: 30_000,
  chatConfirmPollMs: 500,
  sayConfirmTimeoutMs: 60_000,
  sayPollMs: 200,
  companionMaxChunkBytes: 131_072,
  companionSilenceMs: 500,
  companionEarlyMs: 100,
  companionMinSpeechMs: 300,
  companionMaxSegmentS: 20,
  companionVadThreshold: 500,
  companionOutboxMax: 200,
  companionConnectedMs: 5000,
  companionToneTtlMs: 4000,
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
  /** Vocabulary for the transcription prompt and hotwords (QUORUM_TRANSCRIBE_HOTWORDS, comma-separated). */
  transcribeHotwords: string[];
  /**
   * Hostnames accepted as Zoom fronted on an organisation's domain (QUORUM_ZOOM_HOSTED_DOMAINS,
   * comma-separated; "*.x" or ".x" also matches subdomains). Empty turns the branch off.
   */
  zoomHostedDomains: string[];
  ttsUrl: string | undefined;
  ttsTokenFile: string | undefined;
  ttsVoice: string;
  ttsTimeoutMs: number;
  /** Most synthesized speech kept for reuse (QUORUM_TTS_CACHE_MAX_BYTES; 24 kHz mono PCM). */
  ttsCacheMaxBytes: number;
  /** Longest a leave waits for speech and chat already on their way (QUORUM_LEAVE_DRAIN_TIMEOUT_MS). */
  leaveDrainTimeoutMs: number;
  /** Most lines one say.prewarm call may name (QUORUM_SAY_PREWARM_MAX_LINES). */
  sayPrewarmMaxLines: number;
  chatMaxChars: number;
  chatConfirmTimeoutMs: number;
  chatConfirmPollMs: number;
  sayConfirmTimeoutMs: number;
  sayMaxChars: number;
  /** How often a spoken line's playback record is read on Vexa (QUORUM_SAY_POLL_MS). */
  sayPollMs: number;
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
  /** Frame RMS (int16 scale) a Discord segment's speech must reach; quieter edges are trimmed. */
  discordVadThreshold: number;
  discordJoinTimeoutS: number;
  discordRequestTtlS: number;
  transcribeTimeoutMs: number;
  transcribeMaxAttempts: number;
  transcribeBackoffBaseMs: number;
  transcribeBackoffMaxMs: number;
  companionMaxChunkBytes: number;
  companionSilenceMs: number;
  /** Silence after speech at which an open utterance is transcribed ahead of its end; 0 turns it off. */
  companionEarlyMs: number;
  companionMinSpeechMs: number;
  companionMaxSegmentS: number;
  companionVadThreshold: number;
  companionOutboxMax: number;
  /** A companion that fetched its outbox this recently is connected and can play the tone. */
  companionConnectedMs: number;
  /** A listening tone the companion has not fetched this long after it was asked for is dropped. */
  companionToneTtlMs: number;
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

function nonNegativeInt(env: Env, name: string, fallback: number): number {
  const raw = optional(env, name);
  if (raw === undefined) {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
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

/** Unset: the default allowlist. Set but empty: the hosted-Zoom branch is off. */
function hostedZoomDomains(env: Env): string[] {
  const raw = env["QUORUM_ZOOM_HOSTED_DOMAINS"];
  if (raw === undefined) {
    return [...DEFAULT_ZOOM_HOSTED_DOMAINS];
  }
  try {
    return parseHostedZoomList(raw);
  } catch (err) {
    throw new Error(`QUORUM_ZOOM_HOSTED_DOMAINS: ${(err as Error).message}`, { cause: err });
  }
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
    transcribeHotwords: (optional(env, "QUORUM_TRANSCRIBE_HOTWORDS") ?? DEFAULT_TRANSCRIBE_HOTWORDS)
      .split(",")
      .map((w) => w.trim())
      .filter(Boolean),
    zoomHostedDomains: hostedZoomDomains(env),
    ttsUrl: optional(env, "QUORUM_TTS_URL")?.replace(/\/+$/, ""),
    ttsTokenFile: optional(env, "QUORUM_TTS_TOKEN_FILE"),
    ttsVoice: optional(env, "QUORUM_TTS_VOICE") ?? DEFAULTS.ttsVoice,
    ttsTimeoutMs: positiveInt(env, "QUORUM_TTS_TIMEOUT_MS", DEFAULTS.ttsTimeoutMs),
    ttsCacheMaxBytes: positiveInt(env, "QUORUM_TTS_CACHE_MAX_BYTES", DEFAULTS.ttsCacheMaxBytes),
    leaveDrainTimeoutMs: nonNegativeInt(
      env,
      "QUORUM_LEAVE_DRAIN_TIMEOUT_MS",
      DEFAULTS.leaveDrainTimeoutMs,
    ),
    sayPrewarmMaxLines: positiveInt(
      env,
      "QUORUM_SAY_PREWARM_MAX_LINES",
      DEFAULTS.sayPrewarmMaxLines,
    ),
    chatMaxChars: positiveInt(env, "QUORUM_CHAT_MAX_CHARS", DEFAULTS.chatMaxChars),
    chatConfirmTimeoutMs: positiveInt(
      env,
      "QUORUM_CHAT_CONFIRM_TIMEOUT_MS",
      DEFAULTS.chatConfirmTimeoutMs,
    ),
    chatConfirmPollMs: positiveInt(env, "QUORUM_CHAT_CONFIRM_POLL_MS", DEFAULTS.chatConfirmPollMs),
    sayConfirmTimeoutMs: positiveInt(
      env,
      "QUORUM_SAY_CONFIRM_TIMEOUT_MS",
      DEFAULTS.sayConfirmTimeoutMs,
    ),
    sayMaxChars: positiveInt(env, "QUORUM_SAY_MAX_CHARS", DEFAULTS.sayMaxChars),
    sayPollMs: positiveInt(env, "QUORUM_SAY_POLL_MS", DEFAULTS.sayPollMs),
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
    discordVadThreshold: positiveInt(
      env,
      "QUORUM_DISCORD_VAD_THRESHOLD",
      DEFAULTS.discordVadThreshold,
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
    transcribeMaxAttempts: positiveInt(
      env,
      "QUORUM_TRANSCRIBE_MAX_ATTEMPTS",
      DEFAULTS.transcribeMaxAttempts,
    ),
    transcribeBackoffBaseMs: positiveInt(
      env,
      "QUORUM_TRANSCRIBE_BACKOFF_BASE_MS",
      DEFAULTS.transcribeBackoffBaseMs,
    ),
    transcribeBackoffMaxMs: positiveInt(
      env,
      "QUORUM_TRANSCRIBE_BACKOFF_MAX_MS",
      DEFAULTS.transcribeBackoffMaxMs,
    ),
    companionMaxChunkBytes: positiveInt(
      env,
      "QUORUM_COMPANION_MAX_CHUNK_BYTES",
      DEFAULTS.companionMaxChunkBytes,
    ),
    companionSilenceMs: positiveInt(
      env,
      "QUORUM_COMPANION_SILENCE_MS",
      DEFAULTS.companionSilenceMs,
    ),
    companionEarlyMs: nonNegativeInt(env, "QUORUM_COMPANION_EARLY_MS", DEFAULTS.companionEarlyMs),
    companionMinSpeechMs: positiveInt(
      env,
      "QUORUM_COMPANION_MIN_SPEECH_MS",
      DEFAULTS.companionMinSpeechMs,
    ),
    companionMaxSegmentS: positiveInt(
      env,
      "QUORUM_COMPANION_MAX_SEGMENT_S",
      DEFAULTS.companionMaxSegmentS,
    ),
    companionVadThreshold: positiveInt(
      env,
      "QUORUM_COMPANION_VAD_THRESHOLD",
      DEFAULTS.companionVadThreshold,
    ),
    companionOutboxMax: positiveInt(
      env,
      "QUORUM_COMPANION_OUTBOX_MAX",
      DEFAULTS.companionOutboxMax,
    ),
    companionConnectedMs: positiveInt(
      env,
      "QUORUM_COMPANION_CONNECTED_MS",
      DEFAULTS.companionConnectedMs,
    ),
    companionToneTtlMs: positiveInt(
      env,
      "QUORUM_COMPANION_TONE_TTL_MS",
      DEFAULTS.companionToneTtlMs,
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
