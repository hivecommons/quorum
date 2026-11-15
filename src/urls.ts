import { createHash } from "node:crypto";
import { QuorumError } from "./errors.js";

/**
 * Meeting URL to (platform, native meeting id), for the platforms Vexa joins. A TypeScript port
 * of Vexa's own parser (core/gateway/services/mcp/src/vexa_mcp/link_parser.py), so the native id
 * quorum derives is exactly the one Vexa keys the bot and transcript under.
 */

export type VexaPlatform = "google_meet" | "teams" | "zoom";
export const VEXA_PLATFORMS: readonly VexaPlatform[] = ["google_meet", "teams", "zoom"];

export interface ParsedMeeting {
  platform: VexaPlatform;
  nativeId: string;
  passcode?: string;
  /** The raw URL, sent to Vexa for links whose native id is a hash (legacy Teams). */
  meetingUrl?: string;
  /** The Teams web host for enterprise and government short links. */
  teamsBaseHost?: string;
}

const MEET_CODE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;
const MEET_NICKNAME = /^[a-z0-9][a-z0-9-]{3,38}[a-z0-9]$/;
const TEAMS_SHORT = /^\/meet\/(\d{10,17})\/?$/;
const ZOOM_ID = /^\d{9,11}$/;
const ZOOM_HOSTED_PATH = /^\/(?:meeting|j)\/(\d{10,11})\/?$/;
const TEAMS_HASH_LENGTH = 16;
const TEAMS_ENTERPRISE_HOSTS = new Set([
  "teams.microsoft.com",
  "gov.teams.microsoft.us",
  "dod.teams.microsoft.us",
]);

function invalid(message: string): QuorumError {
  return new QuorumError("invalid_argument", message);
}

/** True when host is domain or a dot-separated subdomain of it; never a substring test. */
export function hostIs(host: string, domain: string): boolean {
  return host === domain || host.endsWith("." + domain);
}

function isTeamsEnterpriseHost(host: string): boolean {
  return (
    TEAMS_ENTERPRISE_HOSTS.has(host) ||
    hostIs(host, "teams.microsoft.us") ||
    hostIs(host, "teams.microsoft.com")
  );
}

function teamsShort(nativeId: string, query: URLSearchParams, host: string): ParsedMeeting {
  const passcode = query.get("p") ?? undefined;
  return {
    platform: "teams",
    nativeId,
    teamsBaseHost: host,
    ...(passcode ? { passcode } : {}),
  };
}

function parseUrl(raw: string): URL {
  try {
    return new URL(raw);
  } catch {
    throw invalid("url is not a meeting link or a valid URL");
  }
}

export function parseMeetingUrl(input: string): ParsedMeeting {
  const raw = (input ?? "").trim();
  if (!raw) {
    throw invalid("url must not be empty");
  }
  if (MEET_CODE.test(raw.toLowerCase())) {
    return { platform: "google_meet", nativeId: raw.toLowerCase() };
  }
  if (ZOOM_ID.test(raw)) {
    return { platform: "zoom", nativeId: raw };
  }

  const url = parseUrl(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw invalid("url must be an http(s) meeting link");
  }
  const host = url.hostname.toLowerCase();
  const path = url.pathname;
  const query = url.searchParams;

  if (host === "meet.google.com") {
    if (path.startsWith("/lookup/")) {
      throw invalid("Google Meet /lookup/ links cannot be joined; use the link from the invite");
    }
    const code = (path.replace(/^\/+/, "").split("/")[0] ?? "").toLowerCase();
    if (MEET_CODE.test(code) || MEET_NICKNAME.test(code)) {
      return { platform: "google_meet", nativeId: code };
    }
    throw invalid("Google Meet link must look like https://meet.google.com/abc-defg-hij");
  }

  if (hostIs(host, "teams.live.com")) {
    const m = TEAMS_SHORT.exec(path);
    if (!m?.[1]) {
      throw invalid("teams.live.com link must look like /meet/<10-17 digit id>");
    }
    return teamsShort(m[1], query, host);
  }

  if (isTeamsEnterpriseHost(host)) {
    const fragment = decodeURIComponent(url.hash.replace(/^#/, ""));
    if (["/v2", ""].includes(path.replace(/\/+$/, "")) && fragment.startsWith("/meet/")) {
      const inner = new URL("https://x" + fragment);
      const fm = TEAMS_SHORT.exec(inner.pathname);
      if (fm?.[1]) {
        return teamsShort(fm[1], inner.searchParams, host);
      }
    }
    const m = TEAMS_SHORT.exec(path);
    if (m?.[1]) {
      return teamsShort(m[1], query, host);
    }
    if (path.includes("/l/meetup-join/")) {
      const hash = createHash("sha256").update(raw).digest("hex").slice(0, TEAMS_HASH_LENGTH);
      return { platform: "teams", nativeId: hash, meetingUrl: raw };
    }
    throw invalid("Teams link must look like /meet/<id>?p=<passcode> or /l/meetup-join/...");
  }

  if (host === "ev.zoom.com" || hostIs(host, "events.zoom.us")) {
    throw invalid("Zoom Events links are per-registrant and cannot be joined by a bot");
  }

  if (hostIs(host, "zoom.us") || hostIs(host, "zoomgov.com")) {
    const parts = path.split("/").filter(Boolean);
    let nativeId = "";
    if (parts.length >= 2 && (parts[0] === "j" || parts[0] === "w")) {
      nativeId = parts[1] ?? "";
    } else if (parts.length >= 3 && parts[0] === "wc" && parts[1] === "join") {
      nativeId = parts[2] ?? "";
    } else if (parts.length >= 3 && parts[0] === "wc" && parts[2] === "join") {
      nativeId = parts[1] ?? "";
    } else if (parts[0] === "my") {
      throw invalid("Zoom personal room links (/my/...) are not supported; use a /j/<id> link");
    }
    if (!ZOOM_ID.test(nativeId)) {
      throw invalid("Zoom link must look like https://zoom.us/j/<9-11 digit id>");
    }
    const passcode = query.get("pwd") ?? query.get("password") ?? undefined;
    return { platform: "zoom", nativeId, ...(passcode ? { passcode } : {}) };
  }

  // Zoom fronted on an organisation's own domain (zoom-lfx.platform.linuxfoundation.org):
  // recognised by Zoom's join path shape plus a passcode, never by the hostname.
  const hosted = ZOOM_HOSTED_PATH.exec(path);
  const hostedPass = query.get("password") ?? query.get("pwd");
  if (hosted?.[1] && hostedPass) {
    return { platform: "zoom", nativeId: hosted[1], passcode: hostedPass };
  }

  throw invalid(`unsupported meeting host ${host}; supported: Google Meet, Microsoft Teams, Zoom`);
}
