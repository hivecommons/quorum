import type {
  ChatDelivery,
  ChatOptions,
  JoinArgs,
  PlatformAdapter,
  SayOutcome,
} from "../adapter.js";
import type { Config } from "../config.js";
import { encodeWav } from "../discord/audio.js";
import { nameHints, type Transcriber } from "../discord/transcribe.js";
import { QuorumError } from "../errors.js";
import type { Logger } from "../log.js";
import type { Meeting, Person } from "../meeting.js";
import { Segmenter, type Utterance } from "./segmenter.js";

/**
 * The `companion` platform: a desktop app on a person's own computer captures their meeting
 * client's audio (the `call` channel) and their microphone (the `mic` channel) and hive relays it
 * here as raw 16 kHz mono s16le PCM chunks. Nothing joins the meeting itself, so there is no bot
 * to detect and no meeting chat: lines hive posts go to an outbox the companion window reads.
 *
 * Each channel is segmented at silences (segmenter.ts) and every utterance is transcribed by the
 * shared Whisper service, one at a time per meeting so segments keep their spoken order.
 */

export const COMPANION_CHANNELS = ["call", "mic"] as const;
export type CompanionChannel = (typeof COMPANION_CHANNELS)[number];

const BYTES_PER_SAMPLE = 2;
const MS_PER_S = 1000;
/** The speaker every `call` segment is attributed to: the meeting client mixes everyone else. */
export const CALL_SPEAKER: Person = { id: "call", name: "Call" };
export const DEFAULT_HOST_NAME = "Host";
const HOST_SPEAKER_ID = "host";

export function isCompanionChannel(v: string | null | undefined): v is CompanionChannel {
  return (COMPANION_CHANNELS as readonly string[]).includes(v ?? "");
}

/** A chunk arrived out of order: `expected` is the seq the channel wants next. */
export class ChunkGapError extends QuorumError {
  constructor(readonly expected: number) {
    super("invalid_argument", `chunk out of order; expected seq ${expected}`);
  }
}

export interface OutboxLine {
  seq: number;
  text: string;
  at: string;
}

interface ChannelState {
  segmenter: Segmenter;
  nextSeq: number;
}

interface Live {
  hostName: string;
  channels: Map<CompanionChannel, ChannelState>;
  outbox: OutboxLine[];
  outboxSeq: number;
  /** Highest outbox seq the companion has fetched. */
  readSeq: number;
  /** Transcriptions run one after another so segments stay in spoken order. */
  chain: Promise<void>;
}

export interface CompanionAdapterOptions {
  config: Config;
  log: Logger;
  transcriber: Transcriber | undefined;
}

export interface ChunkResult {
  seq: number;
  duplicate: boolean;
}

export class CompanionAdapter implements PlatformAdapter {
  private readonly live = new Map<string, Live>();

  constructor(private readonly opts: CompanionAdapterOptions) {}

  async join(meeting: Meeting, args: JoinArgs): Promise<void> {
    if (!this.opts.transcriber) {
      throw new QuorumError(
        "platform_unavailable",
        "QUORUM_TRANSCRIBE_URL is not set, so companion audio cannot be transcribed",
      );
    }
    const { config } = this.opts;
    const channels = new Map<CompanionChannel, ChannelState>();
    for (const c of COMPANION_CHANNELS) {
      channels.set(c, {
        segmenter: new Segmenter({
          silenceMs: config.companionSilenceMs,
          minSpeechMs: config.companionMinSpeechMs,
          maxSegmentMs: config.companionMaxSegmentS * MS_PER_S,
          threshold: config.companionVadThreshold,
        }),
        nextSeq: 0,
      });
    }
    this.live.set(meeting.id, {
      hostName: args.hostName?.trim() || DEFAULT_HOST_NAME,
      channels,
      outbox: [],
      outboxSeq: 0,
      readSeq: 0,
      chain: Promise.resolve(),
    });
    meeting.setState("live");
  }

  private liveFor(meeting: Meeting): Live {
    const live = this.live.get(meeting.id);
    if (!live || meeting.state !== "live") {
      throw new QuorumError("not_live", `the meeting is ${meeting.state}, not live`);
    }
    return live;
  }

