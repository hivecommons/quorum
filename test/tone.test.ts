import { describe, expect, it } from "vitest";
import {
  renderListeningTone,
  toneDurationMs,
  TONE_ATTACK_MS,
  TONE_NOTE_HZ,
  TONE_NOTE_MS,
  TONE_PEAK_CAP,
  TONE_RATE_HZ,
} from "../src/tone.js";

const INT16_MAX = 32767;
const MS_PER_S = 1000;

function samples(pcm: Buffer): number[] {
  return Array.from({ length: pcm.length / 2 }, (_, i) => pcm.readInt16LE(i * 2));
}

describe("listening tone", () => {
  const pcm = renderListeningTone();
  const s = samples(pcm);
  const note = (TONE_RATE_HZ * TONE_NOTE_MS) / MS_PER_S;

  it("is short: two notes, a fifth of a second, 24 kHz mono s16le", () => {
    expect(s.length).toBe(note * TONE_NOTE_HZ.length);
    expect(toneDurationMs(pcm)).toBe(TONE_NOTE_MS * TONE_NOTE_HZ.length);
  });

  it("is soft: never louder than the peak cap", () => {
    const peak = Math.max(...s.map(Math.abs));
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(Math.round(TONE_PEAK_CAP * INT16_MAX));
  });

  it("starts and ends at silence, and each note fades to zero, so it cannot click", () => {
    expect(s[0]).toBe(0);
    expect(s[note]).toBe(0);
    expect(s[s.length - 1]).toBe(0);
    const attack = (TONE_RATE_HZ * TONE_ATTACK_MS) / MS_PER_S;
    const early = Math.max(...s.slice(0, attack / 4).map(Math.abs));
    const later = Math.max(...s.slice(attack * 2, attack * 3).map(Math.abs));
    expect(early).toBeLessThan(later);
  });

  it("is the same bytes every time", () => {
    expect(renderListeningTone().equals(pcm)).toBe(true);
  });

  it("plays two notes: the second half is a higher pitch than the first", () => {
    const crossings = (part: number[]): number =>
      part.slice(1).filter((v, i) => (part[i] ?? 0) < 0 !== v < 0).length;
    expect(crossings(s.slice(note, note * 2))).toBeGreaterThan(crossings(s.slice(0, note)));
  });
});
