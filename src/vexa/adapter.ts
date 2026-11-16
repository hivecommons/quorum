import type { JoinArgs, PlatformAdapter } from "../adapter.js";
import { QuorumError } from "../errors.js";
import type { Logger } from "../log.js";
import type { Meeting, MeetingState, Registry } from "../meeting.js";
import { VexaHttpError, VEXA_STATUS, type VexaClient, type VexaMeeting } from "./client.js";
import type { VexaFrame, VexaStream } from "./stream.js";

/**
 * Google Meet, Teams and Zoom through Vexa. Joins with `POST /bots`, follows the meeting on the
 * gateway `/ws`, and normalizes Vexa frames into contract segments, chat and state events.
 */

const MS_PER_S = 1000;

/** Completion reasons that mean the platform refused a guest bot (contract state `blocked`). */
const BLOCKED_REASONS = new Set(["platform_join_refused", "auth_session_missing"]);
const LOBBY_TIMEOUT_REASONS = new Set(["awaiting_admission_timeout"]);
const TERMINAL_VEXA = new Set(["completed", "failed"]);

export interface MappedState {
  state: MeetingState;
  reason?: string;
}

/** Vexa MeetingStatus (plus completion_reason / failure_stage) to the contract state. */
export function mapVexaStatus(
  status: string,
  completionReason?: string | null,
  failureStage?: string | null,
): MappedState {
  const reason = completionReason ?? undefined;
  switch (status) {
    case "requested":
    case "scheduled":
      return { state: "requested" };
    case "joining":
      return { state: "joining" };
    case "awaiting_admission":
      return { state: "lobby" };
    case "needs_help":
    case "needs_human_help":
      return { state: "lobby", reason: "needs_help" };
    case "active":
      return { state: "live" };
    case "stopping":
      return { state: "ended", reason: "stopping" };
    case "completed":
    case "failed": {
      if (reason && BLOCKED_REASONS.has(reason)) {
        return { state: "blocked", reason };
      }
      if (reason && LOBBY_TIMEOUT_REASONS.has(reason)) {
        return { state: "failed", reason: "lobby_timeout" };
      }
      if (status === "completed") {
        return reason ? { state: "ended", reason } : { state: "ended" };
      }
      const why = reason ?? (failureStage ? `failed_while_${failureStage}` : undefined);
      return why ? { state: "failed", reason: why } : { state: "failed" };
    }
    default:
      return { state: "joining", reason: status };
  }
}

interface VexaSegment {
  segment_id?: unknown;
  speaker?: unknown;
  text?: unknown;
  start?: unknown;
  end?: unknown;
  start_time?: unknown;
  end_time?: unknown;
  completed?: unknown;
  source?: unknown;
  absolute_start_time?: unknown;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function person(name: unknown): { id: string; name: string } {
  const n = str(name)?.trim() || "unknown";
  return { id: n, name: n };
}

/** A seconds value at or above this is an epoch time rather than a session offset (Vexa chat.py). */
const EPOCH_THRESHOLD_S = 1_000_000_000;

/** Epoch milliseconds of a chat segment, derived the way Vexa derives chat_message.timestamp. */
export function chatTimestamp(seg: VexaSegment): number | undefined {
  const start = typeof seg.start === "number" ? seg.start : undefined;
  if (start !== undefined && start >= EPOCH_THRESHOLD_S) {
    return Math.round(start * MS_PER_S);
  }
  const abs = Date.parse(str(seg.absolute_start_time) ?? "");
  return Number.isNaN(abs) ? undefined : abs;
}

export interface VexaAdapterOptions {
  client: VexaClient;
  stream: VexaStream;
  registry: Registry;
  log: Logger;
  lobbyTimeoutS: number;
  echoWindowS: number;
}

export class VexaAdapter implements PlatformAdapter {
  private readonly echoes = new Map<string, number>();
  private readonly chatSeen = new WeakMap<Meeting, Set<string>>();

  constructor(private readonly opts: VexaAdapterOptions) {
    opts.stream.on("frame", (f: VexaFrame) => {
      void this.onFrame(f).catch((err: unknown) =>
        opts.log.warn("vexa frame handling failed", { error: String(err) }),
      );
    });
    opts.stream.on("open", () => {
      for (const m of this.live()) {
        void this.sync(m).catch(() => undefined);
      }
    });
  }

  private live(): Meeting[] {
    return this.opts.registry.all().filter((m) => m.nativeId !== undefined && !m.terminal);
  }

