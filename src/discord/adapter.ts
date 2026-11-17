import type { ChatDelivery, JoinArgs, PlatformAdapter, SayOutcome } from "../adapter.js";
import type { Config } from "../config.js";
import { QuorumError } from "../errors.js";
import type { Logger } from "../log.js";
import { Meeting, type Person, type Registry } from "../meeting.js";
import { Readable } from "node:stream";
import {
  encodeWav,
  OPUS_FRAME_MS,
  OPUS_FRAME_SAMPLES,
  concatSamples,
  pcmFrames,
  PLAYBACK_BYTES_PER_S,
  samplesMs,
  toMono16k,
  trimSilence,
  upsampleToStereo48k,
  Utterance,
} from "./audio.js";
import { SpeechSynth, splitSentences } from "./speech.js";
import { nameHints, type Transcriber } from "./transcribe.js";
import type { TtsClient } from "./tts.js";
import type {
  AudioPlayerLike,
  ChannelLike,
  ClientLike,
  DiscordRuntime,
  GuildLike,
  InteractionLike,
  MessageLike,
  VoiceConnectionLike,
  VoiceStateLike,
} from "./types.js";

/**
 * Discord voice through `@discordjs/voice` (DAVE end-to-end encryption via @snazzah/davey).
 * Each speaking user's Opus stream is decoded, cut at silence, sent to the shared Whisper
 * service and emitted as a final segment attributed to that Discord user. Typed lines in the voice
 * channel's built-in text chat become chat events; `say` is synthesized by the shared Kokoro TTS
 * service and played into the channel, one clip after another.
 */

const MS_PER_S = 1000;
/** Discord interaction flag for a reply only the invoking user sees. */
const EPHEMERAL = 64;
/** How long a dropped voice connection may take to recover before the meeting ends. */
const RECONNECT_GRACE_MS = 5000;
/** Extra time a clip may take past its own length before the queue moves on regardless. */
const PLAYBACK_GRACE_MS = 5000;
/** Gateway close code for a privileged intent the application has not enabled. */
const DISALLOWED_INTENTS_CLOSE = 4014;

/**
 * Discord permission bits (discord.js PermissionFlagsBits) the bot needs in a voice channel,
 * named the way the server settings name them so the owner can grant exactly what is missing.
 */
const PERMISSION_ADMINISTRATOR = 1n << 3n;
const VOICE_PERMISSIONS: ReadonlyArray<readonly [bigint, string]> = [
  [1n << 10n, "View Channel"],
  [1n << 20n, "Connect"],
];
const SPEAK_PERMISSION: readonly [bigint, string] = [1n << 21n, "Speak"];

export const HIVE_COMMAND = {
  name: "hive",
  description: "Ask hive to take notes in your voice channel",
  options: [
    { type: 1, name: "join", description: "Ask hive to join your current voice channel" },
    { type: 1, name: "leave", description: "Make hive leave the voice channel" },
  ],
};

interface Live {
  connection: VoiceConnectionLike;
  channel: ChannelLike;
  joinedAt: number;
  listening: Set<string>;
  names: Map<string, string>;
  /** Present when QUORUM_TTS_URL is set: plays queued speech into the channel. */
  player: AudioPlayerLike | undefined;
  /** Clips in `say` order; each resolves to 48 kHz stereo PCM, or undefined if synthesis failed. */
  clips: Promise<Buffer | undefined>[];
  playing: boolean;
  /** Settles when the queued speech has all played; undefined before the first clip. */
  drained?: Promise<void>;
  /** Per speaker: segments waiting for transcription, and whether one is being transcribed. */
  stt: Map<string, SpeakerQueue>;
}

interface PendingSegment {
  samples: Int16Array;
  startMs: number;
  endMs: number;
}

interface SpeakerQueue {
  pending: PendingSegment[];
  running: boolean;
}

export interface DiscordAdapterOptions {
  runtime: DiscordRuntime;
  registry: Registry;
  log: Logger;
  config: Config;
  transcriber: Transcriber | undefined;
  tts?: TtsClient | undefined;
  now?: () => number;
}

class DisallowedIntentsError extends Error {}

