import OpusScript from "opusscript";
import { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  OPUS_FRAME_BYTES,
  OPUS_FRAME_SAMPLES,
  Utterance,
  concatSamples,
  encodeWav,
  samplesMs,
  TRIM_PAD_MS,
  trimSilence,
  pcmFrames,
  toMono16k,
  upsampleToStereo48k,
} from "../src/audio.js";
import { isDisallowedIntents } from "../src/discord/adapter.js";
import { loadDiscordRuntime } from "../src/discord/runtime.js";
import {
  buildHotwords,
  buildPrompt,
  isRetryableStatus,
  nameHints,
  PROMPT_MAX_CHARS,
  Transcriber,
  transcriptionsUrl,
} from "../src/transcribe.js";
import { TtsClient, speechUrl } from "../src/discord/tts.js";
import { FakeTts, pcm24, pcm48 } from "./helpers/fakeDiscord.js";

function stereo(buf: Buffer): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i + 4 <= buf.length; i += 4)
    out.push([buf.readInt16LE(i), buf.readInt16LE(i + 2)]);
  return out;
}

describe("audio", () => {
  it("downmixes 48 kHz stereo to 16 kHz mono by averaging", () => {
    const b = Buffer.alloc(3 * 4 * 2 + 2);
    const values = [
      [100, 200],
      [300, 400],
      [500, 600],
      [-30, -30],
      [-60, -60],
      [-90, -90],
    ];
    values.forEach(([l, r], i) => {
      b.writeInt16LE(l ?? 0, i * 4);
      b.writeInt16LE(r ?? 0, i * 4 + 2);
    });
    expect([...toMono16k(b)]).toEqual([350, -60]);
    expect(toMono16k(pcm48(20)).length).toBe(320);
  });

  it("writes a 16-bit mono WAV header", () => {
    const wav = encodeWav(Int16Array.from([1, -1, 32767]));
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.readUInt32LE(24)).toBe(16000);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(40)).toBe(6);
    expect(wav.readInt16LE(48)).toBe(32767);
    expect(wav.length).toBe(50);
  });

  it("accumulates and hands over utterances back to back", () => {
    const u = new Utterance(1000);
    u.push(new Int16Array(8000));
    u.push(new Int16Array(8000));
    expect(u.durationMs).toBe(1000);
    const a = u.take();
    expect([a.samples.length, a.startMs, a.endMs]).toEqual([16000, 1000, 2000]);
    expect(u.durationMs).toBe(0);
    u.push(new Int16Array(1600));
    expect(u.take()).toMatchObject({ startMs: 2000, endMs: 2100 });
  });
});

describe("upsampleToStereo48k", () => {
  it("doubles the rate by linear interpolation and duplicates each sample to both channels", () => {
    const out = upsampleToStereo48k(pcm24([0, 100, -100, 32767]));
    expect(out.length).toBe(4 * 2 * 4);
    expect(stereo(out)).toEqual([
      [0, 0],
      [50, 50],
      [100, 100],
      [0, 0],
      [-100, -100],
      [16334, 16334],
      [32767, 32767],
      [32767, 32767],
    ]);
  });

  it("handles empty input, a trailing odd byte and full-scale values", () => {
    expect(upsampleToStereo48k(Buffer.alloc(0)).length).toBe(0);
    const odd = Buffer.concat([pcm24([-32768]), Buffer.from([7])]);
    expect(stereo(upsampleToStereo48k(odd))).toEqual([
      [-32768, -32768],
      [-32768, -32768],
    ]);
    // One second at 24 kHz becomes one second at 48 kHz stereo.
    expect(upsampleToStereo48k(Buffer.alloc(24_000 * 2)).length).toBe(48_000 * 4);
  });
});

