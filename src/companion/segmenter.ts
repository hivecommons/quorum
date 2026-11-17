/**
 * Energy-based speech segmentation for the desktop companion's audio channels. The companion sends
 * 16 kHz mono s16le PCM; each channel is cut into utterances at silences so each one can be sent
 * to the shared Whisper service as one WAV file, the same unit Discord audio is transcribed in.
 *
 * A frame is speech when its RMS level reaches `threshold` (on the int16 scale). An utterance
 * starts at the first speech frame, ends once `silenceMs` of non-speech frames follow it (the
 * trailing silence is kept, it helps Whisper end the sentence), and is cut at `maxSegmentMs` so a
 * monologue still produces segments while it goes on. Utterances with less than `minSpeechMs` of
 * speech frames are dropped as noise.
 */

export const COMPANION_SAMPLE_RATE = 16_000;
export const FRAME_MS = 20;
const MS_PER_S = 1000;
export const FRAME_SAMPLES = (COMPANION_SAMPLE_RATE * FRAME_MS) / MS_PER_S;

export interface SegmenterOptions {
  silenceMs: number;
  minSpeechMs: number;
  maxSegmentMs: number;
  threshold: number;
}

export interface Utterance {
  samples: Int16Array;
  /** Milliseconds from the first sample this channel received. */
  startMs: number;
  endMs: number;
}

function samplesToMs(n: number): number {
  return (n / COMPANION_SAMPLE_RATE) * MS_PER_S;
}

/** Root mean square of one frame, on the int16 scale. */
export function rms(frame: Int16Array): number {
  if (frame.length === 0) {
    return 0;
  }
  let sum = 0;
  for (const s of frame) {
    sum += s * s;
  }
  return Math.sqrt(sum / frame.length);
}

export class Segmenter {
  /** Samples received so far, the clock every utterance's start and end are measured on. */
  private received = 0;
  /** Samples not yet forming a whole frame. */
  private pending: Int16Array = new Int16Array(0);
  private frames: Int16Array[] = [];
  private startSample = 0;
  private speechMs = 0;
  private silentMs = 0;

  constructor(private readonly opts: SegmenterOptions) {}

  private get open(): boolean {
    return this.frames.length > 0;
  }

  /** Feeds PCM and returns every utterance it completed, oldest first. */
  push(pcm: Int16Array): Utterance[] {
    const joined = new Int16Array(this.pending.length + pcm.length);
    joined.set(this.pending);
    joined.set(pcm, this.pending.length);
    const done: Utterance[] = [];
    let at = 0;
    for (; at + FRAME_SAMPLES <= joined.length; at += FRAME_SAMPLES) {
      const frame = joined.slice(at, at + FRAME_SAMPLES);
      const frameStart = this.received;
      this.received += FRAME_SAMPLES;
      const speech = rms(frame) >= this.opts.threshold;
      if (!this.open) {
        if (!speech) {
          continue;
        }
        this.startSample = frameStart;
        this.speechMs = 0;
        this.silentMs = 0;
      }
      this.frames.push(frame);
      if (speech) {
        this.speechMs += FRAME_MS;
        this.silentMs = 0;
      } else {
        this.silentMs += FRAME_MS;
      }
      const lengthMs = this.frames.length * FRAME_MS;
      if (this.silentMs >= this.opts.silenceMs || lengthMs >= this.opts.maxSegmentMs) {
        const u = this.close();
        if (u) {
          done.push(u);
        }
      }
    }
    this.pending = joined.slice(at);
    return done;
  }

  /** Ends the open utterance, if any (the channel stopped or the meeting ended). */
  flush(): Utterance | undefined {
    return this.open ? this.close() : undefined;
  }

  private close(): Utterance | undefined {
    const frames = this.frames;
    const speechMs = this.speechMs;
    this.frames = [];
    this.speechMs = 0;
    this.silentMs = 0;
    if (speechMs < this.opts.minSpeechMs) {
      return undefined;
    }
    const samples = new Int16Array(frames.length * FRAME_SAMPLES);
    frames.forEach((f, i) => samples.set(f, i * FRAME_SAMPLES));
    const startMs = samplesToMs(this.startSample);
    return { samples, startMs, endMs: startMs + samplesToMs(samples.length) };
  }
}