  async join(meeting: Meeting, args: JoinArgs): Promise<void> {
    const nativeId = meeting.nativeId as string;
    const body = {
      platform: meeting.platform,
      native_meeting_id: nativeId,
      bot_name: args.displayName,
      recording_enabled: false,
      automatic_leave: { max_wait_for_admission: this.opts.lobbyTimeoutS * MS_PER_S },
      ...(args.voice ? { voice_agent_enabled: true } : {}),
      ...(args.passcode ? { passcode: args.passcode } : {}),
      ...(args.meetingUrl ? { meeting_url: args.meetingUrl } : {}),
      ...(args.teamsBaseHost ? { teams_base_host: args.teamsBaseHost } : {}),
    };
    let row: VexaMeeting | undefined;
    try {
      row = await this.opts.client.createBot(body);
    } catch (err) {
      if (err instanceof VexaHttpError && err.status === VEXA_STATUS.HTTP_CONFLICT) {
        row = await this.adoptRunning(meeting);
        if (!row) {
          throw new QuorumError("upstream_error", err.message);
        }
      } else {
        throw err;
      }
    }
    meeting.vexaId = row.id;
    this.opts.stream.subscribe(meeting.platform, nativeId);
    await this.applyStatus(meeting, row.status, row);
  }

  /** On 409 (a bot already runs for this meeting) adopt that bot instead of failing. */
  private async adoptRunning(meeting: Meeting): Promise<VexaMeeting | undefined> {
    const rows = await this.opts.client.listBots(meeting.platform);
    return rows.find(
      (r) => r.native_meeting_id === meeting.nativeId && !TERMINAL_VEXA.has(r.status),
    );
  }

  async leave(meeting: Meeting): Promise<void> {
    try {
      await this.opts.client.stopBot(meeting.platform, meeting.nativeId as string);
    } catch (err) {
      if (!(err instanceof VexaHttpError && err.status === VEXA_STATUS.HTTP_NOT_FOUND)) {
        throw err;
      }
    }
    meeting.setState("ended", "left");
    this.release(meeting);
  }

  /** The live feed is authoritative while connected; only a disconnected feed needs a REST read. */
  async refresh(meeting: Meeting): Promise<void> {
    if (!this.opts.stream.connected) {
      await this.sync(meeting);
    }
  }

  private async sync(meeting: Meeting): Promise<void> {
    if (meeting.terminal) {
      return;
    }
    const row = await this.findRow(meeting);
    if (row) {
      await this.applyStatus(meeting, row.status, row);
    }
  }

  private async findRow(meeting: Meeting): Promise<VexaMeeting | undefined> {
    const rows = await this.opts.client.listBots(meeting.platform);
    return (
      rows.find((r) => meeting.vexaId !== undefined && r.id === meeting.vexaId) ??
      rows.find((r) => r.native_meeting_id === meeting.nativeId)
    );
  }

  async chat(meeting: Meeting, text: string): Promise<void> {
    try {
      await this.opts.client.postChat(meeting.platform, meeting.nativeId as string, text);
    } catch (err) {
      throw this.liveActError(err, "chat");
    }
    this.echoes.set(text.trim(), Date.now());
  }

  async say(meeting: Meeting, text: string): Promise<void> {
    if (!meeting.voice) {
      throw new QuorumError(
        "platform_unavailable",
        "the bot joined without voice; join with voice:true to speak",
      );
    }
    try {
      await this.opts.client.speak(
        meeting.platform,
        meeting.nativeId as string,
        text,
        meeting.voiceId,
      );
    } catch (err) {
      if (
        err instanceof VexaHttpError &&
        (err.status === VEXA_STATUS.HTTP_NOT_FOUND || err.status === VEXA_STATUS.HTTP_CONFLICT)
      ) {
        throw new QuorumError("platform_unavailable", `speak is not available: ${err.detail}`);
      }
      throw err;
    }
  }

  /** chat/speak errors: 409 means the bot is not admitted; a 422 naming the platform means unsupported. */
  private liveActError(err: unknown, what: string): unknown {
    if (!(err instanceof VexaHttpError)) {
      return err;
    }
    if (err.status === VEXA_STATUS.HTTP_CONFLICT) {
      return new QuorumError("not_live", `the bot is not in the meeting: ${err.detail}`);
    }
    if (err.status === VEXA_STATUS.HTTP_NOT_FOUND) {
      if (/^not found$/i.test(err.detail)) {
        return new QuorumError("platform_unavailable", `${what} is not served by this Vexa`);
      }
      return new QuorumError("not_live", `the bot is not in the meeting: ${err.detail}`);
    }
    if (
      err.status === VEXA_STATUS.HTTP_UNPROCESSABLE &&
      /cannot be sent|not supported|unsupported/i.test(err.detail)
    ) {
      return new QuorumError("platform_unavailable", err.detail);
    }
    return err;
  }

  async erase(meeting: Meeting): Promise<void> {
    if (!meeting.terminal) {
      await this.leave(meeting);
    }
    try {
      await this.opts.client.deleteMeeting(meeting.platform, meeting.nativeId as string);
    } catch (err) {
      // Nothing upstream means nothing left to erase.
      if (!(err instanceof VexaHttpError && err.status === VEXA_STATUS.HTTP_NOT_FOUND)) {
        throw err;
      }
    }
  }

