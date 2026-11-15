import { describe, expect, it } from "vitest";
import { Meeting, Registry, newMeetingId, type QuorumEvent } from "../src/meeting.js";

const alice = { id: "alice", name: "Alice" };

function meeting(bufferSize = 10): { m: Meeting; events: QuorumEvent[] } {
  const m = new Meeting({ platform: "google_meet", bufferSize, displayName: "Hive" });
  const events: QuorumEvent[] = [];
  m.onEvent((e) => events.push(e));
  return { m, events };
}

describe("Meeting", () => {
  it("generates distinct ids", () => {
    expect(newMeetingId()).toMatch(/^m_[A-Za-z0-9_-]+$/);
    expect(newMeetingId()).not.toBe(newMeetingId());
  });

  it("numbers segments and chat with one monotonic seq", () => {
    const { m, events } = meeting();
    m.addSegment({ key: "a", speaker: alice, text: "hello", start: 1, end: 2, final: true });
    m.addChat({ author: alice, text: "link", at: "2026-01-01T00:00:00.000Z" });
    m.addSegment({ key: "b", speaker: alice, text: "world", start: 3, end: 4, final: true });
    expect(events.map((e) => ("seq" in e ? e.seq : 0))).toEqual([1, 2, 3]);
    expect(m.lastSeq).toBe(3);
    expect(m.readSegments().segments.map((s) => s.text)).toEqual(["hello", "world"]);
    expect(m.participants).toEqual([alice]);
  });

  it("drops empty text, identical re-sends and drafts after a final", () => {
    const { m, events } = meeting();
    expect(
      m.addSegment({ key: "a", speaker: alice, text: "  ", start: 0, end: 0, final: false }),
    ).toBeUndefined();
    expect(m.addChat({ author: alice, text: " ", at: "x" })).toBeUndefined();
    m.addSegment({ key: "a", speaker: alice, text: "hel", start: 0, end: 1, final: false });
    m.addSegment({ key: "a", speaker: alice, text: "hel", start: 0, end: 1, final: false });
    m.addSegment({ key: "a", speaker: alice, text: "hello", start: 0, end: 1, final: false });
    m.addSegment({ key: "a", speaker: alice, text: "hello", start: 0, end: 1, final: true });
    m.addSegment({ key: "a", speaker: alice, text: "hello", start: 0, end: 1, final: true });
    m.addSegment({ key: "a", speaker: alice, text: "hello again", start: 0, end: 1, final: false });
    expect(events.map((e) => e.type === "segment" && [e.text, e.final])).toEqual([
      ["hel", false],
      ["hello", false],
      ["hello", true],
    ]);
  });

  it("replaces a corrected final in the buffer under a new seq", () => {
    const { m } = meeting();
    m.addSegment({ key: "a", speaker: alice, text: "helo", start: 0, end: 1, final: true });
    m.addSegment({ key: "b", speaker: alice, text: "next", start: 1, end: 2, final: true });
    m.addSegment({ key: "a", speaker: alice, text: "hello", start: 0, end: 1, final: true });
    const { segments, next_seq } = m.readSegments();
    expect(segments.map((s) => [s.seq, s.text])).toEqual([
      [2, "next"],
      [3, "hello"],
    ]);
    expect(next_seq).toBe(3);
  });

  it("bounds the buffer and the replay ring", () => {
    const { m } = meeting(2);
    for (let i = 0; i < 4; i++) {
      m.addSegment({
        key: String(i),
        speaker: alice,
        text: `t${i}`,
        start: i,
        end: i,
        final: true,
      });
    }
    expect(m.readSegments().segments.map((s) => s.text)).toEqual(["t2", "t3"]);
    expect(m.replayAfter(0).length).toBe(2);
  });

  it("reads after a cursor and keeps the cursor when nothing is new", () => {
    const { m } = meeting();
    m.addSegment({ key: "a", speaker: alice, text: "one", start: 0, end: 1, final: true });
    m.addSegment({ key: "b", speaker: alice, text: "draft", start: 0, end: 1, final: false });
    expect(m.readSegments(1)).toEqual({ segments: [], next_seq: 1 });
    expect(m.readSegments(7)).toEqual({ segments: [], next_seq: 7 });
    expect(m.readSegments(-3).next_seq).toBe(1);
    expect(m.replayAfter(1).map((e) => e.type)).toEqual(["segment"]);
  });

  it("emits state changes, keeps terminal states and records endedAt", () => {
    const { m, events } = meeting();
    expect(m.setState("joining")).toBe(true);
    expect(m.setState("joining")).toBe(false);
    expect(m.setState("lobby", "needs_help")).toBe(true);
    expect(m.setState("ended", "left")).toBe(true);
    expect(m.endedAt).toBeTypeOf("number");
    expect(m.setState("live")).toBe(false);
    expect(m.terminal).toBe(true);
    expect(events).toEqual([
      { type: "state", meeting_id: m.id, state: "joining" },
      { type: "state", meeting_id: m.id, state: "lobby", reason: "needs_help" },
      { type: "state", meeting_id: m.id, state: "ended", reason: "left" },
    ]);
  });

  it("attaches extra fields to a requested event", () => {
    const { m, events } = meeting();
    m.setState("requested", undefined, { guild_id: "1" });
    expect(events[0]).toMatchObject({ state: "requested", guild_id: "1" });
  });

  it("tracks participants and clears the transcript", () => {
    const { m } = meeting();
    m.addParticipant({ id: "", name: "nobody" });
    m.addParticipant(alice);
    m.addParticipant({ id: "alice", name: "Other" });
    expect(m.participants).toEqual([alice]);
    m.removeParticipant("alice");
    expect(m.participants).toEqual([]);
    m.addSegment({ key: "a", speaker: alice, text: "x", start: 0, end: 0, final: true });
    m.clearTranscript();
    expect(m.readSegments().segments).toEqual([]);
    expect(m.replayAfter(0)).toEqual([]);
    m.addSegment({ key: "a", speaker: alice, text: "x", start: 0, end: 0, final: true });
    expect(m.readSegments().segments.length).toBe(1);
  });
});

describe("Registry", () => {
  it("adds, finds, streams and removes meetings", () => {
    const r = new Registry(1000);
    const events: QuorumEvent[] = [];
    const removed: string[] = [];
    const off = r.onEvent((e) => events.push(e));
    r.onRemoved((id) => removed.push(id));
    const a = r.add(new Meeting({ platform: "zoom", bufferSize: 5 }));
    const b = r.add(new Meeting({ platform: "zoom", bufferSize: 5 }));
    a.nativeId = "1";
    b.nativeId = "1";
    expect(r.get(a.id)).toBe(a);
    expect(r.all().length).toBe(2);
    expect(r.findActive((m) => m.nativeId === "1")).toBeDefined();
    a.setState("joining");
    expect(events.length).toBe(1);
    off();
    a.setState("live");
    expect(events.length).toBe(1);
    r.remove(a.id);
    r.remove(a.id);
    expect(removed).toEqual([a.id]);
    b.setState("ended");
    expect(r.findActive(() => true)).toBeUndefined();
  });

  it("sweeps terminal meetings past retention", () => {
    const r = new Registry(1000);
    const a = r.add(new Meeting({ platform: "zoom", bufferSize: 5 }));
    const b = r.add(new Meeting({ platform: "zoom", bufferSize: 5 }));
    a.setState("ended");
    expect(r.sweep((a.endedAt ?? 0) + 500)).toBe(0);
    expect(r.sweep((a.endedAt ?? 0) + 1500)).toBe(1);
    expect(r.get(b.id)).toBe(b);
    expect(r.sweep()).toBe(0);
  });
});
