import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { QuorumError } from "../src/errors.js";
import {
  DEFAULT_ZOOM_HOSTED_DOMAINS,
  hostIs,
  parseHostedZoomList,
  parseMeetingUrl,
} from "../src/urls.js";

describe("parseMeetingUrl: Google Meet", () => {
  it.each([
    ["https://meet.google.com/abc-defg-hij", "abc-defg-hij"],
    ["https://meet.google.com/abc-defg-hij?authuser=0", "abc-defg-hij"],
    ["https://meet.google.com/abc-defg-hij?pli=1&authuser=1#fragment", "abc-defg-hij"],
    ["https://meet.google.com/ABC-DEFG-HIJ", "abc-defg-hij"],
    ["http://meet.google.com/abc-defg-hij/", "abc-defg-hij"],
    ["meet.google.com/abc-defg-hij", "abc-defg-hij"],
    ["  https://meet.google.com/xyz-abcd-efg  ", "xyz-abcd-efg"],
    ["abc-defg-hij", "abc-defg-hij"],
    ["ABC-DEFG-HIJ", "abc-defg-hij"],
    ["https://meet.google.com/team-standup", "team-standup"],
  ])("%s", (url, id) => {
    expect(parseMeetingUrl(url)).toEqual({ platform: "google_meet", nativeId: id });
  });

  it.each([
    "https://meet.google.com/lookup/abcdefg",
    "https://meet.google.com/",
    "https://meet.google.com/a",
    "https://meet.google.com/bad_code!",
  ])("rejects %s", (url) => {
    expect(() => parseMeetingUrl(url)).toThrow(QuorumError);
  });
});