describe("pcmFrames", () => {
  it("cuts 20 ms frames and pads the last with silence", () => {
    expect(OPUS_FRAME_SAMPLES).toBe(960);
    expect(OPUS_FRAME_BYTES).toBe(3840);
    const pcm = Buffer.alloc(OPUS_FRAME_BYTES * 2 + 10, 1);
    const frames = pcmFrames(pcm);
    expect(frames.map((f) => f.length)).toEqual([3840, 3840, 3840]);
    expect(frames[2]?.subarray(0, 10).every((b) => b === 1)).toBe(true);
    expect(frames[2]?.subarray(10).every((b) => b === 0)).toBe(true);
    expect(pcmFrames(Buffer.alloc(0))).toEqual([]);
  });
});

describe("TtsClient", () => {
  const tts = new FakeTts();
  beforeAll(() => tts.start());
  afterAll(() => tts.stop());
  beforeEach(() => {
    tts.requests = [];
    tts.replies = [];
  });

  it("builds the endpoint URL", () => {
    expect(speechUrl("http://tts:8880/")).toBe("http://tts:8880/v1/audio/speech");
    expect(speechUrl("http://tts/v1/audio/speech")).toBe("http://tts/v1/audio/speech");
  });

  it("asks for pcm with the voice and sends X-API-Key", async () => {
    const pcm = pcm24([1, 2, 3]);
    tts.replies.push({ status: 200, body: pcm });
    const c = new TtsClient({ url: tts.url, token: () => "kokoro-key", timeoutMs: 1000 });
    expect((await c.synthesize("hello", "af_heart")).equals(pcm)).toBe(true);
    expect(tts.requests[0]).toMatchObject({
      url: "/v1/audio/speech",
      headers: { "x-api-key": "kokoro-key", "content-type": "application/json" },
      body: { model: "tts-1", input: "hello", voice: "af_heart", response_format: "pcm" },
    });
    await new TtsClient({ url: tts.url, token: () => undefined, timeoutMs: 1000 }).synthesize(
      "x",
      "bf_emma",
    );
    expect(tts.requests[1]?.headers["x-api-key"]).toBeUndefined();
  });

  it("maps errors, empty audio, timeouts and unreachable services to upstream_error", async () => {
    const c = new TtsClient({ url: tts.url, token: () => "k", timeoutMs: 200 });
    tts.replies.push({ status: 401, body: '{"detail":"bad key"}' });
    await expect(c.synthesize("x", "v")).rejects.toMatchObject({
      code: "upstream_error",
      message: expect.stringMatching(/401: .*bad key/),
    });
    tts.replies.push({ status: 500, body: "" });
    await expect(c.synthesize("x", "v")).rejects.toMatchObject({
      message: "TTS service answered 500",
    });
    tts.replies.push({ status: 200, body: Buffer.alloc(0) });
    await expect(c.synthesize("x", "v")).rejects.toMatchObject({
      code: "upstream_error",
      message: expect.stringContaining("no audio"),
    });
    tts.replies.push({ status: 200, body: pcm24([1]), delayMs: 1000 });
    await expect(c.synthesize("x", "v")).rejects.toMatchObject({
      code: "upstream_error",
      message: expect.stringContaining("unreachable or timed out"),
    });
    const down = new TtsClient({
      url: "http://tts",
      token: () => undefined,
      timeoutMs: 100,
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    await expect(down.synthesize("x", "v")).rejects.toMatchObject({ code: "upstream_error" });
  });
});

describe("isDisallowedIntents", () => {
  it("recognises Discord refusing a privileged intent", () => {
    expect(isDisallowedIntents(new Error("Used disallowed intents"))).toBe(true);
    expect(
      isDisallowedIntents(new Error("Privileged intent provided is not enabled or whitelisted.")),
    ).toBe(true);
    expect(isDisallowedIntents({ code: 4014 })).toBe(true);
    expect(isDisallowedIntents({ code: "DisallowedIntents" })).toBe(true);
    expect(isDisallowedIntents(new Error("TOKEN_INVALID"))).toBe(false);
    expect(isDisallowedIntents(null)).toBe(false);
  });
});

describe("trimSilence", () => {
  const SR = 16_000;
  const run = (ms: number, value: number) => new Int16Array((SR * ms) / 1000).fill(value);

  it("cuts leading and trailing silence, keeping a pad each side", () => {
    const audio = concatSamples([run(1000, 0), run(500, 2000), run(800, 3)]);
    const { samples, leadMs } = trimSilence(audio, 500);
    expect(leadMs).toBe(1000 - TRIM_PAD_MS);
    expect(samplesMs(samples)).toBe(500 + 2 * TRIM_PAD_MS);
    expect(samples[0]).toBe(0);
    expect(samples[(SR * TRIM_PAD_MS) / 1000]).toBe(2000);
  });

  it("keeps audio that is loud to its edges, and returns nothing for all-quiet audio", () => {
    expect(samplesMs(trimSilence(run(300, -1500), 500).samples)).toBe(300);
    expect(trimSilence(run(2000, 100), 500)).toEqual({ samples: new Int16Array(0), leadMs: 0 });
    expect(trimSilence(new Int16Array(0), 500).samples.length).toBe(0);
  });
});

describe("Transcriber prompt and retries", () => {
  type Call = { form: FormData };
  function scripted(replies: Array<Response | Error>) {
    const calls: Call[] = [];
    const sleeps: number[] = [];
    const t = (maxAttempts = 4) =>
      new Transcriber({
        url: "http://stt",
        token: () => undefined,
        timeoutMs: 1000,
        hotwords: ["Hive", "betty"],
        retry: { maxAttempts, backoffBaseMs: 100, backoffMaxMs: 1000 },
        random: () => 0.5,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        fetchImpl: (async (_u: string, i: RequestInit) => {
          calls.push({ form: i.body as FormData });
          const next = replies.shift() ?? new Response(JSON.stringify({ text: "ok" }));
          if (next instanceof Error) throw next;
          return next;
        }) as unknown as typeof fetch,
      });
    return { t, calls, sleeps };
  }

  it("names the bot first, then its full name, then the configured hotwords", () => {
    expect(nameHints("Betty Bee from the hive")).toEqual(["Betty", "Betty Bee from the hive"]);
    expect(nameHints("Betty")).toEqual(["Betty"]);
    expect(nameHints("  ")).toEqual([]);
    expect(nameHints(undefined)).toEqual([]);
    expect(buildPrompt([])).toBeUndefined();
    expect(buildPrompt(["Betty", "betty", " Hive "])).toBe("Betty, Hive.");
    const long = buildPrompt(Array.from({ length: 200 }, (_, i) => `Name${i}`)) ?? "";
    expect(long.length).toBeLessThanOrEqual(PROMPT_MAX_CHARS);
    expect(long.endsWith(".")).toBe(true);
  });

  it("sends the hints as the Whisper prompt on every request", async () => {
    const { t, calls } = scripted([]);
    expect(
      await t().transcribe(Buffer.alloc(0), { hints: nameHints("Betty Bee from the hive") }),
    ).toBe("ok");
    expect(calls[0]?.form.get("prompt")).toBe("Betty, Betty Bee from the hive, Hive.");
    expect(calls[0]?.form.get("hotwords")).toBe("Betty, Hive");
    const bare = scripted([]);
    await new Transcriber({
      url: "http://stt",
      token: () => undefined,
      timeoutMs: 1000,
      fetchImpl: (async (_u: string, i: RequestInit) => {
        bare.calls.push({ form: i.body as FormData });
        return new Response(JSON.stringify({ text: "x" }));
      }) as unknown as typeof fetch,
    }).transcribe(Buffer.alloc(0));
    expect(bare.calls[0]?.form.get("prompt")).toBeNull();
    expect(bare.calls[0]?.form.get("hotwords")).toBeNull();
    expect(buildHotwords(["Betty Bee from the hive", "betty"], ["pull request", "Hive"])).toBe(
      "Betty, pull request, Hive",
    );
    expect(buildHotwords([" "])).toBeUndefined();
    const many =
      buildHotwords(
        [],
        Array.from({ length: 200 }, (_, i) => `word${i}`),
      ) ?? "";
    expect(many.length).toBeLessThanOrEqual(PROMPT_MAX_CHARS);
    expect(many.endsWith(",")).toBe(false);
  });

  it("retries 503, 429, 5xx and network errors with growing jittered backoff, then succeeds", async () => {
    const { t, calls, sleeps } = scripted([
      new Response("busy", { status: 503 }),
      new TypeError("fetch failed"),
      new Response("slow down", { status: 429 }),
    ]);
    expect(await t().transcribe(Buffer.alloc(0), { hints: ["Betty"] })).toBe("ok");
    expect(calls).toHaveLength(4);
    expect(calls.every((c) => c.form.get("prompt") === "Betty, Hive.")).toBe(true);
    // base 100: attempt n waits half its window plus jitter (random 0.5): 75, 150, 300.
    expect(sleeps).toEqual([75, 150, 300]);
  });

  it("honours Retry-After up to the backoff ceiling", async () => {
    const { t, sleeps } = scripted([
      new Response("busy", { status: 503, headers: { "Retry-After": "0.5" } }),
      new Response("busy", { status: 503, headers: { "Retry-After": "30" } }),
    ]);
    expect(await t().transcribe(Buffer.alloc(0))).toBe("ok");
    expect(sleeps).toEqual([500, 1000]);
  });

  it("drops only after the bounded attempts, naming how many it made", async () => {
    const { t, calls, sleeps } = scripted([
      new Response("busy", { status: 503 }),
      new Response("busy", { status: 503 }),
      new Response("busy", { status: 503 }),
    ]);
    await expect(t(3).transcribe(Buffer.alloc(0))).rejects.toMatchObject({
      code: "upstream_error",
      message: "transcription service answered 503 (gave up after 3 attempts)",
    });
    expect(calls).toHaveLength(3);
    expect(sleeps).toHaveLength(2);
  });

  it("lets one call set its own attempt budget", async () => {
    const busy = (): Response => new Response("busy", { status: 503 });
    const once = scripted([busy()]);
    await expect(once.t().transcribe(Buffer.alloc(0), { maxAttempts: 1 })).rejects.toMatchObject({
      code: "upstream_error",
    });
    expect(once.calls).toHaveLength(1);
    expect(once.sleeps).toEqual([]);
    // A budget below one is one try; a fractional one is rounded down.
    const zero = scripted([busy()]);
    await expect(zero.t().transcribe(Buffer.alloc(0), { maxAttempts: 0 })).rejects.toBeDefined();
    expect(zero.calls).toHaveLength(1);
    const twoAndABit = scripted([busy(), busy(), busy()]);
    await expect(
      twoAndABit.t().transcribe(Buffer.alloc(0), { maxAttempts: 2.9 }),
    ).rejects.toMatchObject({ message: expect.stringContaining("2 attempts") });
    expect(twoAndABit.calls).toHaveLength(2);
    // Without it the client's policy stands.
    const policy = scripted([busy(), busy()]);
    expect(await policy.t().transcribe(Buffer.alloc(0), { hints: ["Betty"] })).toBe("ok");
    expect(policy.calls).toHaveLength(3);
  });

  it("does not retry a request the service refused", async () => {
    const { t, calls } = scripted([new Response("bad", { status: 400 })]);
    await expect(t().transcribe(Buffer.alloc(0))).rejects.toMatchObject({
      code: "upstream_error",
      message: "transcription service answered 400",
    });
    expect(calls).toHaveLength(1);
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(599)).toBe(true);
    expect(isRetryableStatus(404)).toBe(false);
    expect(isRetryableStatus(600)).toBe(false);
  });

  it("caps each backoff and treats a zero attempt budget as one try", () => {
    const capped = new Transcriber({
      url: "http://stt",
      token: () => undefined,
      timeoutMs: 1,
      retry: { maxAttempts: 0, backoffBaseMs: 100, backoffMaxMs: 250 },
      random: () => 0.999,
    });
    expect(capped.backoffMs(10)).toBeLessThanOrEqual(250);
    expect(capped.backoffMs(1)).toBeGreaterThanOrEqual(50);
  });
});

describe("Transcriber", () => {
  it("builds the endpoint URL", () => {
    expect(transcriptionsUrl("http://stt:8000/")).toBe("http://stt:8000/v1/audio/transcriptions");
    expect(transcriptionsUrl("http://stt/v1/audio/transcriptions")).toBe(
      "http://stt/v1/audio/transcriptions",
    );
  });

  it("posts multipart audio and reads the text", async () => {
    let init: RequestInit | undefined;
    const t = new Transcriber({
      url: "http://stt",
      token: () => undefined,
      timeoutMs: 1000,
      fetchImpl: (async (_u: string, i: RequestInit) => {
        init = i;
        return new Response(JSON.stringify({ text: " hi there " }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(await t.transcribe(encodeWav(new Int16Array(10)))).toBe("hi there");
    expect(init?.headers).toEqual({});
    const form = init?.body as FormData;
    expect(form.get("model")).toBe("whisper-1");
    expect(form.get("language")).toBeNull();
  });

  it("maps failures to upstream_error and tolerates odd bodies", async () => {
    const mk = (f: () => Promise<Response>) =>
      new Transcriber({
        url: "http://stt",
        token: () => "k",
        timeoutMs: 1000,
        retry: { maxAttempts: 1 },
        fetchImpl: f as unknown as typeof fetch,
      });
    await expect(
      mk(async () => new Response("no", { status: 503 })).transcribe(Buffer.alloc(0)),
    ).rejects.toMatchObject({
      code: "upstream_error",
      message: expect.stringContaining("503 (gave up after 1 attempt)"),
    });
    await expect(
      mk(async () => {
        throw new TypeError("fetch failed");
      }).transcribe(Buffer.alloc(0)),
    ).rejects.toMatchObject({ code: "upstream_error" });
    expect(
      await mk(async () => new Response("not json", { status: 200 })).transcribe(Buffer.alloc(0)),
    ).toBe("");
    expect(
      await mk(async () => new Response(JSON.stringify({ text: 5 }), { status: 200 })).transcribe(
        Buffer.alloc(0),
      ),
    ).toBe("");
  });
});

describe("loadDiscordRuntime", () => {
  it("loads discord.js, @discordjs/voice and a pure-JS Opus decoder", async () => {
    const rt = await loadDiscordRuntime();
    expect(rt.voice.Status.Ready).toBe("ready");
    expect(rt.voice.AfterSilence).toBe(1);
    expect(typeof rt.voice.joinVoiceChannel).toBe("function");
    await expect(
      rt.voice.entersState({ on() {}, once() {} } as never, "ready", 1),
    ).rejects.toBeDefined();
    const enc = new OpusScript(48000, 2, OpusScript.Application.VOIP, { wasm: false });
    const packet = enc.encode(pcm48(20, 2000), 960);
    enc.delete();
    const dec = rt.createDecoder();
    const out = dec.decode(packet);
    expect(out.length).toBe(960 * 4);
    dec.delete?.();
    const client = rt.createClient({ messageContent: true });
    await client.destroy();
    await rt.createClient({ messageContent: false }).destroy();
  });

  it("encodes speech with the pure-JS Opus encoder and plays it as an Opus resource", async () => {
    const rt = await loadDiscordRuntime();
    expect(rt.voice.PlayerIdle).toBe("idle");
    const enc = rt.createEncoder();
    const packet = enc.encode(pcm48(20, 3000), OPUS_FRAME_SAMPLES);
    enc.delete?.();
    expect(packet.length).toBeGreaterThan(0);
    const dec = rt.createDecoder();
    expect(dec.decode(packet).length).toBe(OPUS_FRAME_BYTES);
    dec.delete?.();
    const player = rt.voice.createAudioPlayer();
    const resource = rt.voice.createOpusResource(Readable.from([packet], { objectMode: true }));
    expect(resource).toBeDefined();
    player.stop(true);
  });

  it("joinVoiceChannel goes through @discordjs/voice", async () => {
    const rt = await loadDiscordRuntime();
    const conn = rt.voice.joinVoiceChannel({
      guildId: "111111",
      channelId: "222222",
      adapterCreator: () => ({ sendPayload: () => true, destroy: () => undefined }),
      selfDeaf: false,
      selfMute: true,
    });
    conn.destroy();
  });
});
