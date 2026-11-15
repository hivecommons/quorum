import OpusScript from "opusscript";
import { describe, expect, it } from "vitest";
import { Utterance, encodeWav, toMono16k } from "../src/discord/audio.js";
import { loadDiscordRuntime } from "../src/discord/runtime.js";
import { Transcriber, transcriptionsUrl } from "../src/discord/transcribe.js";
import { pcm48 } from "./helpers/fakeDiscord.js";

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
        fetchImpl: f as unknown as typeof fetch,
      });
    await expect(
      mk(async () => new Response("no", { status: 503 })).transcribe(Buffer.alloc(0)),
    ).rejects.toMatchObject({
      code: "upstream_error",
      message: expect.stringContaining("503"),
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
    const client = rt.createClient();
    await client.destroy();
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
