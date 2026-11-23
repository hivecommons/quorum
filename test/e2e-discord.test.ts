import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DiscordAdapter, HIVE_COMMAND } from "../src/discord/adapter.js";
import { discordAdapters } from "../src/discord/index.js";
import { loadConfig } from "../src/config.js";
import { silentLogger, createLogger } from "../src/log.js";
import { Registry } from "../src/meeting.js";
import {
  FakeChannel,
  FakeGuild,
  FakeStt,
  FakeTts,
  fakeRuntime,
  interaction,
  member,
  message,
  packets,
  pcm24,
  pcm48,
  type FakePlayer,
  type FakeRuntime,
} from "./helpers/fakeDiscord.js";
import { pcmFrames, upsampleToStereo48k } from "../src/audio.js";
import { fadeEdges } from "../src/discord/speech.js";
import { renderListeningTone } from "../src/tone.js";
import {
  openSse,
  startHarness,
  tempDir,
  until,
  writeSecret,
  type Harness,
} from "./helpers/harness.js";

const GUILD = "111111";
const CHANNEL = "222222";
const stt = new FakeStt();
const tts = new FakeTts();
let rt: FakeRuntime;
let h: Harness | undefined;
let guild: FakeGuild;
let channel: FakeChannel;

beforeAll(async () => {
  await stt.start();
  await tts.start();
});
afterAll(async () => {
  await stt.stop();
  await tts.stop();
});

async function boot(env: Record<string, string> = {}): Promise<void> {
  rt = fakeRuntime();
  guild = new FakeGuild(GUILD);
  channel = new FakeChannel(CHANNEL);
  channel.members.set("500001", member("500001", "Ana"));
  channel.members.set("500009", member("500009", "SomeBot", true));
  guild.channelsById.set(CHANNEL, channel);
  rt.client.guildMap.set(GUILD, guild);
  const dir = tempDir();
  h = await startHarness(
    {
      QUORUM_DISCORD_TOKEN_FILE: writeSecret(dir, "discord", "discord-bot-token"),
      QUORUM_TRANSCRIBE_URL: stt.url,
      QUORUM_TRANSCRIBE_TOKEN_FILE: writeSecret(dir, "stt", "stt-token"),
      QUORUM_TRANSCRIBE_LANGUAGE: "en",
      QUORUM_DISCORD_MIN_SEGMENT_MS: "100",
      QUORUM_DISCORD_MAX_SEGMENT_S: "2",
      ...env,
    },
    discordAdapters(async () => rt),
  );
  await until(() => guild.commandSets.length > 0);
}

beforeEach(() => {
  stt.bodies = [];
  stt.replies = [];
  tts.requests = [];
  tts.replies = [];
  tts.byInput.clear();
});
afterEach(async () => {
  await h?.close();
  h = undefined;
});

function H(): Harness {
  if (!h) throw new Error("not booted");
  return h;
}

async function joinDiscord(extra: Record<string, unknown> = {}): Promise<string> {
  const r = await H().call("meeting.join", {
    platform: "discord",
    guild_id: GUILD,
    channel_id: CHANNEL,
    ...extra,
  });
  expect(r).toMatchObject({ ok: true, platform: "discord", state: "live" });
  return r.meeting_id as string;
}

