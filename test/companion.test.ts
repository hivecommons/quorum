import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  CALL_SPEAKER,
  CompanionAdapter,
  DEFAULT_HOST_NAME,
  isCompanionChannel,
} from "../src/companion/adapter.js";
import { FRAME_SAMPLES, rms, Segmenter } from "../src/companion/segmenter.js";
import { loadConfig } from "../src/config.js";
import type { Transcriber, TranscribeOptions } from "../src/transcribe.js";
import { silentLogger, type Logger } from "../src/log.js";
import { Meeting, type QuorumEvent } from "../src/meeting.js";
import { FakeStt } from "./helpers/fakeDiscord.js";
import {
  openSse,
  startHarness,
  tempDir,
  TOKEN,
  writeSecret,
  type Harness,
} from "./helpers/harness.js";

const LOUD = 3000;
const SAMPLE_RATE = 16_000;
const MS_PER_S = 1000;

function samplesFor(ms: number): number {
  return (SAMPLE_RATE * ms) / MS_PER_S;
}

/** A square wave loud enough to count as speech. */
function tone(ms: number): Int16Array {
  const out = new Int16Array(samplesFor(ms));
  for (let i = 0; i < out.length; i++) out[i] = i % 2 === 0 ? LOUD : -LOUD;
  return out;
}

function silence(ms: number): Int16Array {
  return new Int16Array(samplesFor(ms));
}

function concat(...parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function bytes(pcm: Int16Array): Buffer {
  const buf = Buffer.alloc(pcm.length * 2);
  pcm.forEach((s, i) => buf.writeInt16LE(s, i * 2));
  return buf;
}

describe("Segmenter", () => {
  const opts = { silenceMs: 100, minSpeechMs: 60, maxSegmentMs: 1000, threshold: 500 };

  it("ignores silence and cuts an utterance at the following silence", () => {
    const seg = new Segmenter(opts);
    expect(seg.push(silence(200))).toEqual([]);
    const done = seg.push(concat(tone(300), silence(120)));
    expect(done).toHaveLength(1);
    expect(done[0]?.startMs).toBe(200);
    expect(done[0]?.endMs).toBe(200 + 300 + 100);
    expect(seg.flush()).toBeUndefined();
  });

  it("keeps partial frames across pushes", () => {
    const seg = new Segmenter(opts);
    const pcm = concat(tone(300), silence(120));
    const half = Math.floor(FRAME_SAMPLES / 2);
    const done = [...seg.push(pcm.slice(0, half)), ...seg.push(pcm.slice(half))];
    expect(done).toHaveLength(1);
    expect(done[0]?.startMs).toBe(0);
  });

  it("cuts a long utterance at maxSegmentMs and drops noise bursts", () => {
    const seg = new Segmenter(opts);
    const long = seg.push(tone(2100));
    expect(long).toHaveLength(2);
    expect(long[1]?.startMs).toBe(1000);
    expect(seg.flush()?.startMs).toBe(2000);
    expect(seg.push(concat(tone(40), silence(120)))).toEqual([]);
  });

  it("shows the open utterance without closing it, and where its speech ended", () => {
    const seg = new Segmenter(opts);
    expect(seg.peek()).toBeUndefined();
    expect(seg.receivedMs).toBe(0);
    seg.push(silence(200));
    expect(seg.peek()).toBeUndefined();
    expect(seg.push(concat(tone(300), silence(40)))).toEqual([]);
    const open = seg.peek();
    expect(open).toMatchObject({
      startMs: 200,
      endMs: 540,
      speechEndMs: 500,
      speechMs: 300,
      trailingSilenceMs: 40,
    });
    expect(open?.samples).toHaveLength(samplesFor(340));
    expect(seg.receivedMs).toBe(540);
    // Peeking closed nothing: the same utterance is still open and ends as usual.
    expect(seg.peek()?.startMs).toBe(200);
    const done = seg.push(silence(60));
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ startMs: 200, endMs: 600, speechEndMs: 500 });
    expect(seg.peek()).toBeUndefined();
    // More speech moves the speech end; a flush reports it too.
    seg.push(concat(tone(100), silence(40), tone(100)));
    expect(seg.peek()).toMatchObject({ startMs: 600, speechEndMs: 840, trailingSilenceMs: 0 });
    expect(seg.flush()).toMatchObject({ startMs: 600, endMs: 840, speechEndMs: 840 });
  });

  it("measures rms", () => {
    expect(rms(new Int16Array(0))).toBe(0);
    expect(rms(tone(20))).toBe(LOUD);
  });
});

