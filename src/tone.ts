/**
 * The listening tone: a short, soft, rising two-note chime a voice agent plays when it heard its
 * name and is about to answer (like a smart speaker's wake sound), so the room knows it is
 * listening. It is generated here from two sine waves, so there is no sample file and no licence
 * to carry, and the same design as the Vexa bot's own tone (listening-tone.ts in hivecommons/vexa),
 * so Betty chimes alike on every platform. Pure and deterministic: no I/O, no randomness.
 */

/** 24 kHz mono s16le, the same format as the TTS service's PCM, so speech helpers apply to it. */
export const TONE_RATE_HZ = 24_000;
const BYTES_PER_SAMPLE = 2;
const MS_PER_S = 1000;
const INT16_MAX = 32767;

/** The two notes, rising a perfect fourth: G5 then C6. */
export const TONE_NOTE_HZ: readonly [number, number] = [783.99, 1046.5];
/** Each note's length. Two notes make a chime about 200 ms long. */
export const TONE_NOTE_MS = 100;
/** Attack: a fast, smooth rise (no click at the start). */
export const TONE_ATTACK_MS = 8;
/** Release: the last of each note fades to exactly zero (no click at the end). */
export const TONE_RELEASE_MS = 25;
/** How far each note dies away over its length: the level falls to this fraction of its start. */
export const TONE_DECAY_RATIO = 0.12;
/** The loudest sample as a fraction of full scale: a quiet cue under speech, which peaks higher. */
export const TONE_PEAK = 0.18;
/** Hard ceiling on the loudest sample as a fraction of full scale, however the above change. */
export const TONE_PEAK_CAP = 0.25;

/** The chime as 24 kHz mono signed 16-bit little-endian PCM. */
export function renderListeningTone(): Buffer {
  const noteSamples = Math.round((TONE_RATE_HZ * TONE_NOTE_MS) / MS_PER_S);
  const attack = Math.round((TONE_RATE_HZ * TONE_ATTACK_MS) / MS_PER_S);
  const release = Math.round((TONE_RATE_HZ * TONE_RELEASE_MS) / MS_PER_S);
  const out = Buffer.alloc(noteSamples * TONE_NOTE_HZ.length * BYTES_PER_SAMPLE);
  const peak = Math.round(Math.min(TONE_PEAK, TONE_PEAK_CAP) * INT16_MAX);
  const decayPerSample = Math.log(TONE_DECAY_RATIO) / noteSamples;
  TONE_NOTE_HZ.forEach((hz, n) => {
    for (let i = 0; i < noteSamples; i++) {
      const rise = i < attack ? Math.sin((Math.PI / 2) * (i / attack)) ** 2 : 1;
      const fall =
        i >= noteSamples - release
          ? Math.sin((Math.PI / 2) * ((noteSamples - i) / release)) ** 2
          : 1;
      const level = rise * fall * Math.exp(decayPerSample * i);
      const v = Math.round(peak * level * Math.sin((2 * Math.PI * hz * i) / TONE_RATE_HZ));
      out.writeInt16LE(v, (n * noteSamples + i) * BYTES_PER_SAMPLE);
    }
  });
  return out;
}

/** The length of rendered tone PCM in milliseconds. */
export function toneDurationMs(pcm: Buffer): number {
  return Math.round((pcm.length / BYTES_PER_SAMPLE / TONE_RATE_HZ) * MS_PER_S);
}
