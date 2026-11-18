import type { ChatDelivery, PlatformAdapter } from "./adapter.js";
import type { Config } from "./config.js";
import { QuorumError, success, toFailure, type ToolResult } from "./errors.js";
import type { Logger } from "./log.js";
import {
  Meeting,
  type MeetingState,
  type Person,
  type Platform,
  type Registry,
  type Segment,
} from "./meeting.js";
import { parseMeetingUrl } from "./urls.js";

/**
 * The seven contract tools (docs/contract.md section 1) over the platform adapters. Every method
 * validates its arguments, never throws, and returns `{ok:true,...}` or `{ok:false,error}`.
 */

const DISPLAY_NAME_MAX_CHARS = 100;
const VOICE_ID_MAX_CHARS = 100;
const SNOWFLAKE = /^\d{5,25}$/;

type Args = Record<string, unknown>;

function asArgs(raw: unknown): Args {
  if (raw === undefined || raw === null) {
    return {};
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new QuorumError("invalid_argument", "arguments must be an object");
  }
  return raw as Args;
}

function requireString(args: Args, name: string): string {
  const v = args[name];
  if (typeof v !== "string" || !v.trim()) {
    throw new QuorumError("invalid_argument", `${name} must be a non-empty string`);
  }
  return v.trim();
}

function optionalString(args: Args, name: string): string | undefined {
  const v = args[name];
  if (v === undefined || v === null) {
    return undefined;
  }
  if (typeof v !== "string") {
    throw new QuorumError("invalid_argument", `${name} must be a string`);
  }
  return v.trim() || undefined;
}

function optionalBool(args: Args, name: string): boolean | undefined {
  const v = args[name];
  if (v === undefined || v === null) {
    return undefined;
  }
  if (typeof v !== "boolean") {
    throw new QuorumError("invalid_argument", `${name} must be a boolean`);
  }
  return v;
}

function boundedText(args: Args, max: number): string {
  const text = requireString(args, "text");
  if (text.length > max) {
    throw new QuorumError(
      "invalid_argument",
      `text is ${text.length} characters; the limit is ${max}`,
    );
  }
  return text;
}

export interface QuorumOptions {
  config: Config;
  registry: Registry;
  adapters: Partial<Record<Platform, PlatformAdapter>>;
  log: Logger;
}

/** The `say` tool's result (docs/contract.md). */
export interface SayResult {
  queued: true;
  duration_ms?: number;
  first_audio_ms?: number;
  synth_ms?: number;
  cached?: boolean;
}

export class Quorum {
  constructor(private readonly opts: QuorumOptions) {}

  get registry(): Registry {
    return this.opts.registry;
  }

  private async run<T extends object>(fn: () => Promise<T>): Promise<ToolResult<T>> {
    try {
      return success(await fn());
    } catch (err) {
      if (!(err instanceof QuorumError)) {
        this.opts.log.error("tool failed", { error: String(err) });
      }
      return toFailure(err);
    }
  }

  private adapter(platform: Platform): PlatformAdapter {
    const a = this.opts.adapters[platform];
    if (!a) {
      throw new QuorumError("platform_unavailable", `${platform} is not configured in this quorum`);
    }
    return a;
  }

  private meeting(args: Args): Meeting {
    const id = requireString(args, "meeting_id");
    const m = this.opts.registry.get(id);
    if (!m) {
      throw new QuorumError("not_found", `no meeting ${id}`);
    }
    return m;
  }

  private requireLive(m: Meeting): void {
    if (m.state === "live") {
      return;
    }
    if (m.state === "blocked") {
      throw new QuorumError("blocked", "the meeting refused the bot");
    }
    if (m.state === "failed" && m.reason === "lobby_timeout") {
      throw new QuorumError("lobby_timeout", "nobody admitted the bot from the lobby in time");
    }
    throw new QuorumError("not_live", `the meeting is ${m.state}, not live`);
  }