describe("companion adapter without the platform plumbing", () => {
  it("knows its channels and refuses to start without a transcriber", async () => {
    expect(isCompanionChannel("call")).toBe(true);
    expect(isCompanionChannel("mic")).toBe(true);
    expect(isCompanionChannel("video")).toBe(false);
    expect(isCompanionChannel(null)).toBe(false);
    const a = new CompanionAdapter({
      config: loadConfig({}),
      log: silentLogger,
      transcriber: undefined,
    });
    const m = new Meeting({ platform: "companion", bufferSize: 10 });
    await expect(a.join(m, { displayName: "Betty", voice: false })).rejects.toMatchObject({
      code: "platform_unavailable",
    });
    await expect(a.refresh()).resolves.toBeUndefined();
    await a.close();
  });
});

describe("companion listening tone", () => {
  const CONNECTED_MS = 5000;
  const TTL_MS = 4000;
  const T0 = 50_000;

  async function rig() {
    const clock = { ms: T0 };
    const adapter = new CompanionAdapter({
      config: loadConfig({
        QUORUM_COMPANION_CONNECTED_MS: String(CONNECTED_MS),
        QUORUM_COMPANION_TONE_TTL_MS: String(TTL_MS),
      }),
      log: silentLogger,
      transcriber: { transcribe: () => Promise.resolve("") } as unknown as Transcriber,
      now: () => clock.ms,
    });
    const meeting = new Meeting({ platform: "companion", bufferSize: 10 });
    await adapter.join(meeting, { displayName: "Betty", voice: false });
    return { adapter, meeting, clock };
  }

  it("is dropped until the companion is fetching its outbox, then delivered once", async () => {
    const r = await rig();
    // No fetch yet: nobody would hear it.
    expect(await r.adapter.tone(r.meeting)).toBe(false);
    expect(r.adapter.outbox(r.meeting, 0)).toEqual({ lines: [], next_seq: 0, tone: false });
    r.clock.ms += 1000;
    expect(await r.adapter.tone(r.meeting)).toBe(true);
    // A second tone while the first waits to be fetched is dropped: one chime.
    expect(await r.adapter.tone(r.meeting)).toBe(false);
    r.clock.ms += 1000;
    expect(r.adapter.outbox(r.meeting, 0).tone).toBe(true);
    expect(r.adapter.outbox(r.meeting, 0).tone).toBe(false);
    // Fetched, so the next one plays again.
    expect(await r.adapter.tone(r.meeting)).toBe(true);
    expect(r.adapter.outbox(r.meeting, 0).tone).toBe(true);
  });

  it("is dropped once the companion stopped fetching, and expires when nobody fetches it", async () => {
    const r = await rig();
    r.adapter.outbox(r.meeting, 0);
    r.clock.ms += CONNECTED_MS + 1;
    expect(await r.adapter.tone(r.meeting)).toBe(false);
    r.adapter.outbox(r.meeting, 0);
    expect(await r.adapter.tone(r.meeting)).toBe(true);
    // Still connected, and the unfetched tone expired: it does not block the next one.
    r.clock.ms += TTL_MS + 1;
    expect(await r.adapter.tone(r.meeting)).toBe(true);
    // Fetched too late: a stale chime never plays.
    r.clock.ms += TTL_MS + 1;
    expect(r.adapter.outbox(r.meeting, 0).tone).toBe(false);
  });

  it("never plays for a meeting that left and never throws", async () => {
    const r = await rig();
    r.adapter.outbox(r.meeting, 0);
    await r.adapter.leave(r.meeting);
    expect(await r.adapter.tone(r.meeting)).toBe(false);
    const other = new Meeting({ platform: "companion", bufferSize: 10 });
    expect(await r.adapter.tone(other)).toBe(false);
  });
});