/** Whether a login failure means Discord refused the privileged MessageContent intent. */
export function isDisallowedIntents(err: unknown): boolean {
  if (err instanceof DisallowedIntentsError) return true;
  const e = err as { code?: unknown; message?: unknown } | null;
  return (
    e?.code === DISALLOWED_INTENTS_CLOSE ||
    e?.code === "DisallowedIntents" ||
    /disallowed intents|privileged intent/i.test(String(e?.message ?? ""))
  );
}

function nameOf(
  member:
    { displayName?: string; user?: { username?: string; globalName?: string | null } } | undefined,
  id: string,
): string {
  return member?.displayName || member?.user?.globalName || member?.user?.username || `user ${id}`;
}

export class DiscordAdapter implements PlatformAdapter {
  private client: ClientLike;
  private readonly live = new Map<string, Live>();
  private readonly requestTimers = new Map<string, NodeJS.Timeout>();
  private ready = false;
  private readonly now: () => number;
  /** Synthesis with the clip cache, shared by every meeting; undefined without QUORUM_TTS_URL. */
  private readonly synth: SpeechSynth | undefined;

  constructor(private readonly opts: DiscordAdapterOptions) {
    this.client = opts.runtime.createClient({ messageContent: true });
    this.now = opts.now ?? Date.now;
    this.synth = opts.tts ? new SpeechSynth(opts.tts, opts.config.ttsCacheMaxBytes) : undefined;
  }

  get isReady(): boolean {
    return this.ready;
  }

  /**
   * Logs in and registers the /hive command. Resolves once the client is ready. Typed chat needs
   * the privileged MessageContent intent; when Discord refuses it, quorum logs that once and logs
   * in again without it, so voice keeps working and only typed chat is lost.
   */
  async start(token: string): Promise<void> {
    try {
      await this.connect(token);
    } catch (err) {
      if (!isDisallowedIntents(err)) throw err;
      this.opts.log.warn(
        "discord: the MessageContent intent is not enabled for this bot; typed chat is off. " +
          "Enable it under Bot > Privileged Gateway Intents in the Discord developer portal.",
      );
      await this.client.destroy();
      this.client = this.opts.runtime.createClient({ messageContent: false });
      await this.connect(token);
    }
    this.ready = true;
    await this.registerCommands();
    this.opts.log.info("discord connected", { guilds: this.client.guilds.cache.size });
  }

  private connect(token: string): Promise<void> {
    const client = this.client;
    client.on("interactionCreate", (i: InteractionLike) => {
      void this.onInteraction(i).catch((err: unknown) =>
        this.opts.log.warn("discord: interaction failed", { error: String(err) }),
      );
    });
    client.on("voiceStateUpdate", (a: VoiceStateLike, b: VoiceStateLike) =>
      this.onVoiceState(a, b),
    );
    client.on("guildCreate", (g: GuildLike) => void this.registerGuild(g));
    client.on("messageCreate", (m: MessageLike) => this.onMessage(m));
    return new Promise<void>((resolve, reject) => {
      client.once("clientReady", () => resolve());
      client.once("shardDisconnect", (ev: { code?: number } | undefined) => {
        if (ev?.code === DISALLOWED_INTENTS_CLOSE) {
          reject(new DisallowedIntentsError("Used disallowed intents"));
        }
      });
      client.login(token).catch(reject);
    });
  }

  private async registerCommands(): Promise<void> {
    const scope = this.opts.config.discordCommands;
    try {
      if (scope === "global") {
        await this.client.application?.commands.set([HIVE_COMMAND]);
      } else if (scope === "guild") {
        await Promise.all([...this.client.guilds.cache.values()].map((g) => this.registerGuild(g)));
      }
    } catch (err) {
      this.opts.log.warn("discord: could not register /hive", { error: String(err) });
    }
  }

  private async registerGuild(g: GuildLike): Promise<void> {
    if (this.opts.config.discordCommands !== "guild") {
      return;
    }
    try {
      await g.commands.set([HIVE_COMMAND]);
    } catch (err) {
      this.opts.log.warn("discord: could not register /hive in a guild", {
        guild: g.id,
        error: String(err),
      });
    }
  }

  async close(): Promise<void> {
    for (const t of this.requestTimers.values()) clearTimeout(t);
    this.requestTimers.clear();
    for (const [id, l] of this.live) {
      this.stopSpeech(l);
      l.connection.destroy();
      this.opts.registry.get(id)?.setState("ended", "shutdown");
    }
    this.live.clear();
    await this.client.destroy();
  }