describe("parseMeetingUrl: Teams", () => {
  it.each([
    [
      "https://teams.microsoft.com/meet/3843823467839?p=AbCdEf123",
      "3843823467839",
      "AbCdEf123",
      "teams.microsoft.com",
    ],
    [
      "https://teams.microsoft.com/meet/38438234678394/",
      "38438234678394",
      undefined,
      "teams.microsoft.com",
    ],
    ["https://teams.live.com/meet/9876543210123?p=xyz", "9876543210123", "xyz", "teams.live.com"],
    ["https://teams.live.com/meet/9876543210", "9876543210", undefined, "teams.live.com"],
    [
      "https://gov.teams.microsoft.us/meet/1234567890123?p=gov",
      "1234567890123",
      "gov",
      "gov.teams.microsoft.us",
    ],
    [
      "https://dod.teams.microsoft.us/meet/1234567890123?p=dod",
      "1234567890123",
      "dod",
      "dod.teams.microsoft.us",
    ],
    [
      "https://contoso.teams.microsoft.com/meet/1234567890123?p=q",
      "1234567890123",
      "q",
      "contoso.teams.microsoft.com",
    ],
    [
      "https://teams.microsoft.com/v2/#/meet/1234567890123?p=frag",
      "1234567890123",
      "frag",
      "teams.microsoft.com",
    ],
    [
      "https://teams.microsoft.com/#/meet/1234567890123",
      "1234567890123",
      undefined,
      "teams.microsoft.com",
    ],
  ])("%s", (url, id, passcode, host) => {
    const r = parseMeetingUrl(url);
    expect(r.platform).toBe("teams");
    expect(r.nativeId).toBe(id);
    expect(r.passcode).toBe(passcode);
    expect(r.teamsBaseHost).toBe(host);
  });

  it("hashes legacy meetup-join links and keeps the URL", () => {
    const url =
      "https://teams.microsoft.com/l/meetup-join/19%3ameeting_NzQ1YjFhZTQtZmFkMS00@thread.v2/0?context=%7b%22Tid%22%3a%22abc%22%7d";
    const r = parseMeetingUrl(url);
    expect(r.platform).toBe("teams");
    expect(r.nativeId).toBe(createHash("sha256").update(url).digest("hex").slice(0, 16));
    expect(r.meetingUrl).toBe(url);
  });

  it.each([
    "https://teams.live.com/meet/abc",
    "https://teams.microsoft.com/l/channel/19:abc",
    "https://teams.microsoft.com/v2/#/calendar",
    "https://teams.microsoft.com/meet/123",
  ])("rejects %s", (url) => {
    expect(() => parseMeetingUrl(url)).toThrow(/Teams|teams/);
  });

  it("rejects a malformed percent escape in the fragment as invalid_argument", () => {
    let caught: unknown;
    try {
      parseMeetingUrl("https://teams.microsoft.com/v2/#/meet/%E0%A4%A");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(QuorumError);
    expect((caught as QuorumError).code).toBe("invalid_argument");
    expect((caught as QuorumError).message).toMatch(/percent-encoding/);
  });

  it("does not accept look-alike hosts", () => {
    expect(() =>
      parseMeetingUrl("https://teams.microsoft.com.evil.example/meet/1234567890123"),
    ).toThrow(/unsupported meeting host/);
    expect(() => parseMeetingUrl("https://evilteams.live.com/meet/1234567890123")).toThrow(
      /unsupported/,
    );
  });
});

describe("parseMeetingUrl: Zoom", () => {
  it.each([
    ["https://zoom.us/j/1234567890", "1234567890", undefined],
    ["https://zoom.us/j/1234567890?pwd=abcDEF.1", "1234567890", "abcDEF.1"],
    ["https://us02web.zoom.us/j/81234567890?pwd=Zz9", "81234567890", "Zz9"],
    ["https://us05web.zoom.us/j/123456789?password=p", "123456789", "p"],
    ["https://acme.zoom.us/w/98765432101?tk=t&pwd=x", "98765432101", "x"],
    ["https://zoom.us/wc/join/1234567890", "1234567890", undefined],
    ["https://zoom.us/wc/1234567890/join?pwd=w", "1234567890", "w"],
    ["https://frbmeetings.zoomgov.com/j/1609876543?pwd=gov", "1609876543", "gov"],
    [
      "https://zoom-lfx.platform.linuxfoundation.org/meeting/91234567890?password=uuid-1",
      "91234567890",
      "uuid-1",
    ],
    ["1234567890", "1234567890", undefined],
  ])("%s", (url, id, passcode) => {
    const r = parseMeetingUrl(url);
    expect(r).toEqual({
      platform: "zoom",
      nativeId: id,
      meetingUrl: /^\d+$/.test(url) ? `https://zoom.us/j/${id}` : new URL(url).href,
      ...(passcode ? { passcode } : {}),
    });
  });

  it("always carries an https meeting_url, since Vexa cannot build a Zoom URL from the id", () => {
    expect(parseMeetingUrl("http://us05web.zoom.us/j/12345678901?pwd=PLACEHOLDER").meetingUrl).toBe(
      "https://us05web.zoom.us/j/12345678901?pwd=PLACEHOLDER",
    );
    expect(parseMeetingUrl("zoom.us/j/1234567890").meetingUrl).toBe("https://zoom.us/j/1234567890");
  });

  it.each([
    ["https://zoom.us/my/alice", /personal room/],
    ["https://events.zoom.us/ev/abc", /Zoom Events/],
    ["https://ev.zoom.com/abc", /Zoom Events/],
    ["https://zoom.us/j/12345", /Zoom link/],
    ["https://zoom.us/", /Zoom link/],
    ["https://example.org/meeting/91234567890", /unsupported meeting host/],
  ])("rejects %s", (url, msg) => {
    expect(() => parseMeetingUrl(url)).toThrow(msg);
  });
});

describe("parseMeetingUrl: hosted Zoom allowlist", () => {
  const LFX = "zoom-lfx.platform.linuxfoundation.org";
  const path = "/j/1234567890?pwd=x";

  it("defaults to the LFX host only", () => {
    expect(DEFAULT_ZOOM_HOSTED_DOMAINS).toEqual([LFX]);
    expect(parseMeetingUrl(`https://${LFX}${path}`)).toMatchObject({ platform: "zoom" });
    expect(parseMeetingUrl(`https://${LFX.toUpperCase()}${path}`).platform).toBe("zoom");
  });

  it.each([
    "https://events.example.org/j/9123456789?pwd=hosted",
    `https://${LFX}.evil.com${path}`,
    `https://evilzoom-lfx.platform.linuxfoundation.org${path}`,
    `https://evil.${LFX}${path}`,
    `https://${LFX}@evil.com${path}`,
    "https://127.0.0.1/j/1234567890?pwd=x",
    "https://[::1]/j/1234567890?pwd=x",
    "https://[2001:db8::1]/j/1234567890?pwd=x",
    "https://2130706433/j/1234567890?pwd=x",
    "https://localhost/j/1234567890?pwd=x",
    "https://intranet/j/1234567890?pwd=x",
  ])("refuses %s", (url) => {
    expect(() => parseMeetingUrl(url)).toThrow(QuorumError);
  });

  it("refuses an IP literal or localhost even when listed", () => {
    expect(() => parseHostedZoomList("127.0.0.1")).toThrow(/invalid hosted Zoom domain/);
    expect(() => parseHostedZoomList("[::1]")).toThrow(/invalid hosted Zoom domain/);
    expect(() => parseHostedZoomList("localhost")).toThrow(/invalid hosted Zoom domain/);
    expect(() => parseHostedZoomList("intranet")).toThrow(/invalid hosted Zoom domain/);
    expect(() => parseHostedZoomList("user@zoom.example.org")).toThrow(/invalid/);
  });

  it("refuses credentials in the URL even for an allowed host", () => {
    expect(() => parseMeetingUrl(`https://user:pass@${LFX}${path}`)).toThrow(/credentials/);
  });

  it("refuses non-default ports and non-https schemes for an allowed host", () => {
    expect(() => parseMeetingUrl(`https://${LFX}:8443${path}`)).toThrow(/port/);
    expect(() => parseMeetingUrl(`http://${LFX}${path}`)).toThrow(/https/);
    expect(parseMeetingUrl(`https://${LFX}:443${path}`).platform).toBe("zoom");
  });

  it("accepts a port only when the allowlist entry names it", () => {
    const opts = { zoomHostedDomains: ["zoom.example.org:8443"] };
    expect(parseMeetingUrl(`https://zoom.example.org:8443${path}`, opts).platform).toBe("zoom");
    expect(() => parseMeetingUrl(`https://zoom.example.org${path}`, opts)).toThrow(QuorumError);
  });

  it("an empty allowlist turns the hosted branch off", () => {
    expect(() => parseMeetingUrl(`https://${LFX}${path}`, { zoomHostedDomains: [] })).toThrow(
      /unsupported meeting host/,
    );
    expect(parseHostedZoomList("")).toEqual([]);
    expect(parseHostedZoomList(" , ")).toEqual([]);
  });

  it("an env-style list can add a second domain", () => {
    const opts = { zoomHostedDomains: parseHostedZoomList(`${LFX}, Events.Example.org`) };
    expect(parseMeetingUrl(`https://events.example.org${path}`, opts).platform).toBe("zoom");
    expect(parseMeetingUrl(`https://${LFX}${path}`, opts).platform).toBe("zoom");
    expect(() => parseMeetingUrl(`https://other.example.org${path}`, opts)).toThrow(QuorumError);
  });

  it.each(["*.example.org", ".example.org"])("suffix entry %s matches subdomains only", (entry) => {
    const opts = { zoomHostedDomains: [entry] };
    expect(parseMeetingUrl(`https://a.example.org${path}`, opts).platform).toBe("zoom");
    expect(parseMeetingUrl(`https://a.b.example.org${path}`, opts).platform).toBe("zoom");
    expect(() => parseMeetingUrl(`https://example.org${path}`, opts)).toThrow(QuorumError);
    expect(() => parseMeetingUrl(`https://evilexample.org${path}`, opts)).toThrow(QuorumError);
    expect(() => parseMeetingUrl(`https://a.example.org.evil.com${path}`, opts)).toThrow(
      QuorumError,
    );
  });

  it("does not weaken the zoom.us branch when the allowlist is empty", () => {
    expect(
      parseMeetingUrl("https://zoom.us/j/1234567890?pwd=x", { zoomHostedDomains: [] }).platform,
    ).toBe("zoom");
  });
});

describe("parseMeetingUrl: everything else", () => {
  it.each([
    ["", /must not be empty/],
    ["   ", /must not be empty/],
    ["ftp://zoom.us/j/1234567890", /http\(s\)/],
    ["https://", /not a meeting link/],
    ["https://meet.jit.si/MyRoom", /unsupported meeting host meet.jit.si/],
    ["https://example.com/abc-defg-hij", /unsupported/],
    ["not a url at all", /not a meeting link|unsupported/],
  ])("rejects %j", (url, msg) => {
    try {
      parseMeetingUrl(url);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(QuorumError);
      expect((err as QuorumError).code).toBe("invalid_argument");
      expect((err as Error).message).toMatch(msg);
    }
  });

  it("treats undefined input as empty", () => {
    expect(() => parseMeetingUrl(undefined as unknown as string)).toThrow(/empty/);
  });
});

describe("hostIs", () => {
  it("matches the domain and dot-subdomains only", () => {
    expect(hostIs("zoom.us", "zoom.us")).toBe(true);
    expect(hostIs("a.zoom.us", "zoom.us")).toBe(true);
    expect(hostIs("notzoom.us", "zoom.us")).toBe(false);
    expect(hostIs("zoom.us.evil", "zoom.us")).toBe(false);
  });
});
