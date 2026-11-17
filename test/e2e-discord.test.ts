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
import { pcmFrames, upsampleToStereo48k } from "../src/discord/audio.js";
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
    expect(conn.subscribeOpts).toEqual([{ end: { behavior: 1, duration: 800 } }]);
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
    await boot();
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
    expect(await H().call("say", { meeting_id: id, text: "Hello, I am Betty." })).toEqual({
      ok: true,
      queued: true,
    });
    expect(tts.requests[0]).toMatchObject({
      url: "/v1/audio/speech",
      headers: { "x-api-key": "kokoro-key" },
      body: { input: "Hello, I am Betty.", voice: "af_heart", response_format: "pcm" },
    });
    await until(() => player().played.length === 1);
    const got = await packets(player().played[0] as never);
    const want = pcmFrames(upsampleToStereo48k(pcm));
    expect(got.length).toBe(want.length);
    expect(Buffer.concat(got).equals(Buffer.concat(want))).toBe(true);
    expect(rt.encodersFreed).toBe(1);
    player().finish();
  });

  it("plays clips in say order even when a later one synthesizes first, and skips failures", async () => {
    await boot(ttsEnv());
    const id = await joinDiscord({ voice_id: "bf_emma" });
    tts.byInput.set("first", { status: 200, body: pcm24([1, 1]), delayMs: 150 });
    tts.byInput.set("second", { status: 200, body: pcm24([2, 2]) });
    tts.byInput.set("broken", { status: 503, body: "kokoro is down" });
    tts.byInput.set("third", { status: 200, body: pcm24([3, 3]) });
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

    const firstSample = async (i: number): Promise<number> =>
      Buffer.concat(await packets(player().played[i] as never)).readInt16LE(0);
    await until(() => player().played.length === 1);
    expect(await firstSample(0)).toBe(1);
    player().finish();
    await until(() => player().played.length === 2);
    expect(await firstSample(1)).toBe(2);
    player().finish();
    await until(() => player().played.length === 3);
    expect(await firstSample(2)).toBe(3);
    player().finish();
  });

  it("stops speech on leave, survives a playback error, and enforces the text cap", async () => {
    await boot({ ...ttsEnv(), QUORUM_SAY_MAX_CHARS: "10" });
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
