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
  /**
   * The join URL sent to Vexa as `meeting_url`: the raw link for legacy Teams (whose native id is
   * a hash), and the https join link for every Zoom meeting, since Vexa cannot construct a Zoom
   * URL from the id and refuses a Zoom bot without one.
   */
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

/** The base Vexa's own parser recognises for a Zoom meeting given only by its numeric id. */
const ZOOM_JOIN_BASE = "https://zoom.us/j/";

/** A Zoom meeting with its join URL forced to https (Vexa's bot joins over TLS only). */
function zoomMeeting(
  nativeId: string,
  url: URL | undefined,
  passcode: string | undefined,
): ParsedMeeting {
  let meetingUrl = ZOOM_JOIN_BASE + nativeId;
  if (url) {
    const secure = new URL(url.href);
    secure.protocol = "https:";
    meetingUrl = secure.href;
  }
  return { platform: "zoom", nativeId, meetingUrl, ...(passcode ? { passcode } : {}) };
}

/** The one known real deployment of Zoom fronted on an organisation's own domain. */
export const DEFAULT_ZOOM_HOSTED_DOMAINS: readonly string[] = [
  "zoom-lfx.platform.linuxfoundation.org",
];

const HTTPS_DEFAULT_PORT = "443";
const HOSTNAME_CHARS = /^[a-z0-9.-]+$/;
const ENTRY_PORT = /^(.*):(\d{1,5})$/;

/**
 * Hostnames the hosted-Zoom branch may accept: URL-normalised (lowercase, punycode), either exact
 * or, for a "*." or "." entry, any subdomain of the suffix (dot boundary; never the apex itself).
 * An entry may end in :port; without one only the https default port is accepted.
 */
interface HostedEntry {
  host: string;
  suffix: boolean;
  port: string;
}

/** True for a host that is not a plain DNS name: IP literals, localhost, dotless, odd characters. */
function unsafeHostedHost(host: string): boolean {
  if (!HOSTNAME_CHARS.test(host) || !host.includes(".")) {
    return true;
  }
  const labels = host.split(".");
  if (labels.some((l) => l === "") || host === "localhost" || host.endsWith(".localhost")) {
    return true;
  }
  // IPv4 in any form the URL parser accepts normalises to dotted digits; a numeric last label never
  // belongs to a real domain.
  return /^\d+$/.test(labels[labels.length - 1] ?? "");
}

export function parseHostedZoomEntries(domains: readonly string[]): HostedEntry[] {
  const entries: HostedEntry[] = [];
  for (const rawEntry of domains) {
    let e = rawEntry.trim().toLowerCase();
    if (!e) {
      continue;
    }
    let suffix = false;
    if (e.startsWith("*.")) {
      suffix = true;
      e = e.slice(2);
    } else if (e.startsWith(".")) {
      suffix = true;
      e = e.slice(1);
    }
    let port = HTTPS_DEFAULT_PORT;
    const pm = ENTRY_PORT.exec(e);
    if (pm?.[1] && pm[2]) {
      e = pm[1];
      port = pm[2];
    }
    let host: string;
    try {
      host = new URL(`https://${e}`).hostname;
    } catch {
      throw new Error(`invalid hosted Zoom domain ${JSON.stringify(rawEntry)}`);
    }
    if (/[/@?#\\]/.test(e) || unsafeHostedHost(host)) {
      throw new Error(`invalid hosted Zoom domain ${JSON.stringify(rawEntry)}`);
    }
    entries.push({ host, suffix, port });
  }
  return entries;
}

/** Parses the comma-separated QUORUM_ZOOM_HOSTED_DOMAINS value into entries; "" disables the branch. */
export function parseHostedZoomList(raw: string): string[] {
  const list = raw
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
  parseHostedZoomEntries(list); // validate now so a bad env fails at startup
  return list;
}

function hostedEntryFor(host: string, entries: HostedEntry[]): HostedEntry | undefined {
  return entries.find((e) => (e.suffix ? host.endsWith("." + e.host) : host === e.host));
}

export interface ParseOptions {
  /** Hosted-Zoom allowlist (QUORUM_ZOOM_HOSTED_DOMAINS); default is DEFAULT_ZOOM_HOSTED_DOMAINS. */
  zoomHostedDomains?: readonly string[];
}

function parseUrl(raw: string): URL {
  try {
    return new URL(raw);
  } catch {
    throw invalid("url is not a meeting link or a valid URL");
  }
}

export function parseMeetingUrl(input: string, options: ParseOptions = {}): ParsedMeeting {
  const raw = (input ?? "").trim();
  if (!raw) {
    throw invalid("url must not be empty");
  }
  if (MEET_CODE.test(raw.toLowerCase())) {
    return { platform: "google_meet", nativeId: raw.toLowerCase() };
  }
  if (ZOOM_ID.test(raw)) {
    return zoomMeeting(raw, undefined, undefined);
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
    return zoomMeeting(nativeId, url, passcode);
  }

  // Zoom fronted on an organisation's own domain: only for an explicitly allowlisted hostname
  // (never "any host": the URL is handed to a bot that fetches it), and only in Zoom's join path
  // shape with a passcode.
  const hosted = ZOOM_HOSTED_PATH.exec(path);
  const hostedPass = query.get("password") ?? query.get("pwd");
  if (hosted?.[1] && hostedPass && !unsafeHostedHost(host)) {
    const entry = hostedEntryFor(
      host,
      parseHostedZoomEntries(options.zoomHostedDomains ?? DEFAULT_ZOOM_HOSTED_DOMAINS),
    );
    if (entry) {
      if (url.protocol !== "https:") {
        throw invalid("hosted Zoom links must be https");
      }
      if (url.username || url.password) {
        throw invalid("hosted Zoom links must not carry credentials in the URL");
      }
      if ((url.port || HTTPS_DEFAULT_PORT) !== entry.port) {
        throw invalid(`hosted Zoom link port is not allowed for ${host}`);
      }
      return zoomMeeting(hosted[1], url, hostedPass);
    }
  }

  throw invalid(`unsupported meeting host ${host}; supported: Google Meet, Microsoft Teams, Zoom`);
}
