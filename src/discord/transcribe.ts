import { QuorumError } from "../errors.js";

/**
 * Client for the shared CPU transcription service (hivecommons/vexa
 * core/meetings/services/transcription): OpenAI-compatible `POST /v1/audio/transcriptions`,
 * multipart, auth by `X-API-Key` when the service has an API_TOKEN.
 */

const TRANSCRIPTIONS_PATH = "/v1/audio/transcriptions";
/** The service ignores `model` (it runs its own MODEL_SIZE) but the OpenAI form requires one. */
const MODEL = "whisper-1";

export interface TranscriberOptions {
  url: string;
  token: () => string | undefined;
  language?: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export function transcriptionsUrl(base: string): string {
  const trimmed = base.replace(/\/+$/, "");
  return trimmed.endsWith(TRANSCRIPTIONS_PATH) ? trimmed : trimmed + TRANSCRIPTIONS_PATH;
}

export class Transcriber {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: TranscriberOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async transcribe(wav: Buffer): Promise<string> {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "audio.wav");
    form.append("model", MODEL);
    form.append("temperature", "0");
    form.append("response_format", "json");
    if (this.opts.language) {
      form.append("language", this.opts.language);
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
      throw new QuorumError("upstream_error", "transcription service unreachable or timed out");
    }
    if (!res.ok) {
      throw new QuorumError("upstream_error", `transcription service answered ${res.status}`);
    }
    const body = (await res.json().catch(() => ({}))) as { text?: unknown };
    return typeof body.text === "string" ? body.text.trim() : "";
  }
}
