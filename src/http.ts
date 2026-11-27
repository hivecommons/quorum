import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ChunkGapError, isCompanionChannel, type CompanionAdapter } from "./companion/adapter.js";
import type { Config } from "./config.js";
import { QuorumError } from "./errors.js";
import type { Logger } from "./log.js";
import type { Metrics } from "./metrics.js";
import type { QuorumEvent, StateEvent } from "./meeting.js";
import { createMcpServer } from "./mcp.js";
import type { Quorum } from "./service.js";
import { CONTRACT_VERSION, VERSION } from "./version.js";

/**
 * The loopback HTTP surface: `GET /healthz` (no auth), `POST /mcp` (MCP streamable HTTP,
 * stateless, JSON responses), `GET /events` (Server-Sent Events), `GET /metrics` (Prometheus
 * text), and the companion platform's
 * `POST /companion/audio` and `GET /companion/outbox`. Everything except /healthz needs
 * `Authorization: Bearer <token>`.
 */

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_METHOD_NOT_ALLOWED = 405;
const HTTP_CONFLICT = 409;
const HTTP_TOO_LARGE = 413;
const HTTP_INTERNAL = 500;
const MS_PER_S = 1000;
const SSE_RETRY_MS = 2000;

function digest(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

/** Constant-time bearer check: both sides are hashed first so lengths never leak. */
export function bearerMatches(header: string | undefined, token: string): boolean {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? "");
  const presented = m?.[1]?.trim() ?? "";
  const ok = timingSafeEqual(digest(presented), digest(token));
  return ok && presented.length > 0;
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

class BodyTooLarge extends Error {}

/** Reads the whole body; past `limit` the rest is drained (so the reply reaches the client). */
async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size <= limit) {
      chunks.push(buf);
    }
  }
  if (size > limit) {
    throw new BodyTooLarge();
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const text = (await readBody(req, limit)).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

/** A query parameter as a non-negative integer, or undefined when absent or malformed. */
function nonNegativeInt(raw: string | null): number | undefined {
  if (raw === null || !/^\d+$/.test(raw)) {
    return undefined;
  }
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : undefined;
}

export interface HttpOptions {
  quorum: Quorum;
  config: Config;
  log: Logger;
  token: string;
  companion?: CompanionAdapter;
  metrics?: Metrics;
}

export function createHttpServer(opts: HttpOptions): Server {
  const { quorum, config, log, token, companion, metrics } = opts;

  async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      sendJson(
        res,
        HTTP_METHOD_NOT_ALLOWED,
        {
          jsonrpc: "2.0",
          error: { code: -32000, message: "quorum serves stateless MCP: POST only" },
          id: null,
        },
        { Allow: "POST" },
      );
      return;
    }
    let body: unknown;
    try {
      body = await readJson(req, config.maxBodyBytes);
    } catch (err) {
      const tooLarge = err instanceof BodyTooLarge;
      sendJson(res, tooLarge ? HTTP_TOO_LARGE : HTTP_BAD_REQUEST, {
        jsonrpc: "2.0",
        error: { code: -32700, message: tooLarge ? "request body too large" : "parse error" },
        id: null,
      });
      return;
    }
    const server = createMcpServer(quorum, log, metrics);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  function handleEvents(req: IncomingMessage, res: ServerResponse, url: URL): void {
    if (req.method !== "GET") {
      sendJson(res, HTTP_METHOD_NOT_ALLOWED, { error: "GET only" }, { Allow: "GET" });
      return;
    }
    const meetingId = url.searchParams.get("meeting_id") || undefined;
    const afterRaw = url.searchParams.get("after_seq");
    const afterSeq = afterRaw === null ? undefined : nonNegativeInt(afterRaw);
    if (afterRaw !== null && afterSeq === undefined) {
      sendJson(res, HTTP_BAD_REQUEST, { error: "after_seq must be a non-negative integer" });
      return;
    }
    const registry = quorum.registry;
    const meeting = meetingId ? registry.get(meetingId) : undefined;
    if (meetingId && !meeting) {
      sendJson(res, HTTP_NOT_FOUND, { error: `no meeting ${meetingId}` });
      return;
    }
    res.writeHead(HTTP_OK, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(`retry: ${SSE_RETRY_MS}\n\n`);
    const write = (e: QuorumEvent): void => {
      const id = "seq" in e ? `id: ${e.seq}\n` : "";
      res.write(`${id}data: ${JSON.stringify(e)}\n\n`);
    };
    const current = (m: {
      id: string;
      state: StateEvent["state"];
      reason: string | undefined;
    }): StateEvent => ({
      type: "state",
      meeting_id: m.id,
      state: m.state,
      ...(m.reason ? { reason: m.reason } : {}),
    });

    let unsubscribe: () => void;
    if (meeting) {
      write(current(meeting));
      if (afterSeq !== undefined) {
        meeting.replayAfter(afterSeq).forEach(write);
      }
      unsubscribe = meeting.onEvent(write);
    } else {
      for (const m of registry.all().filter((x) => !x.terminal)) {
        write(
          m.state === "requested" && m.platform === "discord"
            ? { ...current(m), platform: "discord", guild_id: m.guildId, channel_id: m.channelId }
            : current(m),
        );
      }
      unsubscribe = registry.onEvent(write);
    }
    const offRemoved = registry.onRemoved((id) => {
      if (meeting && id === meeting.id) {
        res.end();
      }
    });
    const heartbeat = setInterval(() => res.write(": ping\n\n"), config.sseHeartbeatS * MS_PER_S);
    res.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      offRemoved();
    });
  }

  /** The companion meeting a /companion request names, or undefined after answering an error. */
  function companionMeeting(res: ServerResponse, url: URL) {
    const meetingId = url.searchParams.get("meeting_id") ?? "";
    const meeting = meetingId ? quorum.registry.get(meetingId) : undefined;
    if (!meeting) {
      sendJson(res, HTTP_NOT_FOUND, { error: `no meeting ${meetingId}` });
      return undefined;
    }
    if (meeting.platform !== "companion") {
      sendJson(res, HTTP_BAD_REQUEST, { error: `meeting ${meetingId} is not a companion meeting` });
      return undefined;
    }
    return meeting;
  }

  function companionError(res: ServerResponse, err: unknown): void {
    if (err instanceof ChunkGapError) {
      sendJson(res, HTTP_CONFLICT, { error: err.message, expected_seq: err.expected });
    } else if (err instanceof BodyTooLarge) {
      sendJson(res, HTTP_TOO_LARGE, {
        error: `a chunk must be at most ${config.companionMaxChunkBytes} bytes`,
      });
    } else if (err instanceof QuorumError) {
      sendJson(res, err.code === "not_live" ? HTTP_CONFLICT : HTTP_BAD_REQUEST, {
        error: err.message,
        code: err.code,
      });
    } else {
      log.error("companion request failed", { error: String(err) });
      sendJson(res, HTTP_INTERNAL, { error: "internal error" });
    }
  }

  async function handleCompanionAudio(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    adapter: CompanionAdapter,
  ): Promise<void> {
    if (req.method !== "POST") {
      sendJson(res, HTTP_METHOD_NOT_ALLOWED, { error: "POST only" }, { Allow: "POST" });
      return;
    }
    const channel = url.searchParams.get("channel");
    if (!isCompanionChannel(channel)) {
      sendJson(res, HTTP_BAD_REQUEST, { error: "channel must be call or mic" });
      return;
    }
    const seq = nonNegativeInt(url.searchParams.get("seq"));
    if (seq === undefined) {
      sendJson(res, HTTP_BAD_REQUEST, { error: "seq must be a non-negative integer" });
      return;
    }
    const meeting = companionMeeting(res, url);
    if (!meeting) {
      return;
    }
    try {
      const body = await readBody(req, config.companionMaxChunkBytes);
      sendJson(res, HTTP_OK, adapter.audio(meeting, channel, seq, body));
    } catch (err) {
      companionError(res, err);
    }
  }

  function handleCompanionOutbox(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    adapter: CompanionAdapter,
  ): void {
    if (req.method !== "GET") {
      sendJson(res, HTTP_METHOD_NOT_ALLOWED, { error: "GET only" }, { Allow: "GET" });
      return;
    }
    const afterRaw = url.searchParams.get("after");
    const after = afterRaw === null ? 0 : nonNegativeInt(afterRaw);
    if (after === undefined) {
      sendJson(res, HTTP_BAD_REQUEST, { error: "after must be a non-negative integer" });
      return;
    }
    const meeting = companionMeeting(res, url);
    if (!meeting) {
      return;
    }
    try {
      sendJson(res, HTTP_OK, adapter.outbox(meeting, after));
    } catch (err) {
      companionError(res, err);
    }
  }

  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://quorum.local");
    if (url.pathname === "/healthz") {
      sendJson(res, HTTP_OK, { ok: true, version: VERSION, contract: CONTRACT_VERSION });
      return;
    }
    if (!bearerMatches(req.headers.authorization, token)) {
      sendJson(res, HTTP_UNAUTHORIZED, { error: "unauthorized" }, { "WWW-Authenticate": "Bearer" });
      return;
    }
    if (url.pathname === "/mcp") {
      handleMcp(req, res).catch((err: unknown) => {
        log.error("mcp request failed", { error: String(err) });
        if (!res.headersSent) {
          sendJson(res, HTTP_INTERNAL, {
            jsonrpc: "2.0",
            error: { code: -32603, message: "internal error" },
            id: null,
          });
        } else {
          res.end();
        }
      });
      return;
    }
    if (metrics && url.pathname === "/metrics") {
      if (req.method !== "GET") {
        sendJson(res, HTTP_METHOD_NOT_ALLOWED, { error: "GET only" }, { Allow: "GET" });
        return;
      }
      res.writeHead(HTTP_OK, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
      res.end(metrics.render());
      return;
    }
    if (url.pathname === "/events") {
      handleEvents(req, res, url);
      return;
    }
    if (companion && url.pathname === "/companion/audio") {
      void handleCompanionAudio(req, res, url, companion);
      return;
    }
    if (companion && url.pathname === "/companion/outbox") {
      handleCompanionOutbox(req, res, url, companion);
      return;
    }
    sendJson(res, HTTP_NOT_FOUND, { error: "not found" });
  });
}
