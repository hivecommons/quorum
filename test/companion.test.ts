import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  CALL_SPEAKER,
  CompanionAdapter,
  DEFAULT_HOST_NAME,
  isCompanionChannel,
} from "../src/companion/adapter.js";
import { FRAME_SAMPLES, rms, Segmenter } from "../src/companion/segmenter.js";
import { loadConfig } from "../src/config.js";
import { silentLogger } from "../src/log.js";
import { Meeting } from "../src/meeting.js";
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
    expect(later).toEqual({ lines: [], next_seq: 2 });
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