  join(
    raw: unknown,
  ): Promise<ToolResult<{ meeting_id: string; platform: Platform; state: MeetingState }>> {
    return this.run(async () => {
      const args = asArgs(raw);
      const platformArg = optionalString(args, "platform");
      const voice = optionalBool(args, "voice") ?? this.opts.config.vexaVoiceDefault;
      const displayName = optionalString(args, "display_name") ?? "";
      if (displayName.length > DISPLAY_NAME_MAX_CHARS) {
        throw new QuorumError(
          "invalid_argument",
          `display_name is longer than ${DISPLAY_NAME_MAX_CHARS} characters`,
        );
      }
      const voiceId = optionalString(args, "voice_id");
      if (voiceId !== undefined && voiceId.length > VOICE_ID_MAX_CHARS) {
        throw new QuorumError(
          "invalid_argument",
          `voice_id is longer than ${VOICE_ID_MAX_CHARS} characters`,
        );
      }
      const m =
        platformArg === "discord"
          ? this.discordMeeting(args, displayName)
          : platformArg === "companion"
            ? this.companionMeeting(args, displayName)
            : this.urlMeeting(args, platformArg, displayName);
      if (!m.created) {
        return { meeting_id: m.meeting.id, platform: m.meeting.platform, state: m.meeting.state };
      }
      const meeting = m.meeting;
      meeting.voice = voice;
      meeting.voiceId = voiceId;
      const adapter = this.adapter(meeting.platform);
      if (!this.opts.registry.get(meeting.id)) {
        this.opts.registry.add(meeting);
      }
      try {
        await adapter.join(meeting, {
          displayName,
          voice,
          ...(voiceId ? { voiceId } : {}),
          ...m.extra,
        });
      } catch (err) {
        // Tool errors go back to the caller only; log join failures so quorum's own log names them.
        this.opts.log.warn("meeting.join failed", {
          platform: meeting.platform,
          code: err instanceof QuorumError ? err.code : "join_error",
          error: (err as Error).message,
        });
        meeting.setState("failed", err instanceof QuorumError ? err.code : "join_error");
        this.opts.registry.remove(meeting.id);
        throw err;
      }
      return { meeting_id: meeting.id, platform: meeting.platform, state: meeting.state };
    });
  }

  private urlMeeting(
    args: Args,
    platformArg: string | undefined,
    displayName: string,
  ): { meeting: Meeting; created: boolean; extra: Record<string, string> } {
    const url = requireString(args, "url");
    if (!displayName) {
      throw new QuorumError("invalid_argument", "display_name must be a non-empty string");
    }
    const parsed = parseMeetingUrl(url, {
      zoomHostedDomains: this.opts.config.zoomHostedDomains,
    });
    if (platformArg && platformArg !== parsed.platform) {
      throw new QuorumError(
        "invalid_argument",
        `url is a ${parsed.platform} link, not ${platformArg}`,
      );
    }
    this.adapter(parsed.platform);
    const existing = this.opts.registry.findActive(
      (x) => x.platform === parsed.platform && x.nativeId === parsed.nativeId,
    );
    if (existing) {
      return { meeting: existing, created: false, extra: {} };
    }
    const meeting = new Meeting({
      platform: parsed.platform,
      bufferSize: this.opts.config.transcriptBuffer,
      displayName,
    });
    meeting.nativeId = parsed.nativeId;
    const extra: Record<string, string> = {};
    if (parsed.passcode) extra.passcode = parsed.passcode;
    if (parsed.meetingUrl) extra.meetingUrl = parsed.meetingUrl;
    if (parsed.teamsBaseHost) extra.teamsBaseHost = parsed.teamsBaseHost;
    return { meeting, created: true, extra };
  }

  /** A companion meeting is new on every join: the companion app starts one per call. */
  private companionMeeting(
    args: Args,
    displayName: string,
  ): { meeting: Meeting; created: boolean; extra: Record<string, string> } {
    const hostName = optionalString(args, "host_name");
    if (hostName !== undefined && hostName.length > DISPLAY_NAME_MAX_CHARS) {
      throw new QuorumError(
        "invalid_argument",
        `host_name is longer than ${DISPLAY_NAME_MAX_CHARS} characters`,
      );
    }
    this.adapter("companion");
    const meeting = new Meeting({
      platform: "companion",
      bufferSize: this.opts.config.transcriptBuffer,
      displayName,
    });
    return { meeting, created: true, extra: hostName ? { hostName } : {} };
  }

  private discordMeeting(
    args: Args,
    displayName: string,
  ): { meeting: Meeting; created: boolean; extra: Record<string, string> } {
    const guildId = requireString(args, "guild_id");
    const channelId = requireString(args, "channel_id");
    if (!SNOWFLAKE.test(guildId) || !SNOWFLAKE.test(channelId)) {
      throw new QuorumError(
        "invalid_argument",
        "guild_id and channel_id must be Discord snowflake ids",
      );
    }
    this.adapter("discord");
    const existing = this.opts.registry.findActive(
      (x) => x.platform === "discord" && x.guildId === guildId && x.channelId === channelId,
    );
    if (existing && existing.state !== "requested") {
      return { meeting: existing, created: false, extra: {} };
    }
    // A pending /hive join request for this channel: approving it keeps its meeting_id.
    const meeting =
      existing ??
      new Meeting({
        platform: "discord",
        bufferSize: this.opts.config.transcriptBuffer,
        displayName,
      });
    meeting.guildId = guildId;
    meeting.channelId = channelId;
    return { meeting, created: true, extra: {} };
  }