describe("Discord voice", () => {
  it("logs in, registers /hive per guild, joins and attributes segments by user", async () => {
    await boot();
    expect(rt.client.loginToken).toBe("discord-bot-token");
    expect(guild.commandSets[0]).toEqual([HIVE_COMMAND]);
    const id = await joinDiscord();
    const sse = await openSse(`${H().q.url}/events?meeting_id=${id}`);
    const conn = rt.connections[0];
    if (!conn) throw new Error("no connection");

    expect((await H().call("meeting.status", { meeting_id: id })).participants).toEqual([
      { id: "500001", name: "Ana" },
    ]);

    conn.speaking.emit("start", "500001");
    conn.speaking.emit("start", "500001");
    expect(conn.subscribeOpts).toEqual([{ end: { behavior: 1, duration: 500 } }]);
    const stream = conn.streams.get("500001");
    for (let i = 0; i < 25; i++) stream?.emit("data", pcm48(20));
    stream?.emit("end");
    await sse.waitFor((e) => e.some((x) => x.type === "segment"));
    const seg = sse.events.find((e) => e.type === "segment");
    expect(seg).toMatchObject({
      meeting_id: id,
      seq: 1,
      speaker: { id: "500001", name: "Ana" },
      text: "hello from discord",
      final: true,
    });
    expect(seg?.start).toBeGreaterThanOrEqual(0);
    expect((seg?.end as number) - (seg?.start as number)).toBeCloseTo(0.5, 2);
    const req = stt.bodies[0];
    expect(req?.headers["x-api-key"]).toBe("stt-token");
    const text = req?.body.toString("latin1") ?? "";
    expect(text).toContain("RIFF");
    expect(text).toContain('name="model"');
    expect(text).toContain('name="language"');
    expect((await H().call("transcript.read", { meeting_id: id })).segments).toHaveLength(1);
    sse.close();
  });

  it("cuts long speech at QUORUM_DISCORD_MAX_SEGMENT_S, drops short blips, bad packets and failed transcriptions", async () => {
    await boot({ QUORUM_TRANSCRIBE_MAX_ATTEMPTS: "1" });
    const id = await joinDiscord();
    const conn = rt.connections[0];
    conn?.speaking.emit("start", "500002");
    const s = conn?.streams.get("500002");
    for (let i = 0; i < 110; i++) s?.emit("data", pcm48(20));
    await until(() => stt.bodies.length === 1);
    stt.replies.push({ status: 500, body: "boom" });
    s?.emit("end");
    await new Promise((r) => setTimeout(r, 100));
    const segs = (await H().call("transcript.read", { meeting_id: id })).segments as {
      speaker: { name: string };
    }[];
    expect(segs).toHaveLength(1);
    expect(segs[0]?.speaker.name).toBe("user 500002");

    conn?.speaking.emit("start", "500003");
    rt.decodeError = true;
    conn?.streams.get("500003")?.emit("data", Buffer.alloc(10));
    rt.decodeError = false;
    conn?.streams.get("500003")?.emit("data", pcm48(20));
    conn?.streams.get("500003")?.emit("error", new Error("stream broke"));
    conn?.speaking.emit("start", "500004");
    stt.replies.push({ status: 200, body: { text: "   " } });
    for (let i = 0; i < 10; i++) conn?.streams.get("500004")?.emit("data", pcm48(20));
    conn?.streams.get("500004")?.emit("end");
    await until(() => stt.bodies.length === 3);
    await new Promise((r) => setTimeout(r, 50));
    expect((await H().call("transcript.read", { meeting_id: id })).segments).toHaveLength(1);
  });

  it("prompts Whisper with the bot's name and retries a busy service before keeping the segment", async () => {
    await boot({
      QUORUM_TRANSCRIBE_BACKOFF_BASE_MS: "1",
      QUORUM_TRANSCRIBE_BACKOFF_MAX_MS: "5",
      QUORUM_TRANSCRIBE_HOTWORDS: "Hive",
    });
    const id = await joinDiscord({ display_name: "Betty Bee from the hive" });
    stt.replies.push({ status: 503, body: "busy" }, { status: 502, body: "bad gateway" });
    const conn = rt.connections[0];
    conn?.speaking.emit("start", "500001");
    const s = conn?.streams.get("500001");
    for (let i = 0; i < 25; i++) s?.emit("data", pcm48(20));
    s?.emit("end");
    await until(() => stt.bodies.length === 3);
    await new Promise((r) => setTimeout(r, 50));
    const segs = (await H().call("transcript.read", { meeting_id: id })).segments as {
      text: string;
    }[];
    expect(segs.map((x) => x.text)).toEqual(["hello from discord"]);
    for (const b of stt.bodies) {
      const form = b.body.toString("latin1");
      expect(form).toContain('name="prompt"');
      expect(form).toContain("Betty, Betty Bee from the hive, Hive.");
    }
  });

  it("drops a segment only after the bounded attempts and keeps each speaker's order", async () => {
    await boot({
      QUORUM_TRANSCRIBE_MAX_ATTEMPTS: "2",
      QUORUM_TRANSCRIBE_BACKOFF_BASE_MS: "20",
      QUORUM_TRANSCRIBE_BACKOFF_MAX_MS: "40",
    });
    const id = await joinDiscord({ display_name: "Betty" });
    const conn = rt.connections[0];
    // First segment: one 503, then answered "one" on the retry. Second: answered "two" at once,
    // but it is only sent after the first settled, so the transcript reads in spoken order.
    stt.replies.push({ status: 503, body: "busy" }, { status: 200, body: { text: "one" } });
    stt.replies.push({ status: 200, body: { text: "two" } });
    conn?.speaking.emit("start", "500001");
    let s = conn?.streams.get("500001");
    for (let i = 0; i < 25; i++) s?.emit("data", pcm48(20));
    s?.emit("end");
    // A segment's key is its start in whole milliseconds: let the clock move on, as speech does.
    await new Promise((r) => setTimeout(r, 5));
    conn?.speaking.emit("start", "500001");
    s = conn?.streams.get("500001");
    for (let i = 0; i < 25; i++) s?.emit("data", pcm48(20));
    s?.emit("end");
    await until(() => stt.bodies.length === 3);
    await new Promise((r) => setTimeout(r, 50));
    let segs = (await H().call("transcript.read", { meeting_id: id })).segments as {
      text: string;
    }[];
    expect(segs.map((x) => x.text)).toEqual(["one", "two"]);

    stt.replies.push({ status: 503, body: "busy" }, { status: 503, body: "still busy" });
    conn?.speaking.emit("start", "500001");
    s = conn?.streams.get("500001");
    for (let i = 0; i < 25; i++) s?.emit("data", pcm48(20));
    s?.emit("end");
    await until(() => stt.bodies.length === 5);
    await new Promise((r) => setTimeout(r, 50));
    segs = (await H().call("transcript.read", { meeting_id: id })).segments as { text: string }[];
    expect(segs.map((x) => x.text)).toEqual(["one", "two"]);
  });

  it("never sends all-quiet audio, and merges a speaker's backlog into one request while STT is busy", async () => {
    await boot({
      QUORUM_TRANSCRIBE_MAX_ATTEMPTS: "2",
      QUORUM_TRANSCRIBE_BACKOFF_BASE_MS: "200",
      QUORUM_TRANSCRIBE_BACKOFF_MAX_MS: "200",
    });
    const id = await joinDiscord({ display_name: "Betty" });
    const conn = rt.connections[0];
    const speak = (value: number) => {
      conn?.speaking.emit("start", "500001");
      const s = conn?.streams.get("500001");
      for (let i = 0; i < 25; i++) s?.emit("data", pcm48(20, value));
      s?.emit("end");
    };
    speak(0);
    await new Promise((r) => setTimeout(r, 50));
    expect(stt.bodies).toHaveLength(0);

    // The first segment meets a busy service and waits out its backoff; two more arrive meanwhile.
    stt.replies.push(
      { status: 503, body: "busy" },
      { status: 200, body: { text: "first" } },
      { status: 200, body: { text: "second and third" } },
    );
    speak(1000);
    await until(() => stt.bodies.length === 1);
    speak(1000);
    speak(1000);
    await until(() => stt.bodies.length === 3);
    await new Promise((r) => setTimeout(r, 50));
    const segs = (await H().call("transcript.read", { meeting_id: id })).segments as {
      text: string;
      start: number;
      end: number;
    }[];
    expect(segs.map((x) => x.text)).toEqual(["first", "second and third"]);
    // The merged request carried both waiting segments: twice one segment's audio.
    const [, , merged] = stt.bodies;
    expect((merged?.body.length ?? 0) / (stt.bodies[0]?.body.length ?? 1)).toBeGreaterThan(1.8);
    expect(stt.bodies).toHaveLength(3);
  });

  it("tracks people joining and leaving the channel", async () => {
    await boot();
    const id = await joinDiscord();
    rt.client.emit(
      "voiceStateUpdate",
      { id: "500005", channelId: null },
      { id: "500005", channelId: CHANNEL, member: member("500005", "Bo") },
    );
    rt.client.emit(
      "voiceStateUpdate",
      { id: "500009", channelId: null },
      { id: "500009", channelId: CHANNEL, member: member("500009", "Bot", true) },
    );
    rt.client.emit(
      "voiceStateUpdate",
      { id: "500006", channelId: null },
      { id: "500006", channelId: "333333" },
    );
    let st = await H().call("meeting.status", { meeting_id: id });
    expect((st.participants as { name: string }[]).map((p) => p.name)).toEqual(["Ana", "Bo"]);
    rt.client.emit(
      "voiceStateUpdate",
      { id: "500005", channelId: CHANNEL },
      { id: "500005", channelId: null, member: null },
    );
    st = await H().call("meeting.status", { meeting_id: id });
    expect((st.participants as { name: string }[]).map((p) => p.name)).toEqual(["Ana"]);
  });

  it("posts chat to the voice channel's text chat and refuses say", async () => {
    await boot();
    const id = await joinDiscord();
    expect(await H().call("chat.post", { meeting_id: id, text: "notes are on" })).toMatchObject({
      ok: true,
      delivery: "confirmed",
    });
    expect(channel.sent).toEqual(["notes are on"]);
    channel.sendError = new Error("Missing Permissions");
    expect(await H().call("chat.post", { meeting_id: id, text: "x" })).toMatchObject({
      error: { code: "upstream_error", message: expect.stringContaining("Missing Permissions") },
    });
    expect(await H().call("say", { meeting_id: id, text: "x" })).toMatchObject({
      error: { code: "platform_unavailable" },
    });
  });

  it("is idempotent, leaves, and deletes", async () => {
    await boot();
    const id = await joinDiscord();
    expect(
      (
        await H().call("meeting.join", {
          platform: "discord",
          guild_id: GUILD,
          channel_id: CHANNEL,
        })
      ).meeting_id,
    ).toBe(id);
    expect(await H().call("meeting.leave", { meeting_id: id })).toEqual({
      ok: true,
      state: "ended",
    });
    expect(rt.connections[0]?.destroyed).toBe(true);
    expect(await H().call("chat.post", { meeting_id: id, text: "x" })).toMatchObject({
      error: { code: "not_live" },
    });
    const id2 = await joinDiscord();
    expect(id2).not.toBe(id);
    expect(await H().call("meeting.delete", { meeting_id: id2 })).toEqual({
      ok: true,
      deleted: true,
    });
    expect(rt.connections[1]?.destroyed).toBe(true);
    expect(await H().call("meeting.delete", { meeting_id: id })).toEqual({
      ok: true,
      deleted: true,
    });
  });

  it("ends the meeting when the voice connection is destroyed or does not recover", async () => {
    await boot();
    let id = await joinDiscord();
    rt.connections[0]?.emit("stateChange", { status: "ready" }, { status: "destroyed" });
    await until(() => H().q.quorum.registry.get(id)?.state === "ended");
    expect(H().q.quorum.registry.get(id)?.reason).toBe("disconnected");

    id = await joinDiscord();
    rt.recover = true;
    rt.connections[1]?.emit("stateChange", { status: "ready" }, { status: "disconnected" });
    rt.connections[1]?.emit("stateChange", { status: "ready" }, { status: "signalling" });
    await new Promise((r) => setTimeout(r, 20));
    expect(H().q.quorum.registry.get(id)?.state).toBe("live");
    rt.recover = false;
    rt.connections[1]?.emit("stateChange", { status: "ready" }, { status: "disconnected" });
    await until(() => H().q.quorum.registry.get(id)?.state === "ended");
    expect(rt.connections[1]?.destroyed).toBe(true);
  });

  it.each([
    ["unknown guild", () => rt.client.guildMap.clear(), "not_found"],
    ["missing channel", () => guild.channelsById.clear(), "invalid_argument"],
    ["text channel", () => (channel.voice = false), "invalid_argument"],
    ["no permission", () => (channel.joinable = false), "blocked"],
    ["voice timeout", () => (rt.readyError = true), "upstream_error"],
  ])("maps join failure: %s", async (_name, arrange, code) => {
    await boot();
    arrange();
    expect(
      await H().call("meeting.join", { platform: "discord", guild_id: GUILD, channel_id: CHANNEL }),
    ).toMatchObject({ ok: false, error: { code } });
    expect(H().q.quorum.registry.all()).toEqual([]);
  });

  it("names the missing voice permissions when the bot cannot join", async () => {
    await boot();
    channel.joinable = false;
    channel.granted = 1n << 10n; // View Channel only
    expect(
      await H().call("meeting.join", { platform: "discord", guild_id: GUILD, channel_id: CHANNEL }),
    ).toMatchObject({
      ok: false,
      error: { code: "blocked", message: expect.stringContaining("missing Connect") },
    });
  });

  it("asks for Speak too when the bot speaks", async () => {
    await boot(ttsEnv());
    channel.joinable = false;
    channel.granted = 0n;
    const res = await H().call("meeting.join", {
      platform: "discord",
      guild_id: GUILD,
      channel_id: CHANNEL,
    });
    expect(res).toMatchObject({
      error: {
        code: "blocked",
        message: expect.stringContaining("missing View Channel, Connect, Speak"),
      },
    });
  });

  it("names no permission when discord.js says unjoinable to an administrator", async () => {
    await boot();
    channel.joinable = false;
    channel.granted = 1n << 3n; // Administrator
    const res = await H().call("meeting.join", {
      platform: "discord",
      guild_id: GUILD,
      channel_id: CHANNEL,
    });
    expect(res).toMatchObject({ error: { code: "blocked" } });
    expect((res.error as { message: string }).message).not.toContain("missing");
  });

  it("fetches the bot's own member before judging the channel unjoinable", async () => {
    await boot();
    guild.members.me = null;
    channel.joinable = false;
    guild.onFetchMe = () => (channel.joinable = true);
    await joinDiscord();
    expect(guild.fetchMeCalls).toBe(1);
  });

  it("still answers blocked when the bot's member cannot be fetched", async () => {
    await boot();
    guild.members.me = null;
    guild.fetchMeError = new Error("Unknown Member");
    channel.joinable = false;
    expect(
      await H().call("meeting.join", { platform: "discord", guild_id: GUILD, channel_id: CHANNEL }),
    ).toMatchObject({ ok: false, error: { code: "blocked" } });
  });

  it("needs a transcription service", async () => {
    await boot({ QUORUM_TRANSCRIBE_URL: "" });
    expect(
      await H().call("meeting.join", { platform: "discord", guild_id: GUILD, channel_id: CHANNEL }),
    ).toMatchObject({
      error: {
        code: "platform_unavailable",
        message: expect.stringContaining("QUORUM_TRANSCRIBE_URL"),
      },
    });
  });
});