  private requireReady(): void {
    if (!this.ready) {
      throw new QuorumError("platform_unavailable", "discord is still connecting");
    }
    if (!this.opts.transcriber) {
      throw new QuorumError(
        "platform_unavailable",
        "QUORUM_TRANSCRIBE_URL is not set, so Discord audio cannot be transcribed",
      );
    }
  }

  /**
   * discord.js reports a channel unjoinable when the bot's own member is not cached, which would
   * read as a permission failure. Fetch it first; a failed fetch leaves the check to discord.js.
   */
  private async ensureSelfMember(guild: GuildLike): Promise<void> {
    if (!guild.members || guild.members.me) return;
    try {
      await guild.members.fetchMe();
    } catch (err) {
      this.opts.log.warn("discord: could not fetch the bot's guild member", {
        guild_id: guild.id,
        error: (err as Error).message,
      });
    }
  }

  /** The voice permissions the bot lacks in channel, by their Discord names. */
  private missingPermissions(channel: ChannelLike): string[] {
    const me = this.client.user;
    const perms = me && channel.permissionsFor ? channel.permissionsFor(me) : null;
    if (!perms) return [];
    if (perms.has(PERMISSION_ADMINISTRATOR, false)) return [];
    const needed = this.opts.tts ? [...VOICE_PERMISSIONS, SPEAK_PERMISSION] : VOICE_PERMISSIONS;
    return needed.filter(([bit]) => !perms.has(bit, false)).map(([, name]) => name);
  }

  async join(meeting: Meeting, _args: JoinArgs): Promise<void> {
    this.requireReady();
    this.clearRequest(meeting.id);
    const guildId = meeting.guildId as string;
    const channelId = meeting.channelId as string;
    let guild: GuildLike;
    let channel: ChannelLike | null;
    try {
      guild = await this.client.guilds.fetch(guildId);
      channel = await guild.channels.fetch(channelId);
    } catch {
      throw new QuorumError("not_found", "the bot cannot see that guild or channel");
    }
    if (!channel?.isVoiceBased()) {
      throw new QuorumError("invalid_argument", "channel_id is not a voice channel");
    }
    await this.ensureSelfMember(guild);
    if (channel.joinable === false) {
      const missing = this.missingPermissions(channel);
      const what = missing.length > 0 ? `: missing ${missing.join(", ")}` : "";
      this.opts.log.warn("discord: cannot join voice channel", {
        guild_id: guildId,
        channel_id: channelId,
        missing,
      });
      throw new QuorumError(
        "blocked",
        `the bot has no permission to connect to that voice channel${what}. ` +
          "Grant the bot's role View Channel, Connect and Speak on the channel (Edit Channel, Permissions)",
      );
    }
    meeting.setState("joining");
    const { voice } = this.opts.runtime;
    const connection = voice.joinVoiceChannel({
      guildId,
      channelId,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: !this.opts.tts,
    });
    try {
      await voice.entersState(
        connection,
        voice.Status.Ready,
        this.opts.config.discordJoinTimeoutS * MS_PER_S,
      );
    } catch {
      connection.destroy();
      throw new QuorumError("upstream_error", "the voice connection did not become ready in time");
    }
    const live: Live = {
      connection,
      channel,
      joinedAt: this.now(),
      listening: new Set(),
      names: new Map(),
      player: undefined,
      clips: [],
      playing: false,
      stt: new Map(),
    };
    if (this.opts.tts) {
      const player = voice.createAudioPlayer();
      player.on("error", (err: Error) =>
        this.opts.log.warn("discord: speech playback failed", { error: err.message }),
      );
      connection.subscribe(player);
      live.player = player;
    }
    this.live.set(meeting.id, live);
    this.syncMembers(meeting, live);
    connection.receiver.speaking.on("start", (userId: string) =>
      this.listen(meeting, live, userId),
    );
    connection.on("stateChange", (_old: { status: string }, next: { status: string }) => {
      void this.onConnectionState(meeting, live, next.status);
    });
    meeting.setState("live");
  }

