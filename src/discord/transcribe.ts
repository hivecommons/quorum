import { QuorumError } from "../errors.js";

/**
 * Client for the shared CPU transcription service (hivecommons/vexa
 * core/meetings/services/transcription): OpenAI-compatible `POST /v1/audio/transcriptions`,
 * multipart, auth by `X-API-Key` when the service has an API_TOKEN.
 *
 * The service takes a Whisper `prompt` (passed to faster-whisper as `initial_prompt`); it has no
 * `hotwords` field. Names the speakers are likely to say (the bot's own display name first) go in
 * the prompt so Whisper spells them instead of a sound-alike ("Betty", not "Eddie").
 *
 * The service sheds load with 503 (and Retry-After) while its worker is busy. A request answered
 * 429 or 5xx, or one that never got an answer, is retried with exponential backoff and jitter
 * before the caller drops the audio.
 */

const TRANSCRIPTIONS_PATH = "/v1/audio/transcriptions";
/** The service ignores `model` (it runs its own MODEL_SIZE) but the OpenAI form requires one. */
const MODEL = "whisper-1";
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR_MIN = 500;
const HTTP_SERVER_ERROR_MAX = 599;
const MS_PER_S = 1000;
/** Whisper reads at most about 224 prompt tokens; a few names never come near that. */
export const PROMPT_MAX_CHARS = 400;

export interface RetryPolicy {
  /** Total tries per segment, the first included (QUORUM_TRANSCRIBE_MAX_ATTEMPTS). */
  maxAttempts: number;
  /** Backoff before the second try; doubles each time (QUORUM_TRANSCRIBE_BACKOFF_BASE_MS). */
  backoffBaseMs: number;
  /** Ceiling on one backoff, Retry-After included (QUORUM_TRANSCRIBE_BACKOFF_MAX_MS). */
  backoffMaxMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 4,
  backoffBaseMs: 250,
  backoffMaxMs: 4000,
};

export interface TranscriberOptions {
  url: string;
  token: () => string | undefined;
  language?: string;
  timeoutMs: number;
  /** Extra names for every prompt (QUORUM_TRANSCRIBE_HOTWORDS), after the per-call hints. */
  hotwords?: string[];
  retry?: Partial<RetryPolicy>;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Uniform [0, 1); the jitter source. */
  random?: () => number;
}

export interface TranscribeOptions {
  /** Names to bias recognition toward, most important first (the bot's display name). */
  hints?: string[];
}

export function transcriptionsUrl(base: string): string {
  const trimmed = base.replace(/\/+$/, "");
  return trimmed.endsWith(TRANSCRIPTIONS_PATH) ? trimmed : trimmed + TRANSCRIPTIONS_PATH;
}

/**
 * The names a bot answers to: its display name and that name's first word ("Betty Bee from the
 * hive" is called "Betty"), deduplicated case-insensitively, order kept.
 */
export function nameHints(displayName: string | undefined): string[] {
  const name = (displayName ?? "").trim();
  if (!name) {
    return [];
  }
  const first = name.split(/\s+/)[0] ?? "";
  return dedupe([first, name]);
}

function dedupe(words: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of words.map((x) => x.trim()).filter(Boolean)) {
    const k = w.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(w);
    }
  }
  return out;
}

/** The Whisper prompt for these names, or undefined when there are none. */
export function buildPrompt(names: string[]): string | undefined {
  const words = dedupe(names);
  if (!words.length) {
    return undefined;
  }
  let prompt = "";
  for (const w of words) {
    const next = prompt ? `${prompt}, ${w}` : w;
    if (next.length + 1 > PROMPT_MAX_CHARS) {
      break;
    }
    prompt = next;
  }
  return prompt ? `${prompt}.` : undefined;
}

/** Whether an HTTP status is worth another try (busy, overloaded, or a server fault). */
export function isRetryableStatus(status: number): boolean {
  return (
    status === HTTP_TOO_MANY_REQUESTS ||
    (status >= HTTP_SERVER_ERROR_MIN && status <= HTTP_SERVER_ERROR_MAX)
  );
}

/** Retry-After in ms (delta seconds only; the service never sends a date), or undefined. */
function retryAfterMs(res: Response): number | undefined {
  const raw = res.headers.get("retry-after");
  const s = raw === null ? NaN : Number(raw);
  return Number.isFinite(s) && s >= 0 ? s * MS_PER_S : undefined;
}

class Retryable extends Error {
  constructor(
    message: string,
    readonly afterMs?: number,
  ) {
    super(message);
  }
}

export class Transcriber {
  private readonly fetchImpl: typeof fetch;
  private readonly retry: RetryPolicy;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(private readonly opts: TranscriberOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.retry = { ...DEFAULT_RETRY, ...opts.retry };
    this.retry.maxAttempts = Math.max(1, Math.floor(this.retry.maxAttempts));
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = opts.random ?? Math.random;
  }

  /** Backoff before try `attempt + 1`: full jitter over base * 2^(attempt-1), at least Retry-After. */
  backoffMs(attempt: number, afterMs?: number): number {
    const { backoffBaseMs, backoffMaxMs } = this.retry;
    const exp = Math.min(backoffMaxMs, backoffBaseMs * 2 ** (attempt - 1));
    const jittered = exp / 2 + this.random() * (exp / 2);
    return Math.min(backoffMaxMs, Math.max(jittered, afterMs ?? 0));
  }

  async transcribe(wav: Buffer, call: TranscribeOptions = {}): Promise<string> {
    const prompt = buildPrompt([...(call.hints ?? []), ...(this.opts.hotwords ?? [])]);
    const { maxAttempts } = this.retry;
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.once(wav, prompt);
      } catch (err) {
        if (!(err instanceof Retryable)) {
          throw err;
        }
        if (attempt >= maxAttempts) {
          throw new QuorumError(
            "upstream_error",
            `${err.message} (gave up after ${attempt} attempt${attempt === 1 ? "" : "s"})`,
          );
        }
        await this.sleep(this.backoffMs(attempt, err.afterMs));
      }
    }
  }

  private async once(wav: Buffer, prompt: string | undefined): Promise<string> {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "audio.wav");
    form.append("model", MODEL);
    form.append("temperature", "0");
    form.append("response_format", "json");
    if (this.opts.language) {
      form.append("language", this.opts.language);
    }
    if (prompt) {
      form.append("prompt", prompt);
    }
    const headers: Record<string, string> = {};
    const token = this.opts.token();
    if (token) {
      headers["X-API-Key"] = token;
    }
    let res: Response;
    try {
      res = await this.fetchImpl(transcriptionsUrl(this.opts.url), {
        method: "POST",
        body: form,
        headers,
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch {
      throw new Retryable("transcription service unreachable or timed out");
    }
    if (!res.ok) {
      const message = `transcription service answered ${res.status}`;
      if (isRetryableStatus(res.status)) {
        throw new Retryable(message, retryAfterMs(res));
      }
      throw new QuorumError("upstream_error", message);
    }
    const body = (await res.json().catch(() => ({}))) as { text?: unknown };
    return typeof body.text === "string" ? body.text.trim() : "";
  }
}