  leave(raw: unknown): Promise<ToolResult<{ state: MeetingState }>> {
    return this.run(async () => {
      const m = this.meeting(asArgs(raw));
      if (!m.terminal) {
        await this.adapter(m.platform).leave(m);
      }
      return { state: m.state };
    });
  }

  status(raw: unknown): Promise<ToolResult<{ state: MeetingState; participants: Person[] }>> {
    return this.run(async () => {
      const m = this.meeting(asArgs(raw));
      if (!m.terminal) {
        try {
          await this.adapter(m.platform).refresh(m);
        } catch (err) {
          this.opts.log.warn("status refresh failed; answering from the live feed", {
            error: String(err),
          });
        }
      }
      return { state: m.state, participants: m.participants };
    });
  }

  readTranscript(raw: unknown): Promise<ToolResult<{ segments: Segment[]; next_seq: number }>> {
    return this.run(async () => {
      const args = asArgs(raw);
      const m = this.meeting(args);
      const after = args.after_seq;
      if (
        after !== undefined &&
        after !== null &&
        (typeof after !== "number" || !Number.isInteger(after) || after < 0)
      ) {
        throw new QuorumError("invalid_argument", "after_seq must be a non-negative integer");
      }
      return m.readSegments(typeof after === "number" ? after : 0);
    });
  }

  chatPost(raw: unknown): Promise<ToolResult<{ posted_at: string; delivery: ChatDelivery }>> {
    return this.run(async () => {
      const args = asArgs(raw);
      const m = this.meeting(args);
      const text = boundedText(args, this.opts.config.chatMaxChars);
      const confirm = optionalBool(args, "confirm") ?? false;
      this.requireLive(m);
      const delivery = await this.adapter(m.platform).chat(m, text, { confirm });
      return { posted_at: new Date().toISOString(), delivery };
    });
  }

  say(raw: unknown): Promise<ToolResult<SayResult>> {
    return this.run(async () => {
      const args = asArgs(raw);
      const m = this.meeting(args);
      const text = boundedText(args, this.opts.config.sayMaxChars);
      this.requireLive(m);
      const out = await this.adapter(m.platform).say(m, text);
      return {
        queued: true as const,
        ...(out.durationMs === undefined ? {} : { duration_ms: out.durationMs }),
        ...(out.firstAudioMs === undefined ? {} : { first_audio_ms: out.firstAudioMs }),
        ...(out.synthMs === undefined ? {} : { synth_ms: out.synthMs }),
        ...(out.cached === undefined ? {} : { cached: out.cached }),
      };
    });
  }

  /**
   * Plays the listening tone, a short chime. Never waits for the sound and never queues behind
   * speech: {played:false} when it was dropped (speech in progress, no voice, or a platform
   * without a tone).
   */
  sayTone(raw: unknown): Promise<ToolResult<{ played: boolean }>> {
    return this.run(async () => {
      const m = this.meeting(asArgs(raw));
      this.requireLive(m);
      const adapter = this.adapter(m.platform);
      return { played: adapter.tone ? await adapter.tone(m) : false };
    });
  }

  /** Gets fixed lines ready to be spoken at once; a platform that cannot answers queued 0. */
  sayPrewarm(raw: unknown): Promise<ToolResult<{ queued: number }>> {
    return this.run(async () => {
      const args = asArgs(raw);
      const m = this.meeting(args);
      const { sayMaxChars, sayPrewarmMaxLines } = this.opts.config;
      const texts = args.texts;
      if (
        !Array.isArray(texts) ||
        texts.length === 0 ||
        texts.length > sayPrewarmMaxLines ||
        !texts.every((t) => typeof t === "string" && t.trim() !== "" && t.length <= sayMaxChars)
      ) {
        throw new QuorumError(
          "invalid_argument",
          `texts must be 1 to ${sayPrewarmMaxLines} non-empty strings of at most ${sayMaxChars} characters`,
        );
      }
      this.requireLive(m);
      const adapter = this.adapter(m.platform);
      const lines = (texts as string[]).map((t) => t.trim());
      return { queued: adapter.prewarm ? await adapter.prewarm(m, lines) : 0 };
    });
  }

  delete(raw: unknown): Promise<ToolResult<{ deleted: true }>> {
    return this.run(async () => {
      const m = this.meeting(asArgs(raw));
      await this.adapter(m.platform).erase(m);
      m.clearTranscript();
      this.opts.registry.remove(m.id);
      return { deleted: true as const };
    });
  }
}
