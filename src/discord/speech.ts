import { createHash } from "node:crypto";
import type { TtsClient } from "./tts.js";

/**
 * Speech synthesis for `say`, built so the first sound comes quickly:
 *
 * - A line is cut into sentences and each sentence is one clip. The first sentence can play while
 *   the next is synthesized, so a long line starts after one sentence's synthesis, not all of it.
 * - Clips are cached by voice and text (bounded by QUORUM_TTS_CACHE_MAX_BYTES, least recently used
 *   dropped first), across meetings. Lines a bot says in every meeting (its introduction, its
 *   acknowledgements, "Leaving now.") are synthesized once; `say.prewarm` fills the cache before
 *   they are needed.
 * - Each clip gets a few milliseconds of fade in and out, so a clip that starts or ends off zero
 *   does not click.
 */

/** Sentences shorter than this are joined to a neighbour: a clip per "Hi." is all overhead. */
export const MIN_SENTENCE_CHARS = 24;
/** Kokoro's `pcm` is 24 kHz mono s16le. */
const TTS_SAMPLE_RATE = 24_000;
const BYTES_PER_SAMPLE = 2;
const MS_PER_S = 1000;
/** Fade length at each end of a clip. */
export const FADE_MS = 5;

/**
 * Cuts text into sentences at `.`, `!`, `?` or `:` followed by whitespace, keeping the
 * punctuation, and joins pieces shorter than MIN_SENTENCE_CHARS to the next one (the last to the
 * one before). Text with no such break is one sentence.
 */
export function splitSentences(text: string): string[] {
  const pieces = text
    .split(/(?<=[.!?:]["')\]]?)\s+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const out: string[] = [];
  let carry = "";
  for (const p of pieces) {
    const cur = carry ? `${carry} ${p}` : p;
    if (cur.length < MIN_SENTENCE_CHARS) {
      carry = cur;
    } else {
      out.push(cur);
      carry = "";
    }
  }
  if (carry) {
    const last = out.pop();
    out.push(last ? `${last} ${carry}` : carry);
  }
  return out;
}

/** Fades the first and last FADE_MS of 24 kHz mono s16le PCM linearly, in place. */
export function fadeEdges(pcm: Buffer): Buffer {
  const samples = Math.floor(pcm.length / BYTES_PER_SAMPLE);
  const fade = Math.min(
    Math.floor((TTS_SAMPLE_RATE * FADE_MS) / MS_PER_S),
    Math.floor(samples / 2),
  );
  for (let i = 0; i < fade; i++) {
    const gain = i / fade;
    const head = i * BYTES_PER_SAMPLE;
    const tail = (samples - 1 - i) * BYTES_PER_SAMPLE;
    pcm.writeInt16LE(Math.round(pcm.readInt16LE(head) * gain), head);
    pcm.writeInt16LE(Math.round(pcm.readInt16LE(tail) * gain), tail);
  }
  return pcm;
}

function cacheKey(voice: string, text: string): string {
  return createHash("sha256").update(voice).update("\0").update(text).digest("hex");
}

export interface Clip {
  /** 24 kHz mono s16le PCM, faded at both ends. */
  pcm: Promise<Buffer>;
  /** The clip was in the cache (or already being synthesized) when it was asked for. */
  cached: boolean;
}

/** A TTS client with a clip cache. Safe to share between meetings. */
export class SpeechSynth {
  /** Insertion order is recency: a hit is re-inserted, the first key is the least recent. */
  private readonly ready = new Map<string, Buffer>();
  private readonly inFlight = new Map<string, Promise<Buffer>>();
  private bytes = 0;
  /** Prewarm runs one request at a time behind this, so it never crowds out a live `say`. */
  private warming: Promise<void> = Promise.resolve();
  /** Sentences waiting behind `warming`, so one named twice is queued and counted once. */
  private readonly waiting = new Set<string>();

  constructor(
    private readonly tts: TtsClient,
    private readonly maxBytes: number,
  ) {}

  get cachedBytes(): number {
    return this.bytes;
  }

  /** Whether the sentence's clip is in the cache now. */
  has(text: string, voice: string): boolean {
    return this.ready.has(cacheKey(voice, text));
  }

  /** One sentence's clip, from the cache when it is there. */
  clip(text: string, voice: string): Clip {
    const key = cacheKey(voice, text);
    const hit = this.ready.get(key);
    if (hit) {
      this.ready.delete(key);
      this.ready.set(key, hit);
      return { pcm: Promise.resolve(hit), cached: true };
    }
    const running = this.inFlight.get(key);
    if (running) {
      return { pcm: running, cached: true };
    }
    const pcm = this.tts.synthesize(text, voice).then((raw) => {
      const clip = fadeEdges(raw);
      this.store(key, clip);
      return clip;
    });
    this.inFlight.set(key, pcm);
    void pcm.then(
      () => this.inFlight.delete(key),
      () => this.inFlight.delete(key),
    );
    return { pcm, cached: false };
  }

  private store(key: string, clip: Buffer): void {
    if (clip.length > this.maxBytes) {
      return;
    }
    this.ready.set(key, clip);
    this.bytes += clip.length;
    for (const [oldest, buf] of this.ready) {
      if (this.bytes <= this.maxBytes) {
        break;
      }
      this.ready.delete(oldest);
      this.bytes -= buf.length;
    }
  }

  /**
   * Synthesizes every sentence of `lines` into the cache, one request at a time, in the
   * background. Returns how many sentences were not cached yet. Failures are skipped: a line
   * that cannot be warmed is synthesized when it is said.
   */
  prewarm(lines: string[], voice: string): number {
    let queued = 0;
    for (const sentence of lines.flatMap(splitSentences)) {
      const key = cacheKey(voice, sentence);
      if (this.ready.has(key) || this.inFlight.has(key) || this.waiting.has(key)) {
        continue;
      }
      queued += 1;
      this.waiting.add(key);
      this.warming = this.warming.then(() => {
        this.waiting.delete(key);
        return this.clip(sentence, voice).pcm.then(
          () => undefined,
          () => undefined,
        );
      });
    }
    return queued;
  }
}
