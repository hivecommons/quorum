import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { Logger } from "../log.js";

/**
 * One multiplexed connection to the Vexa gateway `/ws` (ws.v1). Quorum subscribes each live
 * meeting by `{platform, native_id}` and receives `transcript`, `meeting.status` and
 * `chat_message` frames. The socket reconnects with capped exponential backoff and re-subscribes
 * everything on every reconnect; the API key is re-read on each connect.
 */

export type VexaFrame = Record<string, unknown> & { type?: unknown };

export interface VexaStreamOptions {
  baseUrl: string;
  apiKey: () => string;
  backoffMinMs: number;
  backoffMaxMs: number;
  log: Logger;
  pingIntervalMs?: number;
  random?: () => number;
}

const DEFAULT_PING_INTERVAL_MS = 30_000;
const JITTER_FLOOR = 0.5;

export function wsUrl(baseUrl: string): string {
  const u = new URL(baseUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = u.pathname.replace(/\/+$/, "") + "/ws";
  u.search = "";
  return u.toString();
}

/** Backoff for the nth consecutive failed attempt (0-based), jittered into [50%, 100%]. */
export function backoffDelay(
  attempt: number,
  minMs: number,
  maxMs: number,
  random: () => number,
): number {
  const ceiling = Math.min(maxMs, minMs * 2 ** attempt);
  return Math.round(ceiling * (JITTER_FLOOR + (1 - JITTER_FLOOR) * random()));
}

function key(platform: string, nativeId: string): string {
  return `${platform}\u0000${nativeId}`;
}

export class VexaStream extends EventEmitter {
  private ws: WebSocket | undefined;
  private readonly subs = new Map<string, { platform: string; native_id: string }>();
  private attempt = 0;
  private timer: NodeJS.Timeout | undefined;
  private pingTimer: NodeJS.Timeout | undefined;
  private stopped = true;
  private alive = false;

  constructor(private readonly opts: VexaStreamOptions) {
    super();
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get subscriptions(): number {
    return this.subs.size;
  }

  /** Connects if there is anything to subscribe to. Idempotent. */
  private ensure(): void {
    if (this.stopped) {
      this.stopped = false;
    }
    if (!this.ws && !this.timer) {
      this.connect();
    }
  }

  subscribe(platform: string, nativeId: string): void {
    const k = key(platform, nativeId);
    if (this.subs.has(k)) {
      return;
    }
    const sub = { platform, native_id: nativeId };
    this.subs.set(k, sub);
    if (this.connected) {
      this.send({ action: "subscribe", meetings: [sub] });
    } else {
      this.ensure();
    }
  }

  unsubscribe(platform: string, nativeId: string): void {
    const k = key(platform, nativeId);
    const sub = this.subs.get(k);
    if (!sub) {
      return;
    }
    this.subs.delete(k);
    if (this.connected) {
      this.send({ action: "unsubscribe", meetings: [sub] });
    }
    if (this.subs.size === 0) {
      this.stop();
    }
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    clearInterval(this.pingTimer);
    this.pingTimer = undefined;
    const ws = this.ws;
    this.ws = undefined;
    if (ws) {
      ws.removeAllListeners();
      ws.on("error", () => undefined);
      ws.terminate();
    }
  }

  private send(msg: unknown): void {
    this.ws?.send(JSON.stringify(msg));
  }

  private connect(): void {
    let apiKey: string;
    try {
      apiKey = this.opts.apiKey();
    } catch (err) {
      this.opts.log.warn("vexa ws: no API key, retrying", { error: (err as Error).message });
      this.schedule();
      return;
    }
    const ws = new WebSocket(wsUrl(this.opts.baseUrl), { headers: { "x-api-key": apiKey } });
    this.ws = ws;
    ws.on("open", () => {
      this.alive = true;
      this.opts.log.info("vexa ws connected", { subscriptions: this.subs.size });
      if (this.subs.size > 0) {
        this.send({ action: "subscribe", meetings: [...this.subs.values()] });
      }
      this.startPing(ws);
      this.emit("open");
    });
    ws.on("pong", () => {
      this.alive = true;
    });
    ws.on("message", (data) => {
      let frame: unknown;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        this.opts.log.warn("vexa ws: dropped a non-JSON frame");
        return;
      }
      if (frame && typeof frame === "object" && !Array.isArray(frame)) {
        if ((frame as VexaFrame).type !== "error") {
          this.attempt = 0;
        }
        this.emit("frame", frame as VexaFrame);
      }
    });
    ws.on("error", (err) => {
      this.opts.log.warn("vexa ws error", { error: err.message });
    });
    ws.on("close", (code) => {
      if (this.ws !== ws) {
        return;
      }
      this.ws = undefined;
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
      this.opts.log.warn("vexa ws closed", { code });
      this.emit("close", code);
      this.schedule();
    });
  }

  private startPing(ws: WebSocket): void {
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (!this.alive) {
        this.opts.log.warn("vexa ws: no pong, reconnecting");
        ws.terminate();
        return;
      }
      this.alive = false;
      ws.ping();
    }, this.opts.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS);
  }

  private schedule(): void {
    if (this.stopped || this.subs.size === 0) {
      return;
    }
    const delay = backoffDelay(
      this.attempt,
      this.opts.backoffMinMs,
      this.opts.backoffMaxMs,
      this.opts.random ?? Math.random,
    );
    this.attempt += 1;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.connect();
    }, delay);
  }
}