function ttsEnv(): Record<string, string> {
  return {
    QUORUM_TTS_URL: tts.url,
    QUORUM_TTS_TOKEN_FILE: writeSecret(tempDir(), "tts", "kokoro-key"),
  };
}

const S1 = "This is the first sentence of the line.";
const S2 = "And this is the second sentence of it.";
const S3 = "Here is a third one to end the line.";
const CLIP_SAMPLES = 600;
/** 600 samples at 24 kHz mono. */
const CLIP_MS = 25;

/** A TTS answer whose every sample is `value`, long enough that its middle is not faded. */
function clip(value: number): Buffer {
  return pcm24(Array.from({ length: CLIP_SAMPLES }, () => value));
}

/** The sample value in the middle of the i-th clip handed to the player. */
async function playedValue(i: number): Promise<number> {
  const pcm = Buffer.concat(await packets(player().played[i] as never));
  // Sample n of the 24 kHz clip is frame 2n of the 48 kHz stereo playback, 4 bytes a frame.
  return pcm.readInt16LE((CLIP_SAMPLES / 2) * 2 * 4);
}

function player(i = 0): FakePlayer {
  const p = rt.players[i];
  if (!p) throw new Error("no player");
  return p;
}

describe("Discord speech", () => {
  it("joins unmuted, synthesizes with Kokoro and plays 48 kHz stereo Opus frames", async () => {
    await boot(ttsEnv());
    const id = await joinDiscord();
    const conn = rt.connections[0];
    expect(conn?.joinOpts?.selfMute).toBe(false);
    expect(conn?.players).toEqual([player()]);
    const pcm = pcm24(Array.from({ length: 600 }, (_, i) => i));
    tts.replies.push({ status: 200, body: pcm });
    // 600 samples at 24 kHz mono = 25 ms of audio.
    expect(await H().call("say", { meeting_id: id, text: "Hello, I am Betty." })).toEqual({
      ok: true,
      queued: true,
      duration_ms: 25,
      first_audio_ms: expect.any(Number),
      synth_ms: expect.any(Number),
      cached: false,
    });
    expect(tts.requests[0]).toMatchObject({
      url: "/v1/audio/speech",
      headers: { "x-api-key": "kokoro-key" },
      body: { input: "Hello, I am Betty.", voice: "af_heart", response_format: "pcm" },
    });
    await until(() => player().played.length === 1);
    const got = await packets(player().played[0] as never);
    // Each clip is faded in and out before it is played.
    const want = pcmFrames(upsampleToStereo48k(fadeEdges(Buffer.from(pcm))));
    expect(got.length).toBe(want.length);
    expect(Buffer.concat(got).equals(Buffer.concat(want))).toBe(true);
    expect(rt.encodersFreed).toBe(1);
    player().finish();
  });

  it("plays clips in say order even when a later one synthesizes first, and skips failures", async () => {
    await boot(ttsEnv());
    const id = await joinDiscord({ voice_id: "bf_emma" });
    tts.byInput.set("first", { status: 200, body: clip(1), delayMs: 150 });
    tts.byInput.set("second", { status: 200, body: clip(2) });
    tts.byInput.set("broken", { status: 503, body: "kokoro is down" });
    tts.byInput.set("third", { status: 200, body: clip(3) });
    const first = H().call("say", { meeting_id: id, text: "first" });
    await until(() => tts.requests.length === 1);
    const second = H().call("say", { meeting_id: id, text: "second" });
    expect(await second).toMatchObject({ ok: true });
    expect(player().played).toHaveLength(0);
    expect(await first).toMatchObject({ ok: true });
    expect(await H().call("say", { meeting_id: id, text: "broken" })).toMatchObject({
      ok: false,
      error: { code: "upstream_error", message: expect.stringContaining("503") },
    });
    expect(await H().call("say", { meeting_id: id, text: "third" })).toMatchObject({ ok: true });
    expect(tts.requests.map((r) => r.body.voice)).toEqual([
      "bf_emma",
      "bf_emma",
      "bf_emma",
      "bf_emma",
    ]);

    await until(() => player().played.length === 1);
    expect(await playedValue(0)).toBe(1);
    player().finish();
    await until(() => player().played.length === 2);
    expect(await playedValue(1)).toBe(2);
    player().finish();
    await until(() => player().played.length === 3);
    expect(await playedValue(2)).toBe(3);
    player().finish();
  });

  it("speaks a line sentence by sentence: the first plays while the second is still synthesized", async () => {
    await boot(ttsEnv());
    const id = await joinDiscord();
    tts.byInput.set(S1, { status: 200, body: clip(1), delayMs: 60 });
    tts.byInput.set(S2, { status: 200, body: clip(2), delayMs: 250 });
    const saying = H().call("say", { meeting_id: id, text: `${S1}  ${S2}` });
    await until(() => tts.requests.length === 1);
    await new Promise((r) => setTimeout(r, 30));
    // One request at a time: the second sentence is not asked for while the first is synthesized.
    expect(tts.requests.map((r) => r.body.input)).toEqual([S1]);
    const said = await saying;
    // The answer came once the first sentence was ready, so the line's length is not known yet.
    expect(said).toEqual({
      ok: true,
      queued: true,
      first_audio_ms: expect.any(Number),
      synth_ms: said.first_audio_ms,
      cached: false,
    });
    await until(() => player().played.length === 1);
    expect(await playedValue(0)).toBe(1);
    await until(() => tts.requests.length === 2);
    expect(tts.requests.map((r) => r.body.input)).toEqual([S1, S2]);
    // The second sentence is still on its way while the first plays.
    expect(tts.byInput.get(S2)?.delayMs).toBeGreaterThan(said.first_audio_ms as number);
    player().finish();
    await until(() => player().played.length === 2);
    expect(await playedValue(1)).toBe(2);
    player().finish();

    // Said again: both sentences come from the cache, at once and with the line's real length.
    expect(await H().call("say", { meeting_id: id, text: `${S1} ${S2}` })).toEqual({
      ok: true,
      queued: true,
      duration_ms: CLIP_MS * 2,
      first_audio_ms: expect.any(Number),
      synth_ms: 0,
      cached: true,
    });
    expect(tts.requests).toHaveLength(2);
    await until(() => player().played.length === 3);
    expect(await playedValue(2)).toBe(1);
    player().finish();
    await until(() => player().played.length === 4);
    expect(await playedValue(3)).toBe(2);
    player().finish();
  });

  it("answers upstream_error and plays nothing of a line whose first sentence fails", async () => {
    await boot(ttsEnv());
    const id = await joinDiscord();
    tts.byInput.set(S1, { status: 503, body: "kokoro is down" });
    tts.byInput.set(S2, { status: 200, body: clip(2) });
    tts.byInput.set(S3, { status: 200, body: clip(3) });
    expect(await H().call("say", { meeting_id: id, text: `${S1} ${S2} ${S3}` })).toMatchObject({
      ok: false,
      error: { code: "upstream_error", message: expect.stringContaining("503") },
    });
    await new Promise((r) => setTimeout(r, 50));
    // The rest of the line was dropped without being synthesized.
    expect(tts.requests.map((r) => r.body.input)).toEqual([S1]);
    expect(player().played).toHaveLength(0);
    // The next line is not held up by it.
    expect(await H().call("say", { meeting_id: id, text: S3 })).toMatchObject({ ok: true });
    await until(() => player().played.length === 1);
    expect(await playedValue(0)).toBe(3);
    player().finish();
  });

  it("skips a later sentence that fails and plays the ones after it", async () => {
    await boot(ttsEnv());
    const id = await joinDiscord();
    tts.byInput.set(S1, { status: 200, body: clip(1) });
    tts.byInput.set(S2, { status: 503, body: "kokoro is down" });
    tts.byInput.set(S3, { status: 200, body: clip(3) });
    const said = await H().call("say", { meeting_id: id, text: `${S1} ${S2} ${S3}` });
    expect(said).toMatchObject({ ok: true, queued: true, cached: false });
    await until(() => tts.requests.length === 3);
    expect(tts.requests.map((r) => r.body.input)).toEqual([S1, S2, S3]);
    await until(() => player().played.length === 1);
    expect(await playedValue(0)).toBe(1);
    player().finish();
    await until(() => player().played.length === 2);
    expect(await playedValue(1)).toBe(3);
    player().finish();
    await new Promise((r) => setTimeout(r, 30));
    expect(player().played).toHaveLength(2);
  });

  it("prewarms fixed lines so a later say needs no synthesis, and validates say.prewarm", async () => {
    await boot({ ...ttsEnv(), QUORUM_SAY_MAX_CHARS: "100", QUORUM_SAY_PREWARM_MAX_LINES: "2" });
    const id = await joinDiscord({ voice_id: "bf_emma" });
    for (const texts of [
      undefined,
      "Hello.",
      [],
      ["Hello.", 7],
      ["Hello.", "   "],
      ["x".repeat(101)],
      ["one.", "two.", "three."],
    ]) {
      expect(await H().call("say.prewarm", { meeting_id: id, texts })).toMatchObject({
        ok: false,
        error: {
          code: "invalid_argument",
          message: expect.stringContaining("texts must be 1 to 2"),
        },
      });
    }
    expect(await H().call("say.prewarm", { meeting_id: "m_missing", texts: [S1] })).toMatchObject({
      error: { code: "not_found" },
    });
    expect(tts.requests).toHaveLength(0);

    tts.byInput.set(S1, { status: 200, body: clip(1) });
    tts.byInput.set(S2, { status: 200, body: clip(2) });
    expect(
      await H().call("say.prewarm", { meeting_id: id, texts: [`  ${S1} ${S2} `, "Leaving now."] }),
    ).toEqual({ ok: true, queued: 3 });
    await until(() => tts.requests.length === 3);
    await new Promise((r) => setTimeout(r, 30));
    expect(tts.requests.map((r) => [r.body.input, r.body.voice])).toEqual([
      [S1, "bf_emma"],
      [S2, "bf_emma"],
      ["Leaving now.", "bf_emma"],
    ]);
    // Nothing plays until the line is said.
    expect(player().played).toHaveLength(0);
    expect(await H().call("say.prewarm", { meeting_id: id, texts: [S1, "Leaving now."] })).toEqual({
      ok: true,
      queued: 0,
    });
    expect(await H().call("say", { meeting_id: id, text: `${S1} ${S2}` })).toEqual({
      ok: true,
      queued: true,
      duration_ms: CLIP_MS * 2,
      first_audio_ms: expect.any(Number),
      synth_ms: 0,
      cached: true,
    });
    expect(tts.requests).toHaveLength(3);
    await until(() => player().played.length === 1);
    expect(await playedValue(0)).toBe(1);

    expect(await H().call("meeting.delete", { meeting_id: id })).toMatchObject({ ok: true });
    const id2 = await joinDiscord();
    expect(await H().call("meeting.leave", { meeting_id: id2 })).toMatchObject({ ok: true });
    expect(await H().call("say.prewarm", { meeting_id: id2, texts: [S3] })).toMatchObject({
      error: { code: "not_live" },
    });
  });

  it("waits on meeting.leave for the speech that is playing, then leaves", async () => {
    await boot(ttsEnv());
    const id = await joinDiscord();
    expect(await H().call("say", { meeting_id: id, text: "Leaving now." })).toMatchObject({
      ok: true,
    });
    await until(() => player().played.length === 1);
    let left = false;
    const leaving = H()
      .call("meeting.leave", { meeting_id: id })
      .then((r) => {
        left = true;
        return r;
      });
    await new Promise((r) => setTimeout(r, 60));
    expect(left).toBe(false);
    expect(H().q.quorum.registry.get(id)?.state).toBe("live");
    expect(rt.connections[0]?.destroyed).toBe(false);
    expect(player().stops).toBe(0);
    player().finish();
    expect(await leaving).toEqual({ ok: true, state: "ended" });
    expect(H().q.quorum.registry.get(id)?.reason).toBe("left");
    expect(rt.connections[0]?.destroyed).toBe(true);
  });

  it("bounds that wait by QUORUM_LEAVE_DRAIN_TIMEOUT_MS, and does not wait at all with 0", async () => {
    const drainMs = 120;
    await boot({ ...ttsEnv(), QUORUM_LEAVE_DRAIN_TIMEOUT_MS: String(drainMs) });
    const id = await joinDiscord();
    await H().call("say", { meeting_id: id, text: "This clip never finishes." });
    await until(() => player().played.length === 1);
    const started = Date.now();
    expect(await H().call("meeting.leave", { meeting_id: id })).toEqual({
      ok: true,
      state: "ended",
    });
    // Timers may fire a millisecond early.
    expect(Date.now() - started).toBeGreaterThanOrEqual(drainMs - 5);
    expect(player().stops).toBe(1);
    expect(rt.connections[0]?.destroyed).toBe(true);
    await H().close();

    await boot({ ...ttsEnv(), QUORUM_LEAVE_DRAIN_TIMEOUT_MS: "0" });
    const id2 = await joinDiscord();
    await H().call("say", { meeting_id: id2, text: "This clip never finishes." });
    await until(() => player().played.length === 1);
    expect(await H().call("meeting.leave", { meeting_id: id2 })).toEqual({
      ok: true,
      state: "ended",
    });
    expect(player().stops).toBe(1);
  });

  it("still stops at once on /hive leave and on delete, even while a meeting.leave is waiting", async () => {
    await boot(ttsEnv());
    const id = await joinDiscord();
    const sse = await openSse(`${H().q.url}/events?meeting_id=${id}`);
    await H().call("say", { meeting_id: id, text: "This clip never finishes." });
    await until(() => player().played.length === 1);
    const leaving = H().call("meeting.leave", { meeting_id: id });
    await new Promise((r) => setTimeout(r, 30));
    const cmd = interaction({ sub: "leave" });
    rt.client.emit("interactionCreate", cmd);
    await until(() => cmd.replies.length === 1);
    expect(H().q.quorum.registry.get(id)?.reason).toBe("leave_command");
    expect(rt.connections[0]?.destroyed).toBe(true);
    expect(player().stops).toBe(1);
    // The waiting leave returns with the meeting as the command left it: one ended event.
    expect(await leaving).toEqual({ ok: true, state: "ended" });
    expect(H().q.quorum.registry.get(id)?.reason).toBe("leave_command");
    await new Promise((r) => setTimeout(r, 30));
    expect(sse.events.filter((e) => e.type === "state" && e.state === "ended")).toMatchObject([
      { reason: "leave_command" },
    ]);
    sse.close();

    const id2 = await joinDiscord();
    await H().call("say", { meeting_id: id2, text: "This clip never finishes." });
    await until(() => player(1).played.length === 1);
    expect(await H().call("meeting.delete", { meeting_id: id2 })).toMatchObject({ ok: true });
    expect(player(1).stops).toBe(1);
    expect(rt.connections[1]?.destroyed).toBe(true);
  });

  it("stops speech on leave, survives a playback error, and enforces the text cap", async () => {
    await boot({
      ...ttsEnv(),
      QUORUM_SAY_MAX_CHARS: "10",
      // The clip below never finishes, so the leave stops it after this wait.
      QUORUM_LEAVE_DRAIN_TIMEOUT_MS: "50",
    });
    const id = await joinDiscord();
    expect(await H().call("say", { meeting_id: id, text: "x".repeat(11) })).toMatchObject({
      error: { code: "invalid_argument" },
    });
    expect(tts.requests).toHaveLength(0);
    player().playError = new Error("player broke");
    expect(await H().call("say", { meeting_id: id, text: "oops" })).toMatchObject({ ok: true });
    await new Promise((r) => setTimeout(r, 20));
    player().playError = undefined;
    expect(await H().call("say", { meeting_id: id, text: "again" })).toMatchObject({ ok: true });
    await until(() => player().played.length === 1);
    player().emit("error", new Error("resource ended early"));
    expect(await H().call("meeting.leave", { meeting_id: id })).toMatchObject({ ok: true });
    expect(player().stops).toBeGreaterThanOrEqual(1);
    expect(await H().call("say", { meeting_id: id, text: "late" })).toMatchObject({
      error: { code: "not_live" },
    });
  });

  it("stays muted and answers platform_unavailable without QUORUM_TTS_URL", async () => {
    await boot();
    const id = await joinDiscord();
    expect(rt.connections[0]?.joinOpts?.selfMute).toBe(true);
    expect(rt.players).toHaveLength(0);
    expect(await H().call("say", { meeting_id: id, text: "x" })).toMatchObject({
      error: { code: "platform_unavailable", message: expect.stringContaining("QUORUM_TTS_URL") },
    });
    expect(await H().call("say.prewarm", { meeting_id: id, texts: ["Hello."] })).toEqual({
      ok: true,
      queued: 0,
    });
  });
});