  private async onConnectionState(meeting: Meeting, live: Live, status: string): Promise<void> {
    const { voice } = this.opts.runtime;
    if (status === voice.Status.Destroyed) {
      this.stopSpeech(live);
      this.live.delete(meeting.id);
      meeting.setState("ended", "disconnected");
      return;
    }
    if (status !== voice.Status.Disconnected) {
      return;
    }
    try {
      await Promise.race([
        voice.entersState(live.connection, voice.Status.Signalling, RECONNECT_GRACE_MS),
        voice.entersState(live.connection, voice.Status.Connecting, RECONNECT_GRACE_MS),
      ]);
    } catch {
      this.stopSpeech(live);
      live.connection.destroy();
      this.live.delete(meeting.id);
      meeting.setState("ended", "disconnected");
    }
  }

  /**
   * A typed line in the voice channel's built-in text chat (it shares the voice channel's id).
   * Other channels, bots, webhooks and our own messages are ignored.
   */
  private onMessage(msg: MessageLike): void {
    if (msg.author.bot || msg.webhookId || msg.author.id === this.client.user?.id) {
      return;
    }
    for (const [id, live] of this.live) {
      if (msg.channelId !== live.channel.id) continue;
      const meeting = this.opts.registry.get(id);
      if (!meeting || meeting.terminal || msg.guildId !== meeting.guildId) continue;
      const name = nameOf(
        msg.member ?? {
          user: { username: msg.author.username, globalName: msg.author.globalName },
        },
        msg.author.id,
      );
      live.names.set(msg.author.id, name);
      meeting.addChat({
        author: { id: msg.author.id, name },
        text: msg.content,
        at: new Date(msg.createdTimestamp).toISOString(),
      });
    }
  }

  private syncMembers(meeting: Meeting, live: Live): void {
    for (const m of live.channel.members.values()) {
      if (m.user.bot) continue;
      const name = nameOf(m, m.id);
      live.names.set(m.id, name);
      meeting.addParticipant({ id: m.id, name });
    }
  }

  private onVoiceState(before: VoiceStateLike, after: VoiceStateLike): void {
    for (const [id, live] of this.live) {
      const meeting = this.opts.registry.get(id);
      if (!meeting || after.member?.user.bot) continue;
      const userId = after.id;
      if (after.channelId === live.channel.id) {
        const name = nameOf(after.member ?? undefined, userId);
        live.names.set(userId, name);
        meeting.addParticipant({ id: userId, name });
      } else if (before.channelId === live.channel.id) {
        meeting.removeParticipant(userId);
      }
    }
  }

  private speaker(live: Live, userId: string): Person {
    const cached = live.names.get(userId) ?? nameOf(live.channel.members.get(userId), userId);
    return { id: userId, name: cached };
  }

  /** Subscribes to one user's audio until silence, cutting it into segments. */
  private listen(meeting: Meeting, live: Live, userId: string): void {
    if (live.listening.has(userId) || meeting.terminal) {
      return;
    }
    live.listening.add(userId);
    const { config, runtime } = this.opts;
    const stream = live.connection.receiver.subscribe(userId, {
      end: { behavior: runtime.voice.AfterSilence, duration: config.discordSilenceMs },
    });
    const decoder = runtime.createDecoder();
    const utterance = new Utterance(this.now() - live.joinedAt);
    const maxMs = config.discordMaxSegmentS * MS_PER_S;
    stream.on("data", (packet: Buffer) => {
      try {
        utterance.push(toMono16k(decoder.decode(packet)));
      } catch (err) {
        this.opts.log.debug("discord: dropped an undecodable packet", { error: String(err) });
        return;
      }
      if (utterance.durationMs >= maxMs) {
        this.enqueueFlush(meeting, live, userId, utterance);
      }
    });
    const done = (): void => {
      live.listening.delete(userId);
      decoder.delete?.();
      this.enqueueFlush(meeting, live, userId, utterance);
    };
    stream.once("end", done);
    stream.once("error", (err: Error) => {
      this.opts.log.warn("discord: audio stream error", { error: err.message });
      done();
    });
  }

