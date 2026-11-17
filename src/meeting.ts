import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import type { VexaPlatform } from "./urls.js";

/** docs/contract.md section 1 shapes. */
export type MeetingState =
  "requested" | "joining" | "lobby" | "live" | "ended" | "failed" | "blocked";
export type Platform = VexaPlatform | "discord" | "companion";

export const TERMINAL_STATES: ReadonlySet<MeetingState> = new Set(["ended", "failed", "blocked"]);

export interface Person {
  id: string;
  name: string;
}

export interface Segment {
  meeting_id: string;
  seq: number;
  speaker: Person;
  text: string;
  start: number;
  end: number;
  final: boolean;
}

export type SegmentEvent = { type: "segment" } & Segment;

export interface ChatEvent {
  type: "chat";
  meeting_id: string;
  seq: number;
  author: Person;
  text: string;
  at: string;
}

export interface StateEvent {
  type: "state";
  meeting_id: string;
  state: MeetingState;
  reason?: string;
  /** Present on `requested` events raised from a platform (Discord slash command). */
  platform?: Platform;
  guild_id?: string;
  channel_id?: string;
  requested_by?: Person;
}

export type QuorumEvent = SegmentEvent | ChatEvent | StateEvent;

/** A segment as an adapter hands it over, before quorum numbers it. */
export interface SegmentInput {
  /** Upstream identity of the utterance; a re-send with the same key updates it in place. */
  key: string;
  speaker: Person;
  text: string;
  start: number;
  end: number;
  final: boolean;
}

export interface ChatInput {
  author: Person;
  text: string;
  at: string;
}

const ID_BYTES = 9;

export function newMeetingId(): string {
  return "m_" + randomBytes(ID_BYTES).toString("base64url");
}

interface SeenSegment {
  text: string;
  final: boolean;
}

/**
 * One meeting as quorum tracks it: state, participants, and a bounded buffer of final segments.
 * Every segment and chat event gets the next value of one per-meeting monotonic `seq`.
 */
export class Meeting {
  readonly id: string;
  readonly platform: Platform;
  readonly createdAt = Date.now();
  state: MeetingState;
  reason: string | undefined;
  endedAt: number | undefined;
  displayName: string;
  voice = false;
  /** TTS voice from meeting.join voice_id: Discord's Kokoro voice, Vexa's per-speak voice. */
  voiceId: string | undefined;
  /** Vexa addressing, set for google_meet, teams and zoom. */
  nativeId: string | undefined;
  vexaId: number | undefined;
  /** Discord addressing. */
  guildId: string | undefined;
  channelId: string | undefined;

  private seq = 0;
  private readonly bufferSize: number;
  private readonly segments: { key: string; segment: Segment }[] = [];
  private readonly replay: QuorumEvent[] = [];
  private readonly seen = new Map<string, SeenSegment>();
  private readonly people = new Map<string, Person>();
  private readonly emitter = new EventEmitter();

  constructor(opts: {
    platform: Platform;
    state?: MeetingState;
    bufferSize: number;
    displayName?: string;
    id?: string;
  }) {
    this.id = opts.id ?? newMeetingId();
    this.platform = opts.platform;
    this.state = opts.state ?? "requested";
    this.bufferSize = opts.bufferSize;
    this.displayName = opts.displayName ?? "";
    this.emitter.setMaxListeners(0);
  }

  get terminal(): boolean {
    return TERMINAL_STATES.has(this.state);
  }

  get lastSeq(): number {
    return this.seq;
  }

