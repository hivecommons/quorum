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
import {
  COMPANION_SAMPLE_RATE,
  Segmenter,
  type OpenUtterance,
  type Utterance,
} from "./segmenter.js";

/**
 * The `companion` platform: a desktop app on a person's own computer captures their meeting
 * client's audio (the `call` channel) and their microphone (the `mic` channel) and hive relays it
 * here as raw 16 kHz mono s16le PCM chunks. Nothing joins the meeting itself, so there is no bot
 * to detect and no meeting chat: lines hive posts go to an outbox the companion window reads.
 *
 * Each channel is segmented at silences (segmenter.ts) and every utterance is transcribed by the
 * shared Whisper service, one at a time per meeting so segments keep their spoken order.
 *
 * Early transcription: the end of an utterance is only known once QUORUM_COMPANION_SILENCE_MS of
 * silence followed it, and the companion sends audio in chunks (one second in the desktop app), so
 * waiting for that before asking Whisper costs up to a whole chunk plus the transcription time.
 * Instead, as soon as an open utterance is followed by QUORUM_COMPANION_EARLY_MS of silence it is
 * transcribed ahead of its end (padded with silence to the length it would have at its end). The
 * answer goes out as a draft segment (`final:false`), and when
 * the silence then runs its full length with no more speech the same answer becomes the final
 * segment without a second request. If the speaker carries on, the early answer is dropped and the
 * utterance is transcribed whole when it ends, so a pause never cuts anyone off.
 *
 * Every final segment logs one `companion: segment timing` line with the stages from the last
 * speech sample to the segment event (see SegmentTiming).
 *
 * The listening tone (say.tone) is played by the companion on the person's own computer: tone()
 * marks one tone pending and the next outbox fetch carries `tone:true` once. It is only asked for
 * while the companion is fetching its outbox (connected), and a tone left unfetched past
 * QUORUM_COMPANION_TONE_TTL_MS is dropped, so a late chime never plays.
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

/** GET /companion/outbox. */
export interface CompanionOutbox {
  lines: OutboxLine[];
  next_seq: number;
  /** Play the listening tone now (once per tone asked for). */
  tone: boolean;
}

/** An utterance transcribed ahead of its end; `text` is undefined when the request failed. */
interface Early {
  startMs: number;
  speechEndMs: number;
  sentAt: number;
  doneAt: number | undefined;
  text: Promise<string | undefined>;
}

interface ChannelState {
  segmenter: Segmenter;
  nextSeq: number;
  /**
   * Wall clock minus audio clock, the least seen: a chunk cannot arrive before its last sample
   * was captured, so the smallest difference is the best estimate of when audio time zero was.
   */
  clockOffsetMs: number;
  /** The open utterance's last speech end and when the chunk holding it arrived. */
  speechEndMs: number;
  speechEndReceivedAt: number;
  early: Early | undefined;
}

/**
 * One final segment's stages, in milliseconds. `capture_ms` is the last speech sample to the
 * chunk holding it arriving (the companion's own chunking and the network), `endpoint_ms` that
 * arrival to the end of the utterance being known, `stt_ms` the transcription request that gave
 * the text, `total_ms` the last speech sample to the segment event. `early` says the text came
 * from the early transcription, so `stt_ms` overlapped the wait for the end.
 */
export interface SegmentTiming {
  channel: CompanionChannel;
  clip_ms: number;
  capture_ms: number;
  endpoint_ms: number;
  stt_ms: number;
  total_ms: number;
  early: boolean;
}

interface Live {
  hostName: string;
  channels: Map<CompanionChannel, ChannelState>;
  outbox: OutboxLine[];
  outboxSeq: number;
  /** Highest outbox seq the companion has fetched. */
  readSeq: number;
  /** When the companion last fetched its outbox (undefined: never). */
  polledAt: number | undefined;
  /** When the pending listening tone was asked for (undefined: none pending). */
  toneAt: number | undefined;
  /** Transcriptions run one after another so segments stay in spoken order. */
  chain: Promise<void>;
}

export interface CompanionAdapterOptions {
  config: Config;
  log: Logger;
  transcriber: Transcriber | undefined;
  /** Wall clock in ms; tests replace it. */
  now?: () => number;
}

export interface ChunkResult {
  seq: number;
  duplicate: boolean;
}