  /**
   * Takes the utterance's audio now, trims its leading and trailing silence (all-quiet audio is
   * never sent), and queues it behind the speaker's earlier segments. While the service is slow,
   * a speaker's waiting segments are merged into one request (up to QUORUM_DISCORD_MAX_SEGMENT_S)
   * instead of piling up one request each, so the newest speech goes out with the backlog rather
   * than after it.
   */
  private enqueueFlush(meeting: Meeting, live: Live, userId: string, utterance: Utterance): void {
    const { config } = this.opts;
    const taken = utterance.take();
    const trimmed = trimSilence(taken.samples, config.discordVadThreshold);
    if (samplesMs(trimmed.samples) < config.discordMinSegmentMs) {
      return;
    }
    const startMs = taken.startMs + trimmed.leadMs;
    const seg = {
      samples: trimmed.samples,
      startMs,
      endMs: startMs + samplesMs(trimmed.samples),
    };
    let q = live.stt.get(userId);
    if (!q) {
      q = { pending: [], running: false };
      live.stt.set(userId, q);
    }
    q.pending.push(seg);
    if (!q.running) {
      void this.drainSpeaker(meeting, live, userId, q);
    }
  }

  private async drainSpeaker(
    meeting: Meeting,
    live: Live,
    userId: string,
    q: SpeakerQueue,
  ): Promise<void> {
    q.running = true;
    const maxMs = this.opts.config.discordMaxSegmentS * MS_PER_S;
    try {
      while (q.pending.length) {
        const batch = [q.pending.shift() as PendingSegment];
        let total = samplesMs(batch[0]?.samples ?? new Int16Array(0));
        for (let next = q.pending[0]; next; next = q.pending[0]) {
          const ms = samplesMs(next.samples);
          if (total + ms > maxMs) break;
          batch.push(q.pending.shift() as PendingSegment);
          total += ms;
        }
        if (batch.length > 1) {
          this.opts.log.info("discord: transcription backlog merged into one request", {
            segments: batch.length,
            audio_ms: Math.round(total),
          });
        }
        const first = batch[0] as PendingSegment;
        const last = batch[batch.length - 1] as PendingSegment;
        await this.flush(meeting, live, userId, {
          samples: concatSamples(batch.map((b) => b.samples)),
          startMs: first.startMs,
          endMs: last.endMs,
        });
      }
    } finally {
      q.running = false;
    }
  }

  private async flush(
    meeting: Meeting,
    live: Live,
    userId: string,
    { samples, startMs, endMs }: { samples: Int16Array; startMs: number; endMs: number },
  ): Promise<void> {
    let text: string;
    try {
      text = await (this.opts.transcriber as Transcriber).transcribe(encodeWav(samples), {
        hints: nameHints(meeting.displayName),
      });
    } catch (err) {
      this.opts.log.warn("discord: transcription failed; segment dropped", { error: String(err) });
      return;
    }
    if (meeting.terminal && !this.opts.registry.get(meeting.id)) {
      return;
    }
    meeting.addSegment({
      key: `${userId}:${Math.round(startMs)}`,
      speaker: this.speaker(live, userId),
      text,
      start: startMs / MS_PER_S,
      end: endMs / MS_PER_S,
      final: true,
    });
  }