describe("Discord typed chat", () => {
  it("emits chat events for people typing in the voice channel's text chat only", async () => {
    await boot();
    expect(rt.client.opts).toEqual({ messageContent: true });
    const id = await joinDiscord();
    const sse = await openSse(`${H().q.url}/events?meeting_id=${id}`);
    rt.client.emit("messageCreate", message({ content: "  can hive take notes?  " }));
    rt.client.emit("messageCreate", message({ channelId: "333333", content: "other channel" }));
    rt.client.emit("messageCreate", message({ guildId: "999999", content: "other guild" }));
    rt.client.emit("messageCreate", message({ bot: true, authorId: "500009", content: "a bot" }));
    rt.client.emit("messageCreate", message({ authorId: "424242", content: "ourselves" }));
    rt.client.emit("messageCreate", message({ webhookId: "77777", content: "a webhook" }));
    rt.client.emit("messageCreate", message({ content: "   " }));
    rt.client.emit(
      "messageCreate",
      message({ authorId: "500077", member: null, content: "no member" }),
    );
    await sse.waitFor((e) => e.filter((x) => x.type === "chat").length === 2);
    await new Promise((r) => setTimeout(r, 20));
    const chats = sse.events.filter((e) => e.type === "chat");
    expect(chats).toEqual([
      {
        type: "chat",
        meeting_id: id,
        seq: 1,
        author: { id: "500001", name: "Ana" },
        text: "can hive take notes?",
        at: "2026-11-16T12:00:00.000Z",
      },
      expect.objectContaining({
        seq: 2,
        author: { id: "500077", name: "Ana G" },
        text: "no member",
      }),
    ]);
    sse.close();
    await H().call("meeting.leave", { meeting_id: id });
    rt.client.emit("messageCreate", message({ content: "after leave" }));
  });

  it("logs in again without MessageContent when Discord refuses the intent, keeping voice", async () => {
    const lines: string[] = [];
    const r0 = fakeRuntime();
    r0.client.rejectIntents = true;
    const a = new DiscordAdapter({
      runtime: r0,
      registry: new Registry(1000),
      log: createLogger("debug", (l) => lines.push(l)),
      config: loadConfig({ QUORUM_DISCORD_COMMANDS: "off" }),
      transcriber: undefined,
    });
    await a.start("t");
    expect(a.isReady).toBe(true);
    expect(r0.clients.map((c) => c.opts)).toEqual([
      { messageContent: true },
      { messageContent: false },
    ]);
    expect(r0.clients[0]?.destroyed).toBe(true);
    expect(lines.filter((l) => l.includes("MessageContent intent is not enabled"))).toHaveLength(1);
    await a.close();
    expect(r0.clients[1]?.destroyed).toBe(true);

    const r1 = fakeRuntime();
    r1.client.loginError = new Error("Used disallowed intents");
    const b = new DiscordAdapter({
      runtime: r1,
      registry: new Registry(1000),
      log: silentLogger,
      config: loadConfig({ QUORUM_DISCORD_COMMANDS: "off" }),
      transcriber: undefined,
    });
    // The first client rejects login outright; the replacement (a fresh FakeClient) logs in.
    await b.start("t");
    expect(b.isReady).toBe(true);
    expect(r1.clients.map((c) => c.opts)).toEqual([
      { messageContent: true },
      { messageContent: false },
    ]);
  });

  it("still fails on other login errors", async () => {
    const r0 = fakeRuntime();
    r0.client.loginError = new Error("TOKEN_INVALID");
    const a = new DiscordAdapter({
      runtime: r0,
      registry: new Registry(1000),
      log: silentLogger,
      config: loadConfig({}),
      transcriber: undefined,
    });
    await expect(a.start("t")).rejects.toThrow("TOKEN_INVALID");
  });
});