  private release(meeting: Meeting): void {
    const nativeId = meeting.nativeId as string;
    const stillUsed = this.live().some(
      (m) => m !== meeting && m.platform === meeting.platform && m.nativeId === nativeId,
    );
    if (!stillUsed) {
      this.opts.stream.unsubscribe(meeting.platform, nativeId);
    }
  }

  private async applyStatus(meeting: Meeting, status: string, row?: VexaMeeting): Promise<void> {
    let completion = row?.completion_reason;
    let stage = row?.failure_stage;
    if (TERMINAL_VEXA.has(status) && completion === undefined && stage === undefined) {
      try {
        const found = await this.findRow(meeting);
        completion = found?.completion_reason;
        stage = found?.failure_stage;
      } catch (err) {
        this.opts.log.warn("vexa: could not read the end reason", { error: String(err) });
      }
    }
    const mapped = mapVexaStatus(status, completion, stage);
    meeting.setState(mapped.state, mapped.reason);
    if (meeting.terminal) {
      this.release(meeting);
    }
  }

  /** Finds the meeting a frame is about: by platform and native id, else by Vexa's numeric id. */
  private route(frame: VexaFrame): Meeting[] {
    const ref = (frame.meeting ?? {}) as Record<string, unknown>;
    const platform = str(ref.platform) ?? str(frame.platform);
    const nativeId = str(ref.native_id) ?? str(frame.native) ?? str(frame.native_meeting_id);
    const vexaId = Number(ref.id ?? frame.meeting_id);
    return this.live().filter(
      (m) =>
        (nativeId !== undefined &&
          m.nativeId === nativeId &&
          (!platform || m.platform === platform)) ||
        (Number.isFinite(vexaId) && m.vexaId === vexaId),
    );
  }

  async onFrame(frame: VexaFrame): Promise<void> {
    switch (frame.type) {
      case "transcript": {
        const confirmed = Array.isArray(frame.confirmed) ? frame.confirmed : [];
        const pending = Array.isArray(frame.pending) ? frame.pending : [];
        for (const m of this.route(frame)) {
          for (const seg of confirmed as VexaSegment[]) {
            this.addSegment(m, seg, true);
          }
          for (const seg of pending as VexaSegment[]) {
            this.addSegment(m, seg, false);
          }
        }
        return;
      }
      case "transcription_segment":
        for (const m of this.route(frame)) {
          this.addSegment(m, frame as VexaSegment, frame.completed !== false);
        }
        return;
      case "chat_message":
        for (const m of this.route(frame)) {
          this.addChat(m, frame.sender, frame.text, frame.timestamp);
        }
        return;
      case "meeting.status": {
        const payload = (frame.payload ?? {}) as Record<string, unknown>;
        const status = str(payload.status) ?? str(frame.status);
        if (!status) {
          return;
        }
        for (const m of this.route(frame)) {
          await this.applyStatus(m, status);
        }
        return;
      }
      case "error":
        this.opts.log.warn("vexa ws error frame", { error: str(frame.error) });
        return;
      default:
        return;
    }
  }

  private addSegment(m: Meeting, seg: VexaSegment, final: boolean): void {
    const text = str(seg.text) ?? "";
    if (seg.source === "chat") {
      this.addChat(m, seg.speaker, text, chatTimestamp(seg));
      return;
    }
    const speaker = person(seg.speaker);
    const start = num(seg.start ?? seg.start_time);
    const end = num(seg.end ?? seg.end_time);
    const key = str(seg.segment_id) ?? `${speaker.id}:${start}`;
    m.addSegment({ key, speaker, text, start, end, final: final && seg.completed !== false });
  }

  /**
   * Vexa delivers each chat line twice on main (a `chat_message` frame and a `source:"chat"`
   * transcript segment), so lines are de-duplicated on (sender, text, timestamp).
   */
  private addChat(m: Meeting, sender: unknown, text: unknown, timestamp: unknown): void {
    const body = (str(text) ?? "").trim();
    if (!body) {
      return;
    }
    const author = person(sender);
    const ts = typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : undefined;
    let seen = this.chatSeen.get(m);
    if (!seen) {
      seen = new Set();
      this.chatSeen.set(m, seen);
    }
    const dedupe = `${author.id}\u0000${body}\u0000${ts ?? ""}`;
    if (ts !== undefined) {
      if (seen.has(dedupe)) {
        return;
      }
      seen.add(dedupe);
    }
    if (this.isEcho(body)) {
      return;
    }
    m.addChat({ author, text: body, at: new Date(ts ?? Date.now()).toISOString() });
  }

  /** Vexa reads back the bot's own chat lines as ordinary messages; drop them once. */
  private isEcho(text: string): boolean {
    const now = Date.now();
    for (const [t, at] of this.echoes) {
      if (now - at > this.opts.echoWindowS * MS_PER_S) {
        this.echoes.delete(t);
      }
    }
    if (this.echoes.has(text)) {
      this.echoes.delete(text);
      return true;
    }
    return false;
  }
}
