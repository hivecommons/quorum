import type { JoinArgs, PlatformAdapter } from "../adapter.js";
import type { Config } from "../config.js";
import { QuorumError } from "../errors.js";
import type { Logger } from "../log.js";
import { Meeting, type Person, type Registry } from "../meeting.js";
import { encodeWav, toMono16k, Utterance } from "./audio.js";
import type { Transcriber } from "./transcribe.js";
import type {
  ChannelLike,
  ClientLike,
  DiscordRuntime,
  GuildLike,
  InteractionLike,
  VoiceConnectionLike,
  VoiceStateLike,
} from "./types.js";

/**
 * Discord voice through `@discordjs/voice` (DAVE end-to-end encryption via @snazzah/davey).
 * Each speaking user's Opus stream is decoded, cut at silence, sent to the shared Whisper
 * service and emitted as a final segment attributed to that Discord user.
 */

const MS_PER_S = 1000;
/** Discord interaction flag for a reply only the invoking user sees. */
const EPHEMERAL = 64;
/** How long a dropped voice connection may take to recover before the meeting ends. */
const RECONNECT_GRACE_MS = 5000;

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
}

export interface DiscordAdapterOptions {
  runtime: DiscordRuntime;
  registry: Registry;
  log: Logger;
  config: Config;
  transcriber: Transcriber | undefined;
  now?: () => number;
}

function nameOf(
  member:
    { displayName?: string; user?: { username?: string; globalName?: string | null } } | undefined,
  id: string,
): string {
  return member?.displayName || member?.user?.globalName || member?.user?.username || `user ${id}`;
}

export class DiscordAdapter implements PlatformAdapter {
  private readonly client: ClientLike;
  private readonly live = new Map<string, Live>();
  private readonly requestTimers = new Map<string, NodeJS.Timeout>();
  private ready = false;
  private readonly now: () => number;

  constructor(private readonly opts: DiscordAdapterOptions) {
    this.client = opts.runtime.createClient();
    this.now = opts.now ?? Date.now;
  }

  get isReady(): boolean {
    return this.ready;
  }

  /** Logs in and registers the /hive command. Resolves once the client is ready. */
  async start(token: string): Promise<void> {
    this.client.on("interactionCreate", (i: InteractionLike) => {
      void this.onInteraction(i).catch((err: unknown) =>
        this.opts.log.warn("discord: interaction failed", { error: String(err) }),
      );
    });
    this.client.on("voiceStateUpdate", (a: VoiceStateLike, b: VoiceStateLike) =>
      this.onVoiceState(a, b),
    );
    this.client.on("guildCreate", (g: GuildLike) => void this.registerGuild(g));
    const ready = new Promise<void>((resolve) => {
      this.client.once("clientReady", () => resolve());
    });
    await this.client.login(token);
    await ready;
    this.ready = true;
    await this.registerCommands();
    this.opts.log.info("discord connected", { guilds: this.client.guilds.cache.size });
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
    if (channel.joinable === false) {
      throw new QuorumError(
        "blocked",
        "the bot has no permission to connect to that voice channel",
      );
    }
    meeting.setState("joining");
    const { voice } = this.opts.runtime;
    const connection = voice.joinVoiceChannel({
      guildId,
      channelId,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: true,
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
    };
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
      live.connection.destroy();
      this.live.delete(meeting.id);
      meeting.setState("ended", "disconnected");
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
        void this.flush(meeting, live, userId, utterance);
      }
    });
    const done = (): void => {
      live.listening.delete(userId);
      decoder.delete?.();
      void this.flush(meeting, live, userId, utterance);
    };
    stream.once("end", done);
    stream.once("error", (err: Error) => {
      this.opts.log.warn("discord: audio stream error", { error: err.message });
      done();
    });
  }

  private async flush(
    meeting: Meeting,
    live: Live,
    userId: string,
    utterance: Utterance,
  ): Promise<void> {
    const tooShort = utterance.durationMs < this.opts.config.discordMinSegmentMs;
    const { samples, startMs, endMs } = utterance.take();
    if (tooShort || samples.length === 0) {
      return;
    }
    let text: string;
    try {
      text = await (this.opts.transcriber as Transcriber).transcribe(encodeWav(samples));
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

  async leave(meeting: Meeting): Promise<void> {
    this.leaveWith(meeting, meeting.state === "requested" ? "declined" : "left");
  }

  private leaveWith(meeting: Meeting, reason: string): void {
    this.clearRequest(meeting.id);
    const live = this.live.get(meeting.id);
    this.live.delete(meeting.id);
    meeting.setState("ended", reason);
    live?.connection.destroy();
  }

  async refresh(meeting: Meeting): Promise<void> {
    const live = this.live.get(meeting.id);
    if (live) {
      this.syncMembers(meeting, live);
    }
  }

  async chat(meeting: Meeting, text: string): Promise<void> {
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
  }

  async say(): Promise<void> {
    throw new QuorumError(
      "platform_unavailable",
      "speaking is not supported on Discord in this version",
    );
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