describe("/hive slash commands", () => {
  it("raises a requested event hive approves with meeting.join, and /hive leave removes the bot", async () => {
    await boot();
    const all = await openSse(`${H().q.url}/events`);
    const i1 = interaction({ sub: "join" });
    rt.client.emit("interactionCreate", i1);
    await all.waitFor((e) => e.some((x) => x.state === "requested"));
    const req = all.events.find((x) => x.state === "requested");
    expect(req).toMatchObject({
      type: "state",
      platform: "discord",
      guild_id: GUILD,
      channel_id: CHANNEL,
      requested_by: { id: "900001", name: "Requester" },
    });
    expect(i1.replies[0]).toMatchObject({
      flags: 64,
      content: expect.stringContaining("once hive approves"),
    });

    const again = interaction({ sub: "join" });
    rt.client.emit("interactionCreate", again);
    await until(() => again.replies.length === 1);
    expect(again.replies[0]?.content).toMatch(/waiting for approval/);

    const approved = await H().call("meeting.join", {
      platform: "discord",
      guild_id: GUILD,
      channel_id: CHANNEL,
    });
    expect(approved).toMatchObject({ ok: true, meeting_id: req?.meeting_id, state: "live" });

    const here = interaction({ sub: "join" });
    rt.client.emit("interactionCreate", here);
    await until(() => here.replies.length === 1);
    expect(here.replies[0]?.content).toMatch(/already here/);

    const leave = interaction({ sub: "leave", channelId: null });
    rt.client.emit("interactionCreate", leave);
    await until(() => leave.replies.length === 1);
    expect(H().q.quorum.registry.get(req?.meeting_id as string)?.reason).toBe("leave_command");
    expect(rt.connections[0]?.destroyed).toBe(true);
    all.close();
  });

  it("lets hive decline a request, expires stale ones, and answers misuse", async () => {
    await boot({ QUORUM_DISCORD_REQUEST_TTL_S: "1" });
    rt.client.emit("interactionCreate", interaction({ sub: "join" }));
    await until(() => H().q.quorum.registry.all().length === 1);
    const pending = H().q.quorum.registry.all()[0];
    expect(await H().call("meeting.leave", { meeting_id: pending?.id })).toEqual({
      ok: true,
      state: "ended",
    });
    expect(pending?.reason).toBe("declined");

    rt.client.emit("interactionCreate", interaction({ sub: "join", channelId: "444444" }));
    await until(() =>
      H()
        .q.quorum.registry.all()
        .some((m) => m.channelId === "444444"),
    );
    const stale = H()
      .q.quorum.registry.all()
      .find((m) => m.channelId === "444444");
    await until(() => stale?.state === "ended", 2500);
    expect(stale?.reason).toBe("request_expired");

    const cases = [
      [interaction({ sub: "join", channelId: null }), /Join a voice channel first/],
      [interaction({ sub: "join", guildId: null }), /in a server/],
      [interaction({ sub: "leave" }), /not in a voice channel/],
    ] as const;
    for (const [i, msg] of cases) {
      rt.client.emit("interactionCreate", i);
      await until(() => i.replies.length === 1);
      expect(i.replies[0]?.content).toMatch(msg);
    }
    const other = interaction({ sub: "join", command: "other" });
    const notChat = interaction({ sub: "join", chat: false });
    const unknownSub = interaction({ sub: "dance" });
    rt.client.emit("interactionCreate", other);
    rt.client.emit("interactionCreate", notChat);
    rt.client.emit("interactionCreate", unknownSub);
    const broken = interaction({ sub: "join", channelId: null });
    broken.reply = async () => {
      throw new Error("interaction expired");
    };
    rt.client.emit("interactionCreate", broken);
    await new Promise((r) => setTimeout(r, 20));
    expect(other.replies.length + notChat.replies.length + unknownSub.replies.length).toBe(0);
  });
});