  /**
   * Leaves once the speech already queued has played (a last "Leaving now." is heard), waiting at
   * most QUORUM_LEAVE_DRAIN_TIMEOUT_MS. The /hive leave command and a delete stop at once.
   */
  async leave(meeting: Meeting): Promise<void> {
    const live = this.live.get(meeting.id);
    const waitMs = this.opts.config.leaveDrainTimeoutMs;
    if (live?.drained && waitMs > 0) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        live.drained,
        new Promise<void>((r) => {
          timer = setTimeout(r, waitMs);
        }),
      ]);
      clearTimeout(timer);
      // The meeting may have ended while this waited (/hive leave, a delete, a lost connection):
      // its state and reason stand.
      if (meeting.terminal) {
        return;
      }
    }
    this.leaveWith(meeting, meeting.state === "requested" ? "declined" : "left");
  }

  private leaveWith(meeting: Meeting, reason: string): void {
    this.clearRequest(meeting.id);
    const live = this.live.get(meeting.id);
    this.live.delete(meeting.id);
    meeting.setState("ended", reason);
    if (live) this.stopSpeech(live);
    live?.connection.destroy();
  }

  async refresh(meeting: Meeting): Promise<void> {
    const live = this.live.get(meeting.id);
    if (live) {
      this.syncMembers(meeting, live);
    }
  }

  /** Discord's send call answers once the message exists, so a post is always confirmed. */
  async chat(meeting: Meeting, text: string): Promise<ChatDelivery> {
    const live = this.live.get(meeting.id);
    if (!live) {
      throw new QuorumError("not_live", "the bot is not in the voice channel");
    }
    try {
      await live.channel.send(text);
    } catch (err) {
      throw new QuorumError(
        "upstream_error",
        `discord refused the message: ${(err as Error).message}`,
      );
    }
    return "confirmed";
  }

  /**
   * Speaks `text` sentence by sentence, queued behind earlier lines. Sentences are synthesized one
   * after another (cached ones cost nothing) and each plays as soon as it is ready and the one
   * before it has finished, so the first sound comes after one sentence's synthesis. Resolves once
   * the first sentence is ready, so a TTS failure on it answers upstream_error; a later sentence
   * that fails is skipped and logged. `durationMs` is given when every sentence was ready by then.
   */
  async say(meeting: Meeting, text: string): Promise<SayOutcome> {
    const synth = this.synth;
    if (!synth) {
      throw new QuorumError(
        "platform_unavailable",
        "QUORUM_TTS_URL is not set, so the bot cannot speak on Discord",
      );
    }
    const live = this.live.get(meeting.id);
    if (!live?.player) {
      throw new QuorumError("not_live", "the bot is not in the voice channel");
    }
    const voice = meeting.voiceId ?? this.opts.config.ttsVoice;
    const startedAt = this.now();
    const sentences = splitSentences(text);
    let failed = false;
    const allCached = sentences.every((sentence) => synth.has(sentence, voice));
    let after: Promise<unknown> = Promise.resolve();
    const lengths: (number | undefined)[] = sentences.map(() => undefined);
    const clips = sentences.map((sentence, i) => {
      // One request at a time, in order: the single TTS worker gives the first sentence its all.
      const clip: Promise<Buffer> = after.then(() => {
        if (failed) {
          throw new QuorumError("upstream_error", "an earlier sentence of the line failed");
        }
        return synth.clip(sentence, voice).pcm.then(upsampleToStereo48k);
      });
      after = clip.then(
        (pcm) => {
          lengths[i] = pcm.length;
        },
        (err: unknown) => {
          if (i > 0 && !failed) {
            this.opts.log.warn("discord: a sentence could not be synthesized; skipped", {
              error: String(err),
            });
          }
        },
      );
      return clip;
    });
    for (const clip of clips) {
      live.clips.push(clip.catch(() => undefined));
    }
    this.drain(meeting, live);
    try {
      await clips[0];
    } catch (err) {
      failed = true;
      throw err;
    }
    const firstAudioMs = this.now() - startedAt;
    // Let sentences that were already cached settle, so a fully cached line reports its length.
    await new Promise((r) => setImmediate(r));
    const known = lengths.every((n) => n !== undefined);
    const total = lengths.reduce<number>((sum, n) => sum + (n ?? 0), 0);
    return {
      ...(known ? { durationMs: Math.round((total / PLAYBACK_BYTES_PER_S) * MS_PER_S) } : {}),
      firstAudioMs,
      synthMs: allCached ? 0 : firstAudioMs,
      cached: allCached,
    };
  }

  /** Synthesizes fixed lines into the clip cache in the background (say.prewarm). */
  async prewarm(meeting: Meeting, lines: string[]): Promise<number> {
    if (!this.synth) {
      return 0;
    }
    return this.synth.prewarm(lines, meeting.voiceId ?? this.opts.config.ttsVoice);
  }

  private drain(meeting: Meeting, live: Live): void {
    if (!live.playing) {
      live.playing = true;
      live.drained = this.playQueued(meeting, live);
    }
  }

  private async playQueued(meeting: Meeting, live: Live): Promise<void> {
    try {
      for (let next = live.clips.shift(); next; next = live.clips.shift()) {
        const pcm = await next;
        if (!pcm || this.live.get(meeting.id) !== live) continue;
        await this.play(live, pcm);
      }
    } finally {
      // Cleared in the same tick the queue ran dry, so a say right after starts a new drain.
      live.playing = false;
    }
  }

  /** Plays one clip and resolves when the player is idle again (or a safety timeout passes). */
  private play(live: Live, pcm: Buffer): Promise<void> {
    const player = live.player as AudioPlayerLike;
    const { runtime } = this.opts;
    const frames = pcmFrames(pcm);
    const encoder = runtime.createEncoder();
    let i = 0;
    let freed = false;
    const free = (): void => {
      if (!freed) {
        freed = true;
        encoder.delete?.();
      }
    };
    // Encode lazily, one frame per read, so a long clip never blocks the event loop.
    const stream = new Readable({
      objectMode: true,
      read() {
        const frame = frames[i++];
        if (!frame) {
          free();
          this.push(null);
          return;
        }
        this.push(encoder.encode(frame, OPUS_FRAME_SAMPLES));
      },
      destroy(err, cb) {
        free();
        cb(err);
      },
    });
    return new Promise<void>((resolve) => {
      const idle = runtime.voice.PlayerIdle;
      const timer = setTimeout(done, frames.length * OPUS_FRAME_MS + PLAYBACK_GRACE_MS);
      timer.unref();
      function done(): void {
        clearTimeout(timer);
        player.off(idle, done);
        stream.destroy();
        resolve();
      }
      player.once(idle, done);
      try {
        player.play(runtime.voice.createOpusResource(stream));
      } catch (err) {
        this.opts.log.warn("discord: speech playback failed", { error: String(err) });
        done();
      }
    });
  }

  private stopSpeech(live: Live): void {
    live.clips.length = 0;
    live.player?.stop(true);
  }

  /** Discord audio and transcripts exist only in quorum's memory; leaving is all there is to do. */
  async erase(meeting: Meeting): Promise<void> {
    if (!meeting.terminal) {
      this.leaveWith(meeting, "deleted");
    }
  }

  private clearRequest(id: string): void {
    clearTimeout(this.requestTimers.get(id));
    this.requestTimers.delete(id);
  }

  private async onInteraction(i: InteractionLike): Promise<void> {
    if (!i.isChatInputCommand() || i.commandName !== HIVE_COMMAND.name) {
      return;
    }
    const sub = i.options.getSubcommand();
    const guildId = i.guildId;
    if (!guildId) {
      await i.reply({ content: "Use /hive in a server.", flags: EPHEMERAL });
      return;
    }
    if (sub === "join") {
      await this.requestJoin(i, guildId);
    } else if (sub === "leave") {
      await this.commandLeave(i, guildId);
    }
  }

  private async requestJoin(i: InteractionLike, guildId: string): Promise<void> {
    const channelId = i.member?.voice?.channelId ?? null;
    if (!channelId) {
      await i.reply({
        content: "Join a voice channel first, then run /hive join.",
        flags: EPHEMERAL,
      });
      return;
    }
    const existing = this.opts.registry.findActive(
      (m) => m.platform === "discord" && m.guildId === guildId && m.channelId === channelId,
    );
    if (existing) {
      const what =
        existing.state === "requested" ? "is already waiting for approval" : "is already here";
      await i.reply({ content: `Hive ${what}.`, flags: EPHEMERAL });
      return;
    }
    const meeting = new Meeting({
      platform: "discord",
      bufferSize: this.opts.config.transcriptBuffer,
    });
    meeting.guildId = guildId;
    meeting.channelId = channelId;
    const requestedBy: Person = {
      id: i.user.id,
      name: nameOf(i.member ?? undefined, i.user.id) || i.user.username,
    };
    this.opts.registry.add(meeting);
    meeting.setState("requested", undefined, {
      platform: "discord",
      guild_id: guildId,
      channel_id: channelId,
      requested_by: requestedBy,
    });
    const ttl = this.opts.config.discordRequestTtlS * MS_PER_S;
    const timer = setTimeout(() => {
      this.requestTimers.delete(meeting.id);
      if (meeting.state === "requested") meeting.setState("ended", "request_expired");
    }, ttl);
    timer.unref();
    this.requestTimers.set(meeting.id, timer);
    await i.reply({
      content: "Asked hive to join this voice channel. It joins once hive approves.",
      flags: EPHEMERAL,
    });
  }

  private async commandLeave(i: InteractionLike, guildId: string): Promise<void> {
    const channelId = i.member?.voice?.channelId ?? null;
    const inGuild = (m: Meeting): boolean => m.platform === "discord" && m.guildId === guildId;
    const meeting =
      this.opts.registry.findActive((m) => inGuild(m) && m.channelId === channelId) ??
      this.opts.registry.findActive(inGuild);
    if (!meeting) {
      await i.reply({ content: "Hive is not in a voice channel here.", flags: EPHEMERAL });
      return;
    }
    this.leaveWith(meeting, "leave_command");
    await i.reply({ content: "Hive left the voice channel." });
  }
}
