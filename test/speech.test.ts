import { describe, expect, it } from "vitest";
import {
  FADE_MS,
  MIN_SENTENCE_CHARS,
  SpeechSynth,
  fadeEdges,
  splitSentences,
} from "../src/discord/speech.js";
import type { TtsClient } from "../src/discord/tts.js";
import { pcm24 } from "./helpers/fakeDiscord.js";

const TTS_RATE = 24_000;
const MS_PER_S = 1000;
const FADE_SAMPLES = (TTS_RATE * FADE_MS) / MS_PER_S;
const LOUD = 1000;
const CLIP_BYTES = 40;

function flat(samples: number, value = LOUD): Buffer {
  return pcm24(Array.from({ length: samples }, () => value));
}

function sampleAt(pcm: Buffer, i: number): number {
  return pcm.readInt16LE(i * 2);
}

describe("splitSentences", () => {
  it.each<[string, string, string[]]>([
    ["one sentence", "Hello there.", ["Hello there."]],
    ["empty text", "", []],
    ["blank text", "  \n ", []],
    [
      "two long sentences",
      "This is the first long sentence. And here is the second long one!",
      ["This is the first long sentence.", "And here is the second long one!"],
    ],
    [
      "text with no break",
      "one two three four five six seven eight nine ten eleven",
      ["one two three four five six seven eight nine ten eleven"],
    ],
    [
      "a short opener joined to the next, a short closer to the one before",
      "Hi. I am Betty, the note taker for this meeting. Bye.",
      ["Hi. I am Betty, the note taker for this meeting. Bye."],
    ],
    ["only short pieces", "Hi. Ok.", ["Hi. Ok."]],
    [
      "short pieces carried over more than one stop",
      "Is the build green yet? Yes it is, I checked a minute ago! Good.",
      ["Is the build green yet? Yes it is, I checked a minute ago! Good."],
    ],
    [
      "a closing quote after the stop",
      'She said "we are leaving now." Then the room went quiet again.',
      ['She said "we are leaving now."', "Then the room went quiet again."],
    ],
    [
      "a closing bracket after the stop",
      "See the pull request (number forty two.) It fixes the queue for good.",
      ["See the pull request (number forty two.)", "It fixes the queue for good."],
    ],
    [
      "a colon",
      "Here is what I found so far: the queue is empty right now.",
      ["Here is what I found so far:", "the queue is empty right now."],
    ],
    [
      "an abbreviation, which is a short piece like any other",
      "Dr. Smith will join us later today. He is running late again.",
      ["Dr. Smith will join us later today.", "He is running late again."],
    ],
    [
      "stops with no whitespace after them",
      "It grew 3.5 percent this quarter alone.Nothing follows the stop here.",
      ["It grew 3.5 percent this quarter alone.Nothing follows the stop here."],
    ],
    [
      "newlines and padding",
      "First line is long enough here.\n\n  Second line is long enough too?  ",
      ["First line is long enough here.", "Second line is long enough too?"],
    ],
  ])("%s", (_what, text, want) => {
    expect(splitSentences(text)).toEqual(want);
  });

  it("joins at the documented length", () => {
    const short = "x".repeat(MIN_SENTENCE_CHARS - 2) + ".";
    const exact = "y".repeat(MIN_SENTENCE_CHARS - 1) + ".";
    expect(splitSentences(`${exact} ${exact}`)).toEqual([exact, exact]);
    expect(splitSentences(`${short} ${exact}`)).toEqual([`${short} ${exact}`]);
  });
});

describe("fadeEdges", () => {
  it("fades both ends linearly, in place, and leaves the middle alone", () => {
    const samples = 400;
    const pcm = flat(samples);
    expect(fadeEdges(pcm)).toBe(pcm);
    expect(sampleAt(pcm, 0)).toBe(0);
    expect(sampleAt(pcm, FADE_SAMPLES / 2)).toBe(LOUD / 2);
    expect(sampleAt(pcm, FADE_SAMPLES)).toBe(LOUD);
    expect(sampleAt(pcm, samples / 2)).toBe(LOUD);
    expect(sampleAt(pcm, samples - 1 - FADE_SAMPLES)).toBe(LOUD);
    expect(sampleAt(pcm, samples - 1 - FADE_SAMPLES / 2)).toBe(LOUD / 2);
    expect(sampleAt(pcm, samples - 1)).toBe(0);
  });

  it("shortens the fade for clips under two fades long and tolerates tiny or odd input", () => {
    const four = fadeEdges(flat(4));
    expect([0, 1, 2, 3].map((i) => sampleAt(four, i))).toEqual([0, LOUD / 2, LOUD / 2, 0]);
    expect(sampleAt(fadeEdges(flat(1)), 0)).toBe(LOUD);
    expect(fadeEdges(Buffer.alloc(0))).toHaveLength(0);
    const odd = Buffer.concat([flat(2), Buffer.from([7])]);
    fadeEdges(odd);
    expect([sampleAt(odd, 0), sampleAt(odd, 1), odd[4]]).toEqual([0, 0, 7]);
  });
});