export class CompanionAdapter implements PlatformAdapter {
  private readonly live = new Map<string, Live>();
  private readonly now: () => number;

  constructor(private readonly opts: CompanionAdapterOptions) {
    this.now = opts.now ?? Date.now;
  }

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
        clockOffsetMs: Number.POSITIVE_INFINITY,
        speechEndMs: 0,
        speechEndReceivedAt: 0,
        early: undefined,
      });
    }
    this.live.set(meeting.id, {
      hostName: args.hostName?.trim() || DEFAULT_HOST_NAME,
      channels,
      outbox: [],
      outboxSeq: 0,
      readSeq: 0,
      polledAt: undefined,
      toneAt: undefined,
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
    const receivedAt = this.now();
    const done = state.segmenter.push(pcm);
    state.clockOffsetMs = Math.min(state.clockOffsetMs, receivedAt - state.segmenter.receivedMs);
    for (const u of done) {
      this.enqueue(meeting, live, channel, state, u, receivedAt);
    }
    this.transcribeEarly(meeting, live, channel, state, receivedAt);
    return { seq, duplicate: false };
  }

  private speaker(live: Live, channel: CompanionChannel): Person {
    return channel === "mic" ? { id: HOST_SPEAKER_ID, name: live.hostName } : CALL_SPEAKER;
  }

  private segmentKey(channel: CompanionChannel, u: Utterance): string {
    return `${channel}:${Math.round(u.startMs)}`;
  }

  /** When the chunk holding the utterance's last speech arrived (an early answer may know). */
  private speechReceivedAt(state: ChannelState, u: Utterance, fallback: number): number {
    return state.speechEndMs === u.speechEndMs ? state.speechEndReceivedAt : fallback;
  }

  /**
   * Starts transcribing the open utterance ahead of its end once a short silence follows its last
   * speech, at most once per speech end, and publishes the answer as a draft while the utterance
   * is still open.
   */
  private transcribeEarly(
    meeting: Meeting,
    live: Live,
    channel: CompanionChannel,
    state: ChannelState,
    receivedAt: number,
  ): void {
    const open = state.segmenter.peek();
    if (!open) {
      return;
    }
    if (open.speechEndMs !== state.speechEndMs) {
      state.speechEndMs = open.speechEndMs;
      state.speechEndReceivedAt = receivedAt;
    }
    const { companionEarlyMs, companionMinSpeechMs } = this.opts.config;
    if (
      companionEarlyMs <= 0 ||
      open.trailingSilenceMs < companionEarlyMs ||
      open.speechMs < companionMinSpeechMs
    ) {
      return;
    }
    const prev = state.early;
    if (prev && prev.startMs === open.startMs && prev.speechEndMs === open.speechEndMs) {
      return;
    }
    const early: Early = {
      startMs: open.startMs,
      speechEndMs: open.speechEndMs,
      sentAt: this.now(),
      doneAt: undefined,
      // One try: a busy service is asked again, with retries, when the utterance ends.
      text: (this.opts.transcriber as Transcriber)
        .transcribe(encodeWav(this.padToEnd(open)), {
          hints: nameHints(meeting.displayName),
          maxAttempts: 1,
        })
        .then(
          (text) => text,
          () => undefined,
        ),
    };
    state.early = early;
    void early.text.then((text) => {
      early.doneAt = this.now();
      const still = state.segmenter.peek();
      if (
        text === undefined ||
        state.early !== early ||
        still?.startMs !== early.startMs ||
        still.speechEndMs !== early.speechEndMs ||
        this.live.get(meeting.id) !== live
      ) {
        return;
      }
      meeting.addSegment({
        key: this.segmentKey(channel, open),
        speaker: this.speaker(live, channel),
        text,
        start: open.startMs / MS_PER_S,
        end: open.endMs / MS_PER_S,
        final: false,
      });
    });
  }

  /**
   * The open utterance with digital silence added until it is followed by the full
   * QUORUM_COMPANION_SILENCE_MS, the clip the utterance would be sent as once it ended. Whisper
   * given a clip that stops right after the last word tends to invent a continuation.
   */
  private padToEnd(open: OpenUtterance): Int16Array {
    const missingMs = this.opts.config.companionSilenceMs - open.trailingSilenceMs;
    if (missingMs <= 0) {
      return open.samples;
    }
    const pad = Math.round((missingMs * COMPANION_SAMPLE_RATE) / MS_PER_S);
    const out = new Int16Array(open.samples.length + pad);
    out.set(open.samples);
    return out;
  }

  private enqueue(
    meeting: Meeting,
    live: Live,
    channel: CompanionChannel,
    state: ChannelState,
    u: Utterance,
    endedAt: number,
  ): void {
    const held = state.early;
    const early =
      held && held.startMs === u.startMs && held.speechEndMs === u.speechEndMs ? held : undefined;
    state.early = undefined;
    const speechReceivedAt = this.speechReceivedAt(state, u, endedAt);
    const speechAt = Number.isFinite(state.clockOffsetMs)
      ? state.clockOffsetMs + u.speechEndMs
      : speechReceivedAt;
    live.chain = live.chain.then(() =>
      this.transcribe(meeting, live, channel, u, early, { speechAt, speechReceivedAt, endedAt }),
    );
  }

  private async transcribe(
    meeting: Meeting,
    live: Live,
    channel: CompanionChannel,
    u: Utterance,
    early: Early | undefined,
    at: { speechAt: number; speechReceivedAt: number; endedAt: number },
  ): Promise<void> {
    let text = early ? await early.text : undefined;
    let sttMs = early ? (early.doneAt ?? this.now()) - early.sentAt : 0;
    const reused = text !== undefined;
    if (text === undefined) {
      const sentAt = this.now();
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
      sttMs = this.now() - sentAt;
    }
    const segment = meeting.addSegment({
      key: this.segmentKey(channel, u),
      speaker: this.speaker(live, channel),
      text,
      start: u.startMs / MS_PER_S,
      end: u.endMs / MS_PER_S,
      final: true,
    });
    if (!segment) {
      return;
    }
    const timing: SegmentTiming = {
      channel,
      clip_ms: Math.round(u.endMs - u.startMs),
      capture_ms: Math.max(0, Math.round(at.speechReceivedAt - at.speechAt)),
      endpoint_ms: Math.max(0, Math.round(at.endedAt - at.speechReceivedAt)),
      stt_ms: Math.round(sttMs),
      total_ms: Math.max(0, Math.round(this.now() - at.speechAt)),
      early: reused,
    };
    this.opts.log.info("companion: segment timing", { seq: segment.seq, ...timing });
  }

  /**
   * Lines for the companion window after `after`; fetching them marks them delivered. `tone` is
   * true once per listening tone asked for since the last fetch, while it is still fresh.
   */
  outbox(meeting: Meeting, after: number): CompanionOutbox {
    const live = this.live.get(meeting.id);
    if (!live) {
      throw new QuorumError("not_live", `the meeting is ${meeting.state}, not live`);
    }
    const now = this.now();
    live.polledAt = now;
    const tone = this.toneFresh(live, now);
    live.toneAt = undefined;
    const lines = live.outbox.filter((l) => l.seq > after);
    const last = lines.at(-1);
    if (last && last.seq > live.readSeq) {
      live.readSeq = last.seq;
    }
    return { lines, next_seq: last ? last.seq : Math.max(after, 0), tone };
  }

  /** Whether a pending tone is still worth playing. */
  private toneFresh(live: Live, now: number): boolean {
    return live.toneAt !== undefined && now - live.toneAt <= this.opts.config.companionToneTtlMs;
  }

  /**
   * Asks the companion to play the listening tone. Played (true) only while the companion is
   * connected, i.e. it fetched its outbox within QUORUM_COMPANION_CONNECTED_MS; dropped (false)
   * when it is not, or when a tone is already waiting to be fetched. The companion never speaks,
   * so no line can be in progress. Never waits and never throws.
   */
  async tone(meeting: Meeting): Promise<boolean> {
    const live = this.live.get(meeting.id);
    if (!live || meeting.state !== "live") {
      return false;
    }
    const now = this.now();
    const connected =
      live.polledAt !== undefined && now - live.polledAt <= this.opts.config.companionConnectedMs;
    if (!connected) {
      return false;
    }
    if (this.toneFresh(live, now)) {
      return false;
    }
    live.toneAt = now;
    return true;
  }

  async leave(meeting: Meeting): Promise<void> {
    const live = this.live.get(meeting.id);
    if (live) {
      for (const [channel, state] of live.channels) {
        const u = state.segmenter.flush();
        if (u) {
          this.enqueue(meeting, live, channel, state, u, this.now());
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