describe("DiscordAdapter lifecycle", () => {
  function adapter(rt0: FakeRuntime, env: Record<string, string> = {}) {
    const config = loadConfig({ QUORUM_TRANSCRIBE_URL: "http://stt", ...env });
    const lines: string[] = [];
    const a = new DiscordAdapter({
      runtime: rt0,
      registry: new Registry(1000),
      log: createLogger("debug", (l) => lines.push(l)),
      config,
      transcriber: undefined,
    });
    return { a, lines };
  }

  it("registers global commands, skips with off, and logs registration failures", async () => {
    const r1 = fakeRuntime();
    const { a } = adapter(r1, { QUORUM_DISCORD_COMMANDS: "global" });
    await a.start("t");
    expect(a.isReady).toBe(true);
    expect(r1.client.appCommands).toEqual([[HIVE_COMMAND]]);
    const g = new FakeGuild("777777");
    r1.client.emit("guildCreate", g);
    expect(g.commandSets).toEqual([]);
    await a.close();
    expect(r1.client.destroyed).toBe(true);

    const r2 = fakeRuntime();
    const { a: off } = adapter(r2, { QUORUM_DISCORD_COMMANDS: "off" });
    await off.start("t");
    expect(r2.client.appCommands).toEqual([]);

    const r3 = fakeRuntime();
    const bad = new FakeGuild("888888");
    bad.commandError = new Error("Missing Access");
    r3.client.guildMap.set(bad.id, bad);
    const { a: guildScoped, lines } = adapter(r3);
    await guildScoped.start("t");
    expect(lines.some((l) => l.includes("Missing Access"))).toBe(true);
    const late = new FakeGuild("999999");
    r3.client.emit("guildCreate", late);
    await until(() => late.commandSets.length === 1);

    const r4 = fakeRuntime();
    r4.client.application.commands.set = async () => {
      throw new Error("global refused");
    };
    const { a: g4, lines: l4 } = adapter(r4, { QUORUM_DISCORD_COMMANDS: "global" });
    await g4.start("t");
    expect(l4.some((l) => l.includes("global refused"))).toBe(true);
  });

  it("answers platform_unavailable before login completes and ends live meetings on close", async () => {
    await boot();
    const id = await joinDiscord();
    await H().q.close();
    expect(H().q.quorum.registry.get(id)?.reason).toBe("shutdown");
    expect(rt.client.destroyed).toBe(true);
    h = await startHarness(
      { QUORUM_DISCORD_TOKEN_FILE: writeSecret(tempDir(), "d", "tok") },
      discordAdapters(async () => {
        const slow = fakeRuntime();
        slow.client.login = () => new Promise(() => undefined);
        return slow;
      }),
    );
    expect(
      await H().call("meeting.join", { platform: "discord", guild_id: GUILD, channel_id: CHANNEL }),
    ).toMatchObject({
      error: { code: "platform_unavailable", message: expect.stringContaining("still connecting") },
    });
  });
});

