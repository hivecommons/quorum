/**
 * PCM helpers for Discord voice receive. Discord sends 48 kHz stereo Opus; Whisper wants 16 kHz
 * mono. Decoded frames are downmixed and decimated by 3, then wrapped as a 16-bit PCM WAV file.
 */

export const DISCORD_SAMPLE_RATE = 48_000;
export const DISCORD_CHANNELS = 2;
export const STT_SAMPLE_RATE = 16_000;
const DECIMATION = DISCORD_SAMPLE_RATE / STT_SAMPLE_RATE;
const BYTES_PER_SAMPLE = 2;
const WAV_HEADER_BYTES = 44;
const MS_PER_S = 1000;

/** 48 kHz interleaved stereo s16le to 16 kHz mono, averaging each 3-frame block of both channels. */
export function toMono16k(pcm: Buffer): Int16Array {
  const frames = Math.floor(pcm.length / (BYTES_PER_SAMPLE * DISCORD_CHANNELS));
  const out = new Int16Array(Math.floor(frames / DECIMATION));
  for (let i = 0; i < out.length; i++) {
    let sum = 0;
    for (let f = 0; f < DECIMATION; f++) {
      const frame = (i * DECIMATION + f) * DISCORD_CHANNELS * BYTES_PER_SAMPLE;
      sum += pcm.readInt16LE(frame) + pcm.readInt16LE(frame + BYTES_PER_SAMPLE);
    }
    out[i] = Math.round(sum / (DECIMATION * DISCORD_CHANNELS));
  }
  return out;
}

export function encodeWav(samples: Int16Array, sampleRate = STT_SAMPLE_RATE): Buffer {
  const dataBytes = samples.length * BYTES_PER_SAMPLE;
  const buf = Buffer.alloc(WAV_HEADER_BYTES + dataBytes);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(WAV_HEADER_BYTES - 8 + dataBytes, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * BYTES_PER_SAMPLE, 28);
  buf.writeUInt16LE(BYTES_PER_SAMPLE, 32);
  buf.writeUInt16LE(BYTES_PER_SAMPLE * 8, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) {
    buf.writeInt16LE(samples[i] ?? 0, WAV_HEADER_BYTES + i * BYTES_PER_SAMPLE);
  }
  return buf;
}

/** Accumulates one speaker's 16 kHz samples between silences. */
export class Utterance {
  private chunks: Int16Array[] = [];
  private samples = 0;

  constructor(public startMs: number) {}

  push(chunk: Int16Array): void {
    this.chunks.push(chunk);
    this.samples += chunk.length;
  }

  get durationMs(): number {
    return (this.samples / STT_SAMPLE_RATE) * MS_PER_S;
  }

  /** Returns everything buffered and starts a new utterance right after it. */
  take(): { samples: Int16Array; startMs: number; endMs: number } {
    const out = new Int16Array(this.samples);
    let offset = 0;
    for (const c of this.chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    const startMs = this.startMs;
    const endMs = startMs + this.durationMs;
    this.chunks = [];
    this.samples = 0;
    this.startMs = endMs;
    return { samples: out, startMs, endMs };
  }
}