describe("SpeechSynth", () => {
  interface Call {
    text: string;
    voice: string;
  }

  function fakeTts(reply: (call: Call) => Promise<Buffer> | Buffer = () => flat(CLIP_BYTES / 2)) {
    const calls: Call[] = [];
    let running = 0;
    let mostAtOnce = 0;
    const tts = {
      synthesize: async (text: string, voice: string): Promise<Buffer> => {
        calls.push({ text, voice });
        running += 1;
        mostAtOnce = Math.max(mostAtOnce, running);
        try {
          return await reply({ text, voice });
        } finally {
          running -= 1;
        }
      },
    } as unknown as TtsClient;
    return { tts, calls, mostAtOnce: () => mostAtOnce };
  }

  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

  it("synthesizes a sentence once per voice and answers later asks from the cache", async () => {
    const { tts, calls } = fakeTts();
    const synth = new SpeechSynth(tts, 1000);
    expect(synth.has("Hello.", "af_heart")).toBe(false);
    const first = synth.clip("Hello.", "af_heart");
    expect(first.cached).toBe(false);
    const pcm = await first.pcm;
    // Stored faded: the first and last samples are silent.
    expect(sampleAt(pcm, 0)).toBe(0);
    expect(synth.has("Hello.", "af_heart")).toBe(true);
    expect(synth.cachedBytes).toBe(CLIP_BYTES);
    const again = synth.clip("Hello.", "af_heart");
    expect(again.cached).toBe(true);
    expect(await again.pcm).toBe(pcm);
    expect(calls).toHaveLength(1);
    // Another voice is another clip.
    expect(synth.has("Hello.", "bf_emma")).toBe(false);
    expect(synth.clip("Hello.", "bf_emma").cached).toBe(false);
    await settle();
    expect(calls).toEqual([
      { text: "Hello.", voice: "af_heart" },
      { text: "Hello.", voice: "bf_emma" },
    ]);
  });

  it("shares one request between asks made while it is running", async () => {
    let release: (b: Buffer) => void = () => undefined;
    const { tts, calls } = fakeTts(() => new Promise<Buffer>((r) => (release = r)));
    const synth = new SpeechSynth(tts, 1000);
    const a = synth.clip("Same line.", "v");
    const b = synth.clip("Same line.", "v");
    expect([a.cached, b.cached]).toEqual([false, true]);
    expect(synth.has("Same line.", "v")).toBe(false);
    await settle();
    release(flat(CLIP_BYTES / 2));
    expect(await a.pcm).toBe(await b.pcm);
    expect(calls).toHaveLength(1);
  });

  it("does not cache a failure: the next ask tries again", async () => {
    let fail = true;
    const { tts, calls } = fakeTts(() => {
      if (fail) throw new Error("kokoro is down");
      return flat(CLIP_BYTES / 2);
    });
    const synth = new SpeechSynth(tts, 1000);
    await expect(synth.clip("Line.", "v").pcm).rejects.toThrow("kokoro is down");
    expect(synth.has("Line.", "v")).toBe(false);
    fail = false;
    const retry = synth.clip("Line.", "v");
    expect(retry.cached).toBe(false);
    await retry.pcm;
    expect(calls).toHaveLength(2);
    expect(synth.cachedBytes).toBe(CLIP_BYTES);
  });

  it("drops the least recently used clips once the byte limit is passed", async () => {
    const { tts, calls } = fakeTts(({ text }) =>
      flat(text === "huge" ? CLIP_BYTES * 2 : CLIP_BYTES / 2),
    );
    const maxBytes = CLIP_BYTES * 2 + CLIP_BYTES / 2;
    const synth = new SpeechSynth(tts, maxBytes);
    await synth.clip("a", "v").pcm;
    await synth.clip("b", "v").pcm;
    // Using "a" makes "b" the least recent.
    expect(synth.clip("a", "v").cached).toBe(true);
    await synth.clip("c", "v").pcm;
    expect(["a", "b", "c"].map((t) => synth.has(t, "v"))).toEqual([true, false, true]);
    expect(synth.cachedBytes).toBe(CLIP_BYTES * 2);
    // A clip larger than the whole cache is played but never stored.
    expect(await synth.clip("huge", "v").pcm).toHaveLength(CLIP_BYTES * 4);
    expect(synth.has("huge", "v")).toBe(false);
    expect(synth.cachedBytes).toBe(CLIP_BYTES * 2);
    // The evicted clip is synthesized again when asked for.
    expect(synth.clip("b", "v").cached).toBe(false);
    await settle();
    expect(calls.map((c) => c.text)).toEqual(["a", "b", "c", "huge", "b"]);
  });

  it("prewarms each new sentence once, one request at a time, and skips failures", async () => {
    const one = "Line one is long enough to stand.";
    const two = "Second line is also long enough.";
    const three = "And a third sentence comes after it.";
    const bad = "This sentence cannot be synthesized.";
    const { tts, calls, mostAtOnce } = fakeTts(async ({ text }) => {
      await new Promise((r) => setTimeout(r, 5));
      if (text === bad) throw new Error("kokoro is down");
      return flat(CLIP_BYTES / 2);
    });
    const synth = new SpeechSynth(tts, 1000);
    // `one` is named twice and counted once; the second line is two sentences.
    expect(synth.prewarm([one, one, `${two} ${three}`, bad], "v")).toBe(4);
    // Asked again while the first call is still working: nothing new.
    expect(synth.prewarm([one, three], "v")).toBe(0);
    await new Promise((r) => setTimeout(r, 80));
    expect(calls.map((c) => c.text)).toEqual([one, two, three, bad]);
    expect(mostAtOnce()).toBe(1);
    expect([one, two, three, bad].map((t) => synth.has(t, "v"))).toEqual([true, true, true, false]);
    // Only the failed sentence is left to warm.
    expect(synth.prewarm([one, two, three, bad], "v")).toBe(1);
    expect(synth.prewarm([], "v")).toBe(0);
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toHaveLength(5);
  });
});
