import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Readable } from "node:stream";
import type {
  AudioPlayerLike,
  ChannelLike,
  ClientOptions,
  ClientLike,
  DiscordRuntime,
  GuildLike,
  InteractionLike,
  MemberLike,
  MessageLike,
  VoiceConnectionLike,
} from "../../src/discord/types.js";

export const STATUS = {
  Ready: "ready",
  Disconnected: "disconnected",
  Destroyed: "destroyed",
  Signalling: "signalling",
  Connecting: "connecting",
};

export class FakeChannel implements ChannelLike {
  sent: string[] = [];
  sendError: Error | undefined;
  joinable = true;
  voice = true;
  readonly members = new Map<string, MemberLike>();
  constructor(public id: string) {}
  isVoiceBased(): boolean {
    return this.voice;
  }
  async send(text: string): Promise<unknown> {
    if (this.sendError) throw this.sendError;
    this.sent.push(text);
    return {};
  }
}

export class FakeGuild implements GuildLike {
  readonly channelsById = new Map<string, FakeChannel>();
  commandSets: unknown[][] = [];
  commandError: Error | undefined;
  voiceAdapterCreator = { fake: true };
  constructor(public id: string) {}
  channels = {
    fetch: async (id: string) => this.channelsById.get(id) ?? null,
  };
  commands = {
    set: async (c: unknown[]) => {
      if (this.commandError) throw this.commandError;
      this.commandSets.push(c);
      return c;
    },
  };
}

export const PLAYER_IDLE = "idle";

/** Records each resource it is given; a test finishes a clip with `finish()`. */
export class FakePlayer extends EventEmitter implements AudioPlayerLike {
  readonly played: Readable[] = [];
  stops = 0;
  playError: Error | undefined;
  play(resource: unknown): void {
    if (this.playError) throw this.playError;
    this.played.push(resource as Readable);
  }
  stop(): boolean {
    this.stops += 1;
    this.emit(PLAYER_IDLE);
    return true;
  }
  finish(): void {
    this.emit(PLAYER_IDLE);
  }
}

/** Reads every packet of an object-mode resource stream. */
export async function packets(stream: Readable): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for await (const p of stream) out.push(p as Buffer);
  return out;
}

export class FakeConnection extends EventEmitter implements VoiceConnectionLike {
  destroyed = false;
  readonly players: AudioPlayerLike[] = [];
  joinOpts: { selfMute: boolean } | undefined;
  subscribe(player: AudioPlayerLike): unknown {
    this.players.push(player);
    return {};
  }
  readonly speaking = new EventEmitter();
  readonly streams = new Map<string, EventEmitter>();
  readonly subscribeOpts: unknown[] = [];
  receiver = {
    speaking: this.speaking,
    subscribe: (userId: string, opts: { end: { behavior: number; duration: number } }) => {
      this.subscribeOpts.push(opts);
      const s = new EventEmitter();
      this.streams.set(userId, s);
      return s;
    },
  };
  destroy(): void {
    this.destroyed = true;
  }
}

export class FakeClient extends EventEmitter implements ClientLike {
  guildMap = new Map<string, FakeGuild>();
  user = { id: "424242" };
  opts: ClientOptions | undefined;
  /** Act like Discord refusing the MessageContent intent: close 4014 instead of ready. */
  rejectIntents = false;
  appCommands: unknown[][] = [];
  loginToken: string | undefined;
  destroyed = false;
  loginError: Error | undefined;
  guilds = {
    fetch: async (id: string) => {
      const g = this.guildMap.get(id);
      if (!g) throw new Error("Unknown Guild");
      return g;
    },
    cache: {
      get size() {
        return 0;
      },
      values: () => this.guildMap.values(),
    },
  };
  application = {
    commands: {
      set: async (c: unknown[]) => {
        this.appCommands.push(c);
        return c;
      },
    },
  };
  async login(token: string): Promise<unknown> {
    if (this.loginError) throw this.loginError;
    this.loginToken = token;
    if (this.rejectIntents && this.opts?.messageContent) {
      setImmediate(() => this.emit("shardDisconnect", { code: 4014 }, 0));
      return token;
    }
    setImmediate(() => this.emit("clientReady"));
    return token;
  }
  async destroy(): Promise<void> {
    this.destroyed = true;
  }
}

export interface FakeRuntime extends DiscordRuntime {
  client: FakeClient;
  clients: FakeClient[];
  connections: FakeConnection[];
  players: FakePlayer[];
  encoded: number;
  encodersFreed: number;
  readyError: boolean;
  recover: boolean;
  decodeError: boolean;
}