describe("companion early transcription", () => {
  const SILENCE_MS = 500;
  const EARLY_MS = 150;
  const WAV_HEADER_BYTES = 44;
  const T0 = 10_000;

  interface SttCall {
    wav: Buffer;
    opts: TranscribeOptions | undefined;
    resolve(text: string): void;
    reject(err: Error): void;
  }

  function rig(env: Record<string, string> = {}) {
    const calls: SttCall[] = [];
    const transcriber = {
      transcribe: (wav: Buffer, opts?: TranscribeOptions) =>
        new Promise<string>((resolve, reject) => {
          calls.push({ wav, opts, resolve, reject });
        }),
    } as unknown as Transcriber;
    const timings: Record<string, unknown>[] = [];
    const warnings: string[] = [];
    const log: Logger = {
      ...silentLogger,
      info: (msg, fields) => {
        if (msg === "companion: segment timing") timings.push(fields ?? {});
      },
      warn: (msg) => {
        warnings.push(msg);
      },
    };
    const clock = { ms: T0 };
    const adapter = new CompanionAdapter({
      config: loadConfig({
        QUORUM_COMPANION_SILENCE_MS: String(SILENCE_MS),
        QUORUM_COMPANION_EARLY_MS: String(EARLY_MS),
        ...env,
      }),
      log,
      transcriber,
      now: () => clock.ms,
    });
    const meeting = new Meeting({
      platform: "companion",
      bufferSize: 10,
      displayName: "Betty Bee",
    });
    const segments: Extract<QuorumEvent, { type: "segment" }>[] = [];
    meeting.onEvent((e) => {
      if (e.type === "segment") segments.push(e);
    });
    let seq = 0;
    const send = (pcm: Int16Array): void => {
      adapter.audio(meeting, "call", seq++, bytes(pcm));
    };
    return { adapter, meeting, calls, timings, warnings, clock, segments, send };
  }

  /** Lets settled promises run their reactions. */
  const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

  function call(calls: SttCall[], i: number): SttCall {
    const c = calls[i];
    if (!c) throw new Error(`no transcription request ${i}`);
    return c;
  }

  function wavMs(wav: Buffer): number {
    return ((wav.length - WAV_HEADER_BYTES) / 2 / SAMPLE_RATE) * MS_PER_S;
  }

  it("asks once, publishes a draft, and reuses the answer as the final when the silence completes", async () => {
    const r = rig();
    await r.adapter.join(r.meeting, { displayName: "Betty Bee", voice: false });
    r.send(concat(tone(400), silence(200)));
    expect(r.calls).toHaveLength(1);
    // One try, and the clip is padded with silence to the length the ended utterance will have.
    expect(call(r.calls, 0).opts).toEqual({ hints: ["Betty", "Betty Bee"], maxAttempts: 1 });
    expect(wavMs(call(r.calls, 0).wav)).toBe(400 + SILENCE_MS);
    // More silence short of the end asks nothing new.
    r.clock.ms = T0 + 120;
    call(r.calls, 0).resolve("hello there");
    await tick();
    expect(r.segments).toMatchObject([{ text: "hello there", final: false, start: 0 }]);
    expect(r.timings).toEqual([]);

    r.clock.ms = T0 + 500;
    r.send(silence(400));
    await tick();
    expect(r.calls).toHaveLength(1);
    expect(r.segments).toMatchObject([
      { text: "hello there", final: false, start: 0, speaker: CALL_SPEAKER },
      { text: "hello there", final: true, start: 0, end: 0.9, speaker: CALL_SPEAKER },
    ]);
    // Audio time zero is T0 - 600 ms; the last speech sample is at 400 ms, so it was spoken at
    // T0 - 200, arrived at T0, the end was known at T0 + 500 and the answer took 120 ms.
    expect(r.timings).toEqual([
      {
        seq: 2,
        channel: "call",
        clip_ms: 900,
        capture_ms: 200,
        endpoint_ms: 500,
        stt_ms: 120,
        total_ms: 700,
        early: true,
      },
    ]);
    expect(r.meeting.readSegments().segments.map((s) => s.text)).toEqual(["hello there"]);
  });

  it("drops the early answer when the speaker carries on and transcribes the whole utterance", async () => {
    const r = rig();
    await r.adapter.join(r.meeting, { displayName: "Betty Bee", voice: false });
    r.send(concat(tone(400), silence(200)));
    call(r.calls, 0).resolve("hello");
    await tick();
    expect(r.segments).toMatchObject([{ text: "hello", final: false }]);
    r.clock.ms = T0 + 1000;
    r.send(concat(tone(400), silence(600)));
    await tick();
    expect(r.calls).toHaveLength(2);
    // The whole utterance, with the service's usual retries.
    expect(call(r.calls, 1).opts).toEqual({ hints: ["Betty", "Betty Bee"] });
    expect(wavMs(call(r.calls, 1).wav)).toBe(1000 + SILENCE_MS);
    r.clock.ms = T0 + 1300;
    call(r.calls, 1).resolve("hello again friend");
    await tick();
    expect(r.segments).toMatchObject([
      { text: "hello", final: false, start: 0 },
      { text: "hello again friend", final: true, start: 0, end: 1.5 },
    ]);
    expect(r.timings).toMatchObject([{ clip_ms: 1500, stt_ms: 300, early: false }]);
  });

  it("publishes no draft for an early answer that arrives after more speech", async () => {
    const r = rig();
    await r.adapter.join(r.meeting, { displayName: "Betty Bee", voice: false });
    r.send(concat(tone(400), silence(200)));
    r.send(concat(tone(200), silence(100)));
    // The pause after the new speech is still short of QUORUM_COMPANION_EARLY_MS.
    expect(r.calls).toHaveLength(1);
    call(r.calls, 0).resolve("stale words");
    await tick();
    expect(r.segments).toEqual([]);
    r.send(silence(100));
    expect(r.calls).toHaveLength(2);
    r.send(silence(100));
    // Still the same speech end: not asked a third time.
    expect(r.calls).toHaveLength(2);
    call(r.calls, 1).resolve("the whole thought");
    await tick();
    r.send(silence(200));
    await tick();
    expect(r.calls).toHaveLength(2);
    expect(r.segments.map((s) => [s.text, s.final])).toEqual([
      ["the whole thought", false],
      ["the whole thought", true],
    ]);
  });

  it("never publishes a draft after its final: an answer that arrives once the utterance ended is the final only", async () => {
    const r = rig();
    await r.adapter.join(r.meeting, { displayName: "Betty Bee", voice: false });
    r.send(concat(tone(400), silence(200)));
    r.clock.ms = T0 + 500;
    r.send(silence(400));
    await tick();
    expect(r.segments).toEqual([]);
    r.clock.ms = T0 + 650;
    call(r.calls, 0).resolve("late but whole");
    await tick();
    expect(r.calls).toHaveLength(1);
    expect(r.segments.map((s) => [s.text, s.final])).toEqual([["late but whole", true]]);
    expect(r.timings).toMatchObject([{ stt_ms: 650, total_ms: 850, early: true }]);
  });

  it("falls back to the normal request when the early one fails", async () => {
    const r = rig();
    await r.adapter.join(r.meeting, { displayName: "Betty Bee", voice: false });
    r.send(concat(tone(400), silence(200)));
    call(r.calls, 0).reject(new Error("busy"));
    await tick();
    expect(r.segments).toEqual([]);
    r.clock.ms = T0 + 500;
    r.send(silence(400));
    await tick();
    expect(r.calls).toHaveLength(2);
    expect(call(r.calls, 1).opts).toEqual({ hints: ["Betty", "Betty Bee"] });
    r.clock.ms = T0 + 900;
    call(r.calls, 1).resolve("second ask");
    await tick();
    expect(r.segments.map((s) => [s.text, s.final])).toEqual([["second ask", true]]);
    expect(r.timings).toMatchObject([{ stt_ms: 400, endpoint_ms: 500, early: false }]);
    expect(r.warnings).toEqual([]);
  });

  it("keeps the old behaviour with QUORUM_COMPANION_EARLY_MS=0, and logs no timing for an empty answer", async () => {
    const r = rig({ QUORUM_COMPANION_EARLY_MS: "0" });
    await r.adapter.join(r.meeting, { displayName: "Betty Bee", voice: false });
    r.send(concat(tone(400), silence(200)));
    expect(r.calls).toHaveLength(0);
    r.send(silence(400));
    await tick();
    expect(r.calls).toHaveLength(1);
    expect(call(r.calls, 0).opts).toEqual({ hints: ["Betty", "Betty Bee"] });
    call(r.calls, 0).resolve("plain");
    await tick();
    expect(r.segments.map((s) => [s.text, s.final])).toEqual([["plain", true]]);
    expect(r.timings).toMatchObject([{ early: false }]);

    r.send(concat(tone(400), silence(600)));
    await tick();
    call(r.calls, 1).resolve("   ");
    await tick();
    expect(r.segments).toHaveLength(1);
    expect(r.timings).toHaveLength(1);
  });

  it("waits for speech worth sending, reuses an early answer on leave, and drops a draft for a meeting that left", async () => {
    const r = rig();
    await r.adapter.join(r.meeting, { displayName: "Betty Bee", voice: false });
    // Under QUORUM_COMPANION_MIN_SPEECH_MS of speech: nothing is asked early.
    r.send(concat(tone(200), silence(200)));
    expect(r.calls).toHaveLength(0);
    r.send(silence(400));
    r.send(concat(tone(400), silence(200)));
    expect(r.calls).toHaveLength(1);
    const leaving = r.adapter.leave(r.meeting);
    call(r.calls, 0).resolve("last words");
    await leaving;
    expect(r.calls).toHaveLength(1);
    expect(r.segments.map((s) => [s.text, s.final])).toEqual([["last words", true]]);
    expect(r.meeting.state).toBe("ended");

    // A meeting erased while the early request runs publishes nothing.
    const gone = rig();
    await gone.adapter.join(gone.meeting, { displayName: "Betty Bee", voice: false });
    gone.send(concat(tone(400), silence(200)));
    await gone.adapter.erase(gone.meeting);
    call(gone.calls, 0).resolve("nobody hears this");
    await tick();
    expect(gone.segments).toEqual([]);
  });
});