describe("Discord listening tone", () => {
  const toneFrames = (): Buffer[] => pcmFrames(upsampleToStereo48k(renderListeningTone()));

  it("plays the chime at once as 48 kHz stereo Opus and answers played:true", async () => {
    await boot(ttsEnv());
    const id = await joinDiscord();
    expect(await H().call("say.tone", { meeting_id: id })).toEqual({ ok: true, played: true });
    expect(player().played.length).toBe(1);
    const got = await packets(player().played[0] as never);
    expect(got.length).toBe(toneFrames().length);
    expect(tts.requests.length).toBe(0);
    expect(rt.encodersFreed).toBe(1);
    // While it plays a second request is dropped; once it finished, the next one plays.
    expect(await H().call("say.tone", { meeting_id: id })).toEqual({ ok: true, played: false });
    player().finish();
    await new Promise((r) => setImmediate(r));
    expect(await H().call("say.tone", { meeting_id: id })).toEqual({ ok: true, played: true });
    expect(player().played.length).toBe(2);
    player().finish();
  });

  it("is dropped while a line is queued or playing, and never queues behind it", async () => {
    await boot(ttsEnv());
    const id = await joinDiscord();
    tts.replies.push({ status: 200, body: clip(1) });
    await H().call("say", { meeting_id: id, text: "Hello, I am Betty." });
    await until(() => player().played.length === 1);
    expect(await H().call("say.tone", { meeting_id: id })).toEqual({ ok: true, played: false });
    expect(player().played.length).toBe(1);
    player().finish();
  });

  it("is cut cleanly when a line starts during it, and the line plays", async () => {
    await boot(ttsEnv());
    const id = await joinDiscord();
    expect(await H().call("say.tone", { meeting_id: id })).toMatchObject({ played: true });
    tts.replies.push({ status: 200, body: clip(7) });
    await H().call("say", { meeting_id: id, text: "Hello, I am Betty." });
    expect(player().stops).toBe(1);
    await until(() => player().played.length === 2);
    expect(await playedValue(1)).toBe(7);
    player().finish();
  });

  it("is dropped when the bot has no voice (no TTS) and when the bot is no longer in the channel", async () => {
    await boot();
    const id = await joinDiscord();
    expect(await H().call("say.tone", { meeting_id: id })).toEqual({ ok: true, played: false });
    await H().call("meeting.leave", { meeting_id: id });
    expect(await H().call("say.tone", { meeting_id: id })).toMatchObject({
      ok: false,
      error: { code: "not_live" },
    });
    const meeting = H().q.quorum.registry.get(id);
    const adapter = H().q.quorum["adapter"]("discord");
    expect(await adapter.tone?.(meeting as never)).toBe(false);
  });

  it("answers without an error when the player fails, and frees the player for the next tone", async () => {
    await boot(ttsEnv());
    const id = await joinDiscord();
    player().playError = new Error("boom");
    expect(await H().call("say.tone", { meeting_id: id })).toEqual({ ok: true, played: true });
    // The failed play frees the player: a tone right after is allowed again.
    await new Promise((r) => setImmediate(r));
    expect(await H().call("say.tone", { meeting_id: id })).toEqual({ ok: true, played: true });
  });
});

