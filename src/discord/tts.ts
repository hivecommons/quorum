import { QuorumError } from "../errors.js";

/**
 * Client for the shared Kokoro TTS service: OpenAI-compatible `POST /v1/audio/speech` with
 * `response_format: "pcm"`, which answers raw 24 kHz 16-bit little-endian mono samples. Auth is
 * the `X-API-Key` header, the same one the Vexa bot sends (core/meetings/services/bot
 * tts-playback.ts).
 */

const SPEECH_PATH = "/v1/audio/speech";
/** Kokoro ignores `model` beyond accepting the OpenAI names; Vexa's bot sends this one too. */
const MODEL = "tts-1";
const MAX_DETAIL_CHARS = 200;

export interface TtsClientOptions {
  url: string;
  token: () => string | undefined;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export function speechUrl(base: string): string {
  const trimmed = base.replace(/\/+$/, "");
  return trimmed.endsWith(SPEECH_PATH) ? trimmed : trimmed + SPEECH_PATH;
}

export class TtsClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: TtsClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Synthesizes `text` and returns 24 kHz s16le mono PCM. Failures are `upstream_error`. */
  async synthesize(text: string, voice: string): Promise<Buffer> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const token = this.opts.token();
    if (token) {
      headers["X-API-Key"] = token;
    }
    let res: Response;
    let body: Buffer;
    try {
      res = await this.fetchImpl(speechUrl(this.opts.url), {
        method: "POST",
        headers,
        body: JSON.stringify({ model: MODEL, input: text, voice, response_format: "pcm" }),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
      body = Buffer.from(await res.arrayBuffer());
    } catch {
      throw new QuorumError("upstream_error", "TTS service unreachable or timed out");
    }
    if (!res.ok) {
      const detail = body.toString("utf8").slice(0, MAX_DETAIL_CHARS).trim();
      throw new QuorumError(
        "upstream_error",
        `TTS service answered ${res.status}${detail ? `: ${detail}` : ""}`,
      );
    }
    if (body.length === 0) {
      throw new QuorumError("upstream_error", "TTS service returned no audio");
    }
    return body;
  }
}
