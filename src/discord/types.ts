import type { Readable } from "node:stream";

/**
 * The slice of discord.js and @discordjs/voice the adapter uses, as structural types. The real
 * libraries satisfy them (src/discord/runtime.ts); tests pass fakes.
 */

// Listener arguments differ per event, exactly as in node's EventEmitter typing.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Listener = (...args: any[]) => void;

export interface Emitter {
  on(event: string, listener: Listener): unknown;
  once(event: string, listener: Listener): unknown;
}

export interface MemberLike {
  id: string;
  displayName?: string;
  user: { bot: boolean; username?: string; globalName?: string | null };
}

export interface ChannelLike {
  id: string;
  joinable?: boolean;
  isVoiceBased(): boolean;
  members: { values(): Iterable<MemberLike>; get(id: string): MemberLike | undefined };
  send(text: string): Promise<unknown>;
}

export interface GuildLike {
  id: string;
  voiceAdapterCreator: unknown;
  channels: { fetch(id: string): Promise<ChannelLike | null> };
  commands: { set(commands: unknown[]): Promise<unknown> };
}

export interface VoiceStateLike {
  id: string;
  channelId: string | null;
  member?: MemberLike | null;
}

export interface InteractionLike {
  isChatInputCommand(): boolean;
  commandName: string;
  options: { getSubcommand(): string };
  guildId: string | null;
  member?: (MemberLike & { voice?: { channelId: string | null } }) | null;
  user: { id: string; username: string; globalName?: string | null };
  reply(opts: { content: string; flags?: number }): Promise<unknown>;
}

/** A message posted in a text channel, including a voice channel's built-in text chat. */
export interface MessageLike {
  channelId: string;
  guildId: string | null;
  content: string;
  createdTimestamp: number;
  webhookId?: string | null;
  author: { id: string; bot: boolean; username?: string; globalName?: string | null };
  member?: MemberLike | null;
}

export interface ClientLike extends Emitter {
  login(token: string): Promise<unknown>;
  user?: { id: string } | null;
  destroy(): Promise<void> | void;
  guilds: {
    fetch(id: string): Promise<GuildLike>;
    cache: { size: number; values(): Iterable<GuildLike> };
  };
  application: { commands: { set(commands: unknown[]): Promise<unknown> } } | null;
}

export type AudioStreamLike = Emitter;

export interface AudioPlayerLike extends Emitter {
  off(event: string, listener: Listener): unknown;
  play(resource: unknown): void;
  stop(force?: boolean): unknown;
}

export interface VoiceConnectionLike extends Emitter {
  subscribe(player: AudioPlayerLike): unknown;
  receiver: {
    speaking: Emitter;
    subscribe(
      userId: string,
      opts: { end: { behavior: number; duration: number } },
    ): AudioStreamLike;
  };
  destroy(): void;
}

export interface VoiceLib {
  joinVoiceChannel(opts: {
    guildId: string;
    channelId: string;
    adapterCreator: unknown;
    selfDeaf: boolean;
    selfMute: boolean;
  }): VoiceConnectionLike;
  entersState(target: VoiceConnectionLike, status: string, timeoutMs: number): Promise<unknown>;
  Status: {
    Ready: string;
    Disconnected: string;
    Destroyed: string;
    Signalling: string;
    Connecting: string;
  };
  AfterSilence: number;
  createAudioPlayer(): AudioPlayerLike;
  /** An audio resource reading 20 ms Opus packets (object mode) from `stream`. */
  createOpusResource(stream: Readable): unknown;
  /** AudioPlayerStatus.Idle: the player finished (or failed) its resource. */
  PlayerIdle: string;
}

export interface OpusDecoderLike {
  decode(packet: Buffer): Buffer;
  delete?(): void;
}

export interface OpusEncoderLike {
  /** Encodes one 20 ms frame of 48 kHz stereo s16le PCM. */
  encode(pcm: Buffer, frameSize: number): Buffer;
  delete?(): void;
}

export interface ClientOptions {
  /** Ask for the privileged MessageContent intent so typed chat can be read. */
  messageContent: boolean;
}

export interface DiscordRuntime {
  createClient(opts: ClientOptions): ClientLike;
  voice: VoiceLib;
  createDecoder(): OpusDecoderLike;
  createEncoder(): OpusEncoderLike;
}