describe("discordAdapters factory", () => {
  const ctx = (env: Record<string, string>) => ({
    config: loadConfig(env),
    registry: new Registry(1000),
    log: silentLogger,
  });

  it("returns nothing without a token, an unreadable token or an unloadable runtime", async () => {
    expect(await discordAdapters(async () => fakeRuntime())(ctx({}))).toEqual({});
    expect(
      await discordAdapters(async () => fakeRuntime())(ctx({ QUORUM_DISCORD_TOKEN_FILE: "/nope" })),
    ).toEqual({});
    const tok = writeSecret(tempDir(), "t", "token");
    expect(
      await discordAdapters(async () => {
        throw new Error("Cannot find module '@snazzah/davey'");
      })(ctx({ QUORUM_DISCORD_TOKEN_FILE: tok })),
    ).toEqual({});
  });

  it("keeps the adapter registered when login fails", async () => {
    const rt0 = fakeRuntime();
    rt0.client.loginError = new Error("TOKEN_INVALID");
    const tok = writeSecret(tempDir(), "t", "token");
    const out = await discordAdapters(async () => rt0)(ctx({ QUORUM_DISCORD_TOKEN_FILE: tok }));
    expect(out.discord).toBeInstanceOf(DiscordAdapter);
    await new Promise((r) => setTimeout(r, 10));
    expect((out.discord as DiscordAdapter).isReady).toBe(false);
  });
});
