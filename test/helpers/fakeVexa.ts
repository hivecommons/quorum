import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";

/** A fake Vexa gateway: the REST routes quorum calls plus the /ws multiplex. */

export interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: unknown;
}

export interface FakeReply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

type Handler = (req: RecordedRequest) => FakeReply | undefined;

export interface FakeRow {
  id: number;
  platform: string;
  native_meeting_id: string;
  status: string;
  completion_reason?: string | null;
  failure_stage?: string | null;
}

export class FakeVexa {
  readonly requests: RecordedRequest[] = [];
  readonly rows: FakeRow[] = [];
  readonly sockets = new Set<WebSocket>();
  readonly subscribeFrames: unknown[] = [];
  readonly wsHeaders: IncomingMessage["headers"][] = [];
  apiKey = "vexa-test-key";
  /** When set, the /ws upgrade sends this error frame and closes with code 4401. */
  rejectWs = false;
  private overrides: { method: string; path: RegExp; handler: Handler }[] = [];
  private nextId = 100;
  private server: Server | undefined;
  private wss: WebSocketServer | undefined;
  url = "";

  on(method: string, path: RegExp, handler: Handler | FakeReply): void {
    this.overrides.unshift({
      method,
      path,
      handler: typeof handler === "function" ? handler : () => handler,
    });
  }

  reset(): void {
    this.overrides = [];
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    this.wss = new WebSocketServer({ server: this.server, path: "/ws" });
    this.wss.on("connection", (ws, req) => {
      this.wsHeaders.push(req.headers);
      if (this.rejectWs || req.headers["x-api-key"] !== this.apiKey) {
        ws.send(JSON.stringify({ type: "error", error: "invalid_api_key" }));
        ws.close(4401);
        return;
      }
      this.sockets.add(ws);
      ws.on("close", () => this.sockets.delete(ws));
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString()) as { action?: string; meetings?: unknown[] };
        this.subscribeFrames.push(msg);
        if (msg.action === "subscribe") {
          ws.send(JSON.stringify({ type: "subscribed", meetings: msg.meetings }));
        }
      });
    });
    await new Promise<void>((r) => this.server?.listen(0, "127.0.0.1", r));
    const { port } = this.server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    for (const ws of this.sockets) ws.terminate();
    this.wss?.close();
    this.server?.closeAllConnections();
    await new Promise<void>((r) => this.server?.close(() => r()));
  }

  /** Sends a frame to every connected /ws client. */
  broadcast(frame: unknown): void {
    const text = typeof frame === "string" ? frame : JSON.stringify(frame);
    for (const ws of this.sockets) ws.send(text);
  }

  dropSockets(): void {
    for (const ws of this.sockets) ws.terminate();
  }

  async waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
    const start = Date.now();
    while (!pred()) {
      if (Date.now() - start > timeoutMs) throw new Error("timed out waiting");
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString();
    const rec: RecordedRequest = {
      method: req.method ?? "GET",
      path: req.url ?? "/",
      headers: req.headers,
      body: text ? JSON.parse(text) : undefined,
    };
    this.requests.push(rec);
    const reply = this.reply(rec);
    res.writeHead(reply.status, { "Content-Type": "application/json", ...reply.headers });
    res.end(
      reply.body === undefined
        ? ""
        : typeof reply.body === "string"
          ? reply.body
          : JSON.stringify(reply.body),
    );
  }

  private reply(rec: RecordedRequest): FakeReply {
    if (rec.headers["x-api-key"] !== this.apiKey) {
      return { status: 401, body: { detail: "Invalid API key" } };
    }
    for (const o of this.overrides) {
      if (o.method === rec.method && o.path.test(rec.path)) {
        const r = o.handler(rec);
        if (r) return r;
      }
    }
    const path = rec.path.split("?")[0] ?? "";
    if (rec.method === "POST" && path === "/bots") {
      const b = rec.body as { platform: string; native_meeting_id: string; meeting_url?: string };
      // Vexa's meeting-api refusal (bot_spawn/router.py): it builds Meet and Teams URLs from the
      // id, but Zoom and Jitsi need the caller's meeting_url.
      if ((b.platform === "zoom" || b.platform === "jitsi") && !b.meeting_url) {
        return {
          status: 422,
          body: {
            detail: `unsupported platform '${b.platform}' without a meeting_url — use google_meet/teams, or provide meeting_url (required for zoom/jitsi)`,
          },
        };
      }
      const row: FakeRow = {
        id: this.nextId++,
        platform: b.platform,
        native_meeting_id: b.native_meeting_id,
        status: "requested",
      };
      this.rows.unshift(row);
      return { status: 201, body: row };
    }
    if (rec.method === "GET" && path === "/bots") {
      return { status: 200, body: { meetings: this.rows, has_more: false } };
    }
    let m = /^\/bots\/([^/]+)\/([^/]+)$/.exec(path);
    if (rec.method === "DELETE" && m) {
      const row = this.rows.find((r) => r.native_meeting_id === decodeURIComponent(m?.[2] ?? ""));
      if (!row) return { status: 404, body: { detail: "No active meeting" } };
      row.status = "stopping";
      return { status: 200, body: row };
    }
    m = /^\/bots\/([^/]+)\/([^/]+)\/chat$/.exec(path);
    if (rec.method === "POST" && m) {
      return {
        status: 200,
        body: { status: "queued", request_id: "req1", meeting_id: 1, native_meeting_id: m[2] },
      };
    }
    m = /^\/bots\/([^/]+)\/([^/]+)\/speak$/.exec(path);
    if (rec.method === "POST" && m) {
      return { status: 200, body: { status: "queued" } };
    }
    m = /^\/meetings\/([^/]+)\/([^/]+)$/.exec(path);
    if (rec.method === "DELETE" && m) {
      return { status: 200, body: { status: "deleted" } };
    }
    return { status: 404, body: { detail: "Not Found" } };
  }
}