describe("companion platform end to end", () => {
  const stt = new FakeStt();
  let h: Harness | undefined;

  beforeAll(async () => {
    await stt.start();
  });
  afterAll(async () => {
    await stt.stop();
  });
  beforeEach(async () => {
    stt.bodies = [];
    stt.replies = [];
    const dir = tempDir();
    h = await startHarness({
      QUORUM_TRANSCRIBE_URL: stt.url,
      QUORUM_TRANSCRIBE_TOKEN_FILE: writeSecret(dir, "stt", "stt-token"),
      // One try per segment, so a scripted failure is a drop (retries: discord-units tests).
      QUORUM_TRANSCRIBE_MAX_ATTEMPTS: "1",
      QUORUM_COMPANION_SILENCE_MS: "100",
      QUORUM_COMPANION_MIN_SPEECH_MS: "60",
      QUORUM_COMPANION_MAX_SEGMENT_S: "5",
      QUORUM_COMPANION_MAX_CHUNK_BYTES: "65536",
      QUORUM_CHAT_CONFIRM_TIMEOUT_MS: "300",
      QUORUM_CHAT_CONFIRM_POLL_MS: "20",
    });
  });
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  function harness(): Harness {
    if (!h) throw new Error("no harness");
    return h;
  }

  async function join(args: Record<string, unknown> = {}): Promise<string> {
    const r = await harness().call("meeting.join", {
      platform: "companion",
      display_name: "Betty Bee",
      host_name: "Ana",
      ...args,
    });
    expect(r).toMatchObject({ ok: true, platform: "companion", state: "live" });
    return r.meeting_id as string;
  }

  function audio(
    id: string,
    channel: string,
    seq: number | string,
    body: Buffer,
    method = "POST",
  ): Promise<Response> {
    const q = new URLSearchParams({ meeting_id: id, channel, seq: String(seq) });
    return fetch(`${harness().q.url}/companion/audio?${q}`, {
      method,
      headers: { Authorization: `Bearer ${TOKEN}` },
      ...(method === "POST" ? { body: new Uint8Array(body) } : {}),
    });
  }

  function outbox(id: string, after?: string, method = "GET"): Promise<Response> {
    const q = new URLSearchParams({ meeting_id: id, ...(after === undefined ? {} : { after }) });
    return fetch(`${harness().q.url}/companion/outbox?${q}`, {
      method,
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
  }

  it("transcribes each channel into segments attributed to the host and the call", async () => {
    const id = await join();
    const sse = await openSse(`${harness().q.url}/events?meeting_id=${id}`);
    stt.replies.push({ status: 200, body: { text: "hello from the call" } });
    stt.replies.push({ status: 200, body: { text: "hello from Ana" } });
    const speech = bytes(concat(tone(300), silence(120)));
    const r1 = await audio(id, "call", 0, speech);
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ seq: 0, duplicate: false });
    await sse.waitFor((evs) => evs.some((e) => e.type === "segment"));
    expect((await audio(id, "mic", 0, speech)).status).toBe(200);
    await sse.waitFor((evs) => evs.filter((e) => e.type === "segment").length === 2);
    const segs = sse.events.filter((e) => e.type === "segment");
    expect(segs[0]).toMatchObject({
      speaker: CALL_SPEAKER,
      text: "hello from the call",
      final: true,
    });
    expect(segs[1]).toMatchObject({ speaker: { id: "host", name: "Ana" }, text: "hello from Ana" });
    expect(stt.bodies[0]?.headers["x-api-key"]).toBe("stt-token");
    expect(stt.bodies[0]?.body.includes(Buffer.from("WAVE"))).toBe(true);
    sse.close();
  });

  it("accepts chunks in order only and acknowledges resends", async () => {
    const id = await join({ host_name: undefined });
    const quiet = bytes(silence(100));
    expect((await audio(id, "call", 0, quiet)).status).toBe(200);
    const gap = await audio(id, "call", 2, quiet);
    expect(gap.status).toBe(409);
    expect(await gap.json()).toMatchObject({ expected_seq: 1 });
    const resend = await audio(id, "call", 0, quiet);
    expect(await resend.json()).toEqual({ seq: 0, duplicate: true });
    expect((await audio(id, "call", 1, Buffer.alloc(3))).status).toBe(400);
    expect((await audio(id, "video", 1, quiet)).status).toBe(400);
    expect((await audio(id, "call", "x", quiet)).status).toBe(400);
    expect((await audio(id, "call", 1, Buffer.alloc(65538))).status).toBe(413);
    expect((await audio("m_missing", "call", 0, quiet)).status).toBe(404);
    expect((await audio(id, "call", 1, quiet, "GET")).status).toBe(405);
  });

  it("names the mic channel Host when no host_name is given and drops failed transcriptions", async () => {
    const id = await join({ host_name: undefined });
    const sse = await openSse(`${harness().q.url}/events?meeting_id=${id}`);
    stt.replies.push({ status: 500, body: { error: "boom" } });
    stt.replies.push({ status: 200, body: { text: "second try" } });
    const speech = bytes(concat(tone(300), silence(120)));
    await audio(id, "mic", 0, speech);
    await audio(id, "mic", 1, speech);
    await sse.waitFor((evs) => evs.some((e) => e.type === "segment"));
    const segs = sse.events.filter((e) => e.type === "segment");
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({ speaker: { name: DEFAULT_HOST_NAME }, text: "second try" });
    sse.close();
  });

  it("queues chat lines for the companion window and confirms once they are fetched", async () => {
    const id = await join();
    const plain = await harness().call("chat.post", { meeting_id: id, text: "consent notice" });
    expect(plain).toMatchObject({ ok: true, delivery: "unconfirmed" });
    const confirming = harness().call("chat.post", {
      meeting_id: id,
      text: "an answer",
      confirm: true,
    });
    await new Promise((r) => setTimeout(r, 40));
    const res = await outbox(id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lines: { seq: number; text: string }[]; next_seq: number };
    expect(body.lines.map((l) => l.text)).toEqual(["consent notice", "an answer"]);
    expect(body.next_seq).toBe(2);
    expect(await confirming).toMatchObject({ ok: true, delivery: "confirmed" });
    const later = (await (await outbox(id, "2")).json()) as { lines: unknown[]; next_seq: number };
    expect(later).toEqual({ lines: [], next_seq: 2, tone: false });
    const unread = await harness().call("chat.post", {
      meeting_id: id,
      text: "nobody reads",
      confirm: true,
    });
    expect(unread).toMatchObject({ ok: true, delivery: "unconfirmed" });
    expect((await outbox(id, "-1")).status).toBe(400);
    expect((await outbox(id, undefined, "POST")).status).toBe(405);
    expect((await outbox("m_missing")).status).toBe(404);
  });

  it("hands the listening tone to the companion through its outbox once it is connected", async () => {
    const id = await join();
    const chime = () => harness().call("say.tone", { meeting_id: id });
    // The companion has not fetched anything yet, so nobody would hear the chime.
    expect(await chime()).toEqual({ ok: true, played: false });
    expect(await (await outbox(id)).json()).toMatchObject({ tone: false });
    expect(await chime()).toEqual({ ok: true, played: true });
    expect(await chime()).toEqual({ ok: true, played: false });
    expect(await (await outbox(id)).json()).toEqual({ lines: [], next_seq: 0, tone: true });
    expect(await (await outbox(id)).json()).toMatchObject({ tone: false });
  });

  it("cannot speak, refuses long host names, and flushes speech on leave", async () => {
    const long = await harness().call("meeting.join", {
      platform: "companion",
      display_name: "Betty",
      host_name: "x".repeat(101),
    });
    expect(long).toMatchObject({ ok: false, error: { code: "invalid_argument" } });
    const id = await join();
    expect(await harness().call("say", { meeting_id: id, text: "hi" })).toMatchObject({
      ok: false,
      error: { code: "platform_unavailable" },
    });
    // The companion has no speech of its own to prepare.
    expect(await harness().call("say.prewarm", { meeting_id: id, texts: ["Hello."] })).toEqual({
      ok: true,
      queued: 0,
    });
    const sse = await openSse(`${harness().q.url}/events?meeting_id=${id}`);
    stt.replies.push({ status: 200, body: { text: "last words" } });
    await audio(id, "call", 0, bytes(tone(300)));
    expect(await harness().call("meeting.leave", { meeting_id: id })).toMatchObject({
      ok: true,
      state: "ended",
    });
    await sse.waitFor((evs) => evs.some((e) => e.type === "state" && e.state === "ended"));
    expect(sse.events.find((e) => e.type === "segment")).toMatchObject({ text: "last words" });
    const after = await audio(id, "call", 1, bytes(silence(20)));
    expect(after.status).toBe(409);
    expect((await outbox(id)).status).toBe(409);
    expect(await harness().call("meeting.delete", { meeting_id: id })).toMatchObject({ ok: true });
    sse.close();
  });

  it("sends one padded request for an utterance whose pause runs to its end, as a draft then a final", async () => {
    await harness().close();
    const silenceMs = 500;
    h = await startHarness({
      QUORUM_TRANSCRIBE_URL: stt.url,
      QUORUM_COMPANION_SILENCE_MS: String(silenceMs),
    });
    const id = await join();
    const sse = await openSse(`${harness().q.url}/events?meeting_id=${id}`);
    stt.replies.push({ status: 200, body: { text: "introduce yourself" } });
    await audio(id, "mic", 0, bytes(concat(tone(400), silence(200))));
    await sse.waitFor((evs) => evs.some((e) => e.type === "segment"));
    await audio(id, "mic", 1, bytes(silence(400)));
    await sse.waitFor((evs) => evs.filter((e) => e.type === "segment").length === 2);
    expect(sse.events.filter((e) => e.type === "segment")).toMatchObject([
      { text: "introduce yourself", final: false, speaker: { id: "host", name: "Ana" } },
      { text: "introduce yourself", final: true, speaker: { id: "host", name: "Ana" } },
    ]);
    expect(stt.bodies).toHaveLength(1);
    // The early clip is the 600 ms received so far plus digital silence up to the full pause.
    const form = stt.bodies[0]?.body ?? Buffer.alloc(0);
    const riff = form.indexOf(Buffer.from("RIFF"));
    const wavDataSizeOffset = 40;
    const dataBytes = form.readUInt32LE(riff + wavDataSizeOffset);
    expect(dataBytes).toBe(samplesFor(400 + silenceMs) * 2);
    const wavHeaderBytes = 44;
    const tail = form.subarray(riff + wavHeaderBytes + dataBytes - samplesFor(300) * 2);
    expect(tail.subarray(0, samplesFor(300) * 2).every((b) => b === 0)).toBe(true);
    sse.close();
  });

  it("answers platform_unavailable without a transcription service", async () => {
    await harness().close();
    h = await startHarness({});
    const r = await harness().call("meeting.join", {
      platform: "companion",
      display_name: "Betty",
    });
    expect(r).toMatchObject({ ok: false, error: { code: "platform_unavailable" } });
  });
});
