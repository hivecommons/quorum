import { QuorumError, type ErrorCode } from "../errors.js";

/**
 * REST client for the Vexa gateway (hivecommons/vexa core/gateway/contracts/api.v1). Auth is the
 * `X-API-Key` header; the key is read through `apiKey()` on every call so a rotated key file is
 * picked up without a restart.
 */

export interface VexaMeeting {
  id: number;
  platform?: string | null;
  native_meeting_id?: string | null;
  status: string;
  completion_reason?: string | null;
  failure_stage?: string | null;
  data?: Record<string, unknown> | null;
}

export interface CreateBotRequest {
  platform: string;
  native_meeting_id: string;
  bot_name?: string;
  passcode?: string;
  meeting_url?: string;
  teams_base_host?: string;
  recording_enabled?: boolean;
  voice_agent_enabled?: boolean;
  automatic_leave?: { max_wait_for_admission?: number };
}

export class VexaHttpError extends QuorumError {
  readonly status: number;
  readonly detail: string;

  constructor(code: ErrorCode, status: number, detail: string, message: string) {
    super(code, message);
    this.status = status;
    this.detail = detail;
  }
}

export interface VexaClientOptions {
  baseUrl: string;
  apiKey: () => string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

const HTTP_UNPROCESSABLE = 422;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_TOO_MANY = 429;
const MAX_DETAIL_CHARS = 300;
const LIST_LIMIT = 100;

/** Pulls a readable message out of a FastAPI error body ({detail: string | [{msg}]}). */
export function errorDetail(body: unknown, fallback: string): string {
  let detail: unknown = body;
  if (body && typeof body === "object" && "detail" in body) {
    detail = (body as { detail: unknown }).detail;
  }
  if (Array.isArray(detail)) {
    detail = detail
      .map((d: unknown) =>
        d && typeof d === "object" && "msg" in d ? String((d as { msg: unknown }).msg) : String(d),
      )
      .join("; ");
  } else if (detail && typeof detail === "object") {
    detail = JSON.stringify(detail);
  }
  const text = typeof detail === "string" && detail ? detail : fallback;
  return text.slice(0, MAX_DETAIL_CHARS);
}

/** Default mapping of a Vexa HTTP failure onto a contract error code. */
export function codeForStatus(status: number): ErrorCode {
  if (status === HTTP_BAD_REQUEST || status === HTTP_UNPROCESSABLE) {
    return "invalid_argument";
  }
  if (status === HTTP_NOT_FOUND) {
    return "not_found";
  }
  if (status === HTTP_TOO_MANY) {
    return "rate_limited";
  }
  return "upstream_error";
}

export class VexaClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: VexaClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get baseUrl(): string {
    return this.opts.baseUrl;
  }

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; data: T }> {
    const headers: Record<string, string> = { "X-API-Key": this.opts.apiKey() };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    let res: Response;
    try {
      res = await this.fetchImpl(this.opts.baseUrl + path, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (err) {
      const reason =
        err instanceof Error && err.name === "TimeoutError" ? "timed out" : "unreachable";
      throw new QuorumError("upstream_error", `Vexa ${method} ${routeOf(path)} ${reason}`);
    }
    const text = await res.text();
    let data: unknown = undefined;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!res.ok) {
      const detail = errorDetail(data, res.statusText || `HTTP ${res.status}`);
      let message = `Vexa ${method} ${routeOf(path)} answered ${res.status}: ${detail}`;
      if (res.status === HTTP_UNAUTHORIZED || res.status === HTTP_FORBIDDEN) {
        message = `Vexa refused the request (${res.status}): ${detail}`;
      }
      const retryAfter = res.headers.get("retry-after");
      if (res.status === HTTP_TOO_MANY && retryAfter) {
        message += ` (retry after ${retryAfter}s)`;
      }
      throw new VexaHttpError(codeForStatus(res.status), res.status, detail, message);
    }
    return { status: res.status, data: data as T };
  }

  async createBot(req: CreateBotRequest): Promise<VexaMeeting> {
    return (await this.request<VexaMeeting>("POST", "/bots", req)).data;
  }

  async stopBot(platform: string, nativeId: string): Promise<VexaMeeting | undefined> {
    return (await this.request<VexaMeeting | undefined>("DELETE", botPath(platform, nativeId)))
      .data;
  }

  async postChat(
    platform: string,
    nativeId: string,
    text: string,
  ): Promise<{ request_id?: string }> {
    const path = botPath(platform, nativeId) + "/chat";
    return (await this.request<{ request_id?: string }>("POST", path, { text })).data ?? {};
  }

  /**
   * The delivery record of one chat send (`GET /bots/{platform}/{native_id}/chat/{request_id}`):
   * `queued`, `posted`, `failed` with the bot's reason, or `unconfirmed`.
   */
  async chatStatus(
    platform: string,
    nativeId: string,
    requestId: string,
  ): Promise<{ status?: string; reason?: string }> {
    const path = botPath(platform, nativeId) + "/chat/" + encodeURIComponent(requestId);
    return (await this.request<{ status?: string; reason?: string }>("GET", path)).data ?? {};
  }

  async speak(platform: string, nativeId: string, text: string, voice?: string): Promise<void> {
    await this.request("POST", botPath(platform, nativeId) + "/speak", {
      text,
      ...(voice ? { voice } : {}),
    });
  }

  async deleteMeeting(platform: string, nativeId: string): Promise<void> {
    const path = `/meetings/${encodeURIComponent(platform)}/${encodeURIComponent(nativeId)}`;
    await this.request("DELETE", path);
  }

  /** The caller's most recent meetings on a platform, newest first. */
  async listBots(platform: string): Promise<VexaMeeting[]> {
    const path = `/bots?platform=${encodeURIComponent(platform)}&limit=${LIST_LIMIT}`;
    const { data } = await this.request<{ meetings?: VexaMeeting[] } | VexaMeeting[]>("GET", path);
    if (Array.isArray(data)) {
      return data;
    }
    return data?.meetings ?? [];
  }
}

export function botPath(platform: string, nativeId: string): string {
  return `/bots/${encodeURIComponent(platform)}/${encodeURIComponent(nativeId)}`;
}

/** The route template for a path, so error messages never carry meeting ids or passcodes. */
export function routeOf(path: string): string {
  const [base = ""] = path.split("?");
  return base
    .replace(/^\/(bots|meetings)\/[^/]+\/[^/]+/, "/$1/{platform}/{native_id}")
    .replace(/\/chat\/[^/]+$/, "/chat/{request_id}");
}

export const VEXA_STATUS = {
  HTTP_NOT_FOUND,
  HTTP_CONFLICT,
  HTTP_UNPROCESSABLE,
  HTTP_TOO_MANY,
} as const;