  onEvent(listener: (e: QuorumEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  private emit(e: QuorumEvent): void {
    if (e.type !== "state") {
      this.replay.push(e);
      if (this.replay.length > this.bufferSize) {
        this.replay.shift();
      }
    }
    this.emitter.emit("event", e);
  }

  /** Moves to `state`, emitting a state event when anything changed. Terminal states stick. */
  setState(state: MeetingState, reason?: string, extra?: Partial<StateEvent>): boolean {
    if (this.terminal && state !== this.state) {
      return false;
    }
    if (state === this.state && reason === this.reason && !extra) {
      return false;
    }
    this.state = state;
    this.reason = reason;
    if (this.terminal && this.endedAt === undefined) {
      this.endedAt = Date.now();
    }
    const event: StateEvent = { type: "state", meeting_id: this.id, state, ...extra };
    if (reason) {
      event.reason = reason;
    }
    this.emit(event);
    return true;
  }

  addParticipant(p: Person): void {
    if (p.id && !this.people.has(p.id)) {
      this.people.set(p.id, p);
    }
  }

  removeParticipant(id: string): void {
    this.people.delete(id);
  }

  get participants(): Person[] {
    return [...this.people.values()];
  }

  /**
   * Records a segment. Identical re-sends are dropped, a draft never overwrites a final, and a
   * changed final replaces the earlier final in the buffer under a new seq.
   */
  addSegment(input: SegmentInput): Segment | undefined {
    const text = input.text.trim();
    if (!text) {
      return undefined;
    }
    const prev = this.seen.get(input.key);
    if (prev) {
      const stale = prev.final
        ? !input.final || prev.text === text
        : !input.final && prev.text === text;
      if (stale) {
        return undefined;
      }
    }
    this.seen.set(input.key, { text, final: input.final });
    this.addParticipant(input.speaker);
    this.seq += 1;
    const segment: Segment = {
      meeting_id: this.id,
      seq: this.seq,
      speaker: input.speaker,
      text,
      start: input.start,
      end: input.end,
      final: input.final,
    };
    if (input.final) {
      const idx = this.segments.findIndex((s) => s.key === input.key);
      if (idx >= 0) {
        this.segments.splice(idx, 1);
      }
      this.segments.push({ key: input.key, segment });
      if (this.segments.length > this.bufferSize) {
        this.segments.shift();
      }
    }
    this.emit({ type: "segment", ...segment });
    return segment;
  }

  addChat(input: ChatInput): ChatEvent | undefined {
    const text = input.text.trim();
    if (!text) {
      return undefined;
    }
    this.addParticipant(input.author);
    this.seq += 1;
    const event: ChatEvent = {
      type: "chat",
      meeting_id: this.id,
      seq: this.seq,
      author: input.author,
      text,
      at: input.at,
    };
    this.emit(event);
    return event;
  }

  /** Final segments with seq greater than afterSeq. next_seq is the cursor for the next call. */
  readSegments(afterSeq = 0): { segments: Segment[]; next_seq: number } {
    const segments = this.segments.map((s) => s.segment).filter((s) => s.seq > afterSeq);
    const last = segments.at(-1);
    return { segments, next_seq: last ? last.seq : Math.max(afterSeq, 0) };
  }

  /** Buffered segment and chat events after afterSeq, for SSE replay. */
  replayAfter(afterSeq: number): QuorumEvent[] {
    return this.replay.filter((e) => "seq" in e && e.seq > afterSeq);
  }

  /** Drops every transcript line quorum holds for this meeting (meeting.delete). */
  clearTranscript(): void {
    this.segments.length = 0;
    this.replay.length = 0;
    this.seen.clear();
  }
}

/** All meetings this process knows about, plus a stream of every meeting's events. */
export class Registry {
  private readonly meetings = new Map<string, Meeting>();
  private readonly emitter = new EventEmitter();
  private readonly unsubscribers = new Map<string, () => void>();

  constructor(private readonly retentionMs: number) {
    this.emitter.setMaxListeners(0);
  }

  add(m: Meeting): Meeting {
    this.meetings.set(m.id, m);
    this.unsubscribers.set(
      m.id,
      m.onEvent((e) => this.emitter.emit("event", e)),
    );
    return m;
  }

  get(id: string): Meeting | undefined {
    return this.meetings.get(id);
  }

  remove(id: string): void {
    this.unsubscribers.get(id)?.();
    this.unsubscribers.delete(id);
    if (this.meetings.delete(id)) {
      this.emitter.emit("removed", id);
    }
  }

  onRemoved(listener: (id: string) => void): () => void {
    this.emitter.on("removed", listener);
    return () => this.emitter.off("removed", listener);
  }

  all(): Meeting[] {
    return [...this.meetings.values()];
  }

  /** The newest non-terminal meeting matching the predicate. */
  findActive(pred: (m: Meeting) => boolean): Meeting | undefined {
    return this.all()
      .filter((m) => !m.terminal && pred(m))
      .sort((a, b) => b.createdAt - a.createdAt)[0];
  }

  onEvent(listener: (e: QuorumEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  /** Forgets terminal meetings that ended longer ago than the retention window. */
  sweep(now = Date.now()): number {
    let removed = 0;
    for (const m of this.all()) {
      if (m.endedAt !== undefined && now - m.endedAt > this.retentionMs) {
        this.remove(m.id);
        removed += 1;
      }
    }
    return removed;
  }
}
