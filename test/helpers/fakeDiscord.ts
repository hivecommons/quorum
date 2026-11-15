import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  ChannelLike,
  ClientLike,
  DiscordRuntime,
  GuildLike,
  InteractionLike,
  MemberLike,
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

export class FakeConnection extends EventEmitter implements VoiceConnectionLike {
  destroyed = false;
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
  readonly guildMap = new Map<string, FakeGuild>();
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
    setImmediate(() => this.emit("clientReady"));
    return token;
  }
  async destroy(): Promise<void> {
    this.destroyed = true;
  }
}

export interface FakeRuntime extends DiscordRuntime {
  client: FakeClient;
  connections: FakeConnection[];
  readyError: boolean;
  recover: boolean;
  decodeError: boolean;
}

export function fakeRuntime(): FakeRuntime {
  const client = new FakeClient();
  const rt: FakeRuntime = {
    client,
    connections: [],
    readyError: false,
    recover: false,
    decodeError: false,
    createClient: () => client,
    voice: {
      joinVoiceChannel: () => {
        const c = new FakeConnection();
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
    },
    createDecoder: () => ({
      decode: (p: Buffer) => {
        if (rt.decodeError) throw new Error("bad packet");
        return p;
      },
      delete: () => undefined,
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