  /**
   * Stores chunk `seq` of one channel. Chunks are accepted in order only: a gap throws
   * ChunkGapError, and a chunk at or below the last stored seq is acknowledged and ignored (a
   * resend after a lost response).
   */
  audio(meeting: Meeting, channel: CompanionChannel, seq: number, body: Buffer): ChunkResult {
    const live = this.liveFor(meeting);
    const state = live.channels.get(channel) as ChannelState;
    if (seq < state.nextSeq) {
      return { seq, duplicate: true };
    }
    if (seq > state.nextSeq) {
      throw new ChunkGapError(state.nextSeq);
    }
    if (body.length % BYTES_PER_SAMPLE !== 0) {
      throw new QuorumError("invalid_argument", "a chunk must be whole 16-bit samples");
    }
    state.nextSeq += 1;
    const pcm = new Int16Array(body.length / BYTES_PER_SAMPLE);
    for (let i = 0; i < pcm.length; i++) {
      pcm[i] = body.readInt16LE(i * BYTES_PER_SAMPLE);
    }
    for (const u of state.segmenter.push(pcm)) {
      this.enqueue(meeting, live, channel, u);
    }
    return { seq, duplicate: false };
  }

  private enqueue(meeting: Meeting, live: Live, channel: CompanionChannel, u: Utterance): void {
    live.chain = live.chain.then(() => this.transcribe(meeting, live, channel, u));
  }

  private async transcribe(
    meeting: Meeting,
    live: Live,
    channel: CompanionChannel,
    u: Utterance,
  ): Promise<void> {
    let text: string;
    try {
      text = await (this.opts.transcriber as Transcriber).transcribe(encodeWav(u.samples), {
        hints: nameHints(meeting.displayName),
      });
    } catch (err) {
      this.opts.log.warn("companion: transcription failed; segment dropped", {
        error: String(err),
      });
      return;
    }
    const speaker: Person =
      channel === "mic" ? { id: HOST_SPEAKER_ID, name: live.hostName } : CALL_SPEAKER;
    meeting.addSegment({
      key: `${channel}:${Math.round(u.startMs)}`,
      speaker,
      text,
      start: u.startMs / MS_PER_S,
      end: u.endMs / MS_PER_S,
      final: true,
    });
  }

  /** Lines for the companion window after `after`; fetching them marks them delivered. */
  outbox(meeting: Meeting, after: number): { lines: OutboxLine[]; next_seq: number } {
    const live = this.live.get(meeting.id);
    if (!live) {
      throw new QuorumError("not_live", `the meeting is ${meeting.state}, not live`);
    }
    const lines = live.outbox.filter((l) => l.seq > after);
    const last = lines.at(-1);
    if (last && last.seq > live.readSeq) {
      live.readSeq = last.seq;
    }
    return { lines, next_seq: last ? last.seq : Math.max(after, 0) };
  }

  async leave(meeting: Meeting): Promise<void> {
    const live = this.live.get(meeting.id);
    if (live) {
      for (const [channel, state] of live.channels) {
        const u = state.segmenter.flush();
        if (u) {
          this.enqueue(meeting, live, channel, u);
        }
      }
      await live.chain;
      this.live.delete(meeting.id);
    }
    meeting.setState("ended", "left");
  }

  async refresh(): Promise<void> {
    // The companion's own requests are the live feed; there is nothing upstream to poll.
  }

  /**
   * Queues a line for the companion window. With `confirm`, waits until the companion fetched it
   * (`confirmed`) or the confirm timeout passed (`unconfirmed`); without it answers `unconfirmed`.
   */
  async chat(meeting: Meeting, text: string, opts?: ChatOptions): Promise<ChatDelivery> {
    const live = this.liveFor(meeting);
    const { config } = this.opts;
    live.outboxSeq += 1;
    const seq = live.outboxSeq;
    live.outbox.push({ seq, text, at: new Date().toISOString() });
    if (live.outbox.length > config.companionOutboxMax) {
      live.outbox.shift();
    }
    if (!opts?.confirm) {
      return "unconfirmed";
    }
    const deadline = Date.now() + config.chatConfirmTimeoutMs;
    while (live.readSeq < seq) {
      if (Date.now() >= deadline) {
        return "unconfirmed";
      }
      await new Promise((r) => setTimeout(r, config.chatConfirmPollMs));
    }
    return "confirmed";
  }

  async say(): Promise<SayOutcome> {
    throw new QuorumError(
      "platform_unavailable",
      "companion meetings cannot speak yet; replies stay in the companion window",
    );
  }

  async erase(meeting: Meeting): Promise<void> {
    this.live.delete(meeting.id);
  }

  async close(): Promise<void> {
    this.live.clear();
  }
}