export function fakeRuntime(): FakeRuntime {
  const client = new FakeClient();
  const rt: FakeRuntime = {
    client,
    clients: [],
    connections: [],
    players: [],
    encoded: 0,
    encodersFreed: 0,
    readyError: false,
    recover: false,
    decodeError: false,
    // The first client is rt.client; a re-login (intent fallback) gets a fresh one with the same guilds.
    createClient: (opts) => {
      const c = rt.clients.length === 0 ? client : new FakeClient();
      if (c !== client) {
        c.guildMap = rt.client.guildMap;
      }
      c.opts = opts;
      rt.clients.push(c);
      rt.client = c;
      return c;
    },
    voice: {
      joinVoiceChannel: (opts) => {
        const c = new FakeConnection();
        c.joinOpts = opts;
        rt.connections.push(c);
        return c;
      },
      entersState: async (_t, status) => {
        if (status === STATUS.Ready && rt.readyError) throw new Error("timeout");
        if (status !== STATUS.Ready && !rt.recover) throw new Error("timeout");
        return undefined;
      },
      Status: STATUS,
      AfterSilence: 1,
      createAudioPlayer: () => {
        const p = new FakePlayer();
        rt.players.push(p);
        return p;
      },
      createOpusResource: (stream) => stream,
      PlayerIdle: PLAYER_IDLE,
    },
    createDecoder: () => ({
      decode: (p: Buffer) => {
        if (rt.decodeError) throw new Error("bad packet");
        return p;
      },
      delete: () => undefined,
    }),
    // Identity "encoder": a packet is the PCM frame itself, so tests can check what was played.
    createEncoder: () => ({
      encode: (pcm: Buffer) => {
        rt.encoded += 1;
        return Buffer.from(pcm);
      },
      delete: () => {
        rt.encodersFreed += 1;
      },
    }),
  };
  return rt;
}

export function member(id: string, displayName: string, bot = false): MemberLike {
  return { id, displayName, user: { bot, username: displayName.toLowerCase() } };
}

export function interaction(opts: {
  sub: string;
  guildId?: string | null;
  channelId?: string | null;
  command?: string;
  chat?: boolean;
  userId?: string;
}): InteractionLike & { replies: { content: string; flags?: number }[] } {
  const replies: { content: string; flags?: number }[] = [];
  return {
    replies,
    isChatInputCommand: () => opts.chat ?? true,
    commandName: opts.command ?? "hive",
    options: { getSubcommand: () => opts.sub },
    guildId: opts.guildId === undefined ? "111111" : opts.guildId,
    member: {
      ...member(opts.userId ?? "900001", "Requester"),
      voice: { channelId: opts.channelId === undefined ? "222222" : opts.channelId },
    },
    user: { id: opts.userId ?? "900001", username: "requester" },
    reply: async (r) => {
      replies.push(r);
      return r;
    },
  };
}

/** 48 kHz stereo s16le PCM of the given length, as the fake decoder's output. */
export function pcm48(ms: number, value = 1000): Buffer {
  const frames = (48_000 * ms) / 1000;
  const b = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    b.writeInt16LE(value, i * 4);
    b.writeInt16LE(value, i * 4 + 2);
  }
  return b;
}

/** A fake transcription service: answers each POST with the next queued reply. */
export class FakeStt {
  bodies: { headers: Record<string, unknown>; body: Buffer }[] = [];
  replies: { status: number; body: unknown }[] = [];
  private server: Server | undefined;
  url = "";
  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        this.bodies.push({ headers: req.headers, body: Buffer.concat(chunks) });
        const r = this.replies.shift() ?? { status: 200, body: { text: "hello from discord" } };
        res.writeHead(r.status, { "Content-Type": "application/json" });
        res.end(typeof r.body === "string" ? r.body : JSON.stringify(r.body));
      });
    });
    await new Promise<void>((r) => this.server?.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server?.address() as AddressInfo).port}`;
  }
  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((r) => this.server?.close(() => r()));
  }
}

export function message(over: Partial<MessageLike> & { authorId?: string; bot?: boolean } = {}) {
  const { authorId = "500001", bot = false, ...rest } = over;
  const m: MessageLike = {
    channelId: "222222",
    guildId: "111111",
    content: "typed hello",
    createdTimestamp: Date.UTC(2026, 10, 16, 12, 0, 0),
    webhookId: null,
    author: { id: authorId, bot, username: "ana", globalName: "Ana G" },
    member: member(authorId, "Ana"),
    ...rest,
  };
  return m;
}

export interface TtsReply {
  status: number;
  body: Buffer | string;
  delayMs?: number;
}

/** A fake Kokoro: answers each POST /v1/audio/speech with the next queued reply. */
export class FakeTts {
  requests: { url: string; headers: Record<string, unknown>; body: Record<string, unknown> }[] = [];
  replies: TtsReply[] = [];
  /** Replies chosen by the request's `input`, ahead of the queue. */
  byInput = new Map<string, TtsReply>();
  private server: Server | undefined;
  url = "";
  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        this.requests.push({ url: req.url ?? "", headers: req.headers, body });
        const r = this.byInput.get(String(body.input)) ??
          this.replies.shift() ?? { status: 200, body: pcm24([0, 1000, 2000, 3000]) };
        setTimeout(() => {
          res.writeHead(r.status, { "Content-Type": "application/octet-stream" });
          res.end(r.body);
        }, r.delayMs ?? 0);
      });
    });
    await new Promise<void>((r) => this.server?.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server?.address() as AddressInfo).port}`;
  }
  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((r) => this.server?.close(() => r()));
  }
}

/** 24 kHz mono s16le PCM from sample values. */
export function pcm24(values: number[]): Buffer {
  const b = Buffer.alloc(values.length * 2);
  values.forEach((v, i) => b.writeInt16LE(v, i * 2));
  return b;
}
