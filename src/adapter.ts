import type { Meeting } from "./meeting.js";

/** What a platform must provide; the tool layer does validation and state checks first. */
export interface PlatformAdapter {
  /** Starts joining; resolves once the platform accepted the request (state may still be joining). */
  join(meeting: Meeting, args: JoinArgs): Promise<void>;
  leave(meeting: Meeting): Promise<void>;
  /** Refreshes meeting state and participants from the platform when the live feed may be stale. */
  refresh(meeting: Meeting): Promise<void>;
  /**
   * Posts a line. With `confirm`, resolves only once the platform reports the line in the meeting
   * (`confirmed`), throws when it reports the send failed, and answers `unconfirmed` when it gave no
   * verdict in time. Without it, `confirmed` means the platform's send call itself delivered the
   * line (Discord) and `unconfirmed` that it only accepted it (Vexa).
   */
  chat(meeting: Meeting, text: string, opts?: ChatOptions): Promise<ChatDelivery>;
  say(meeting: Meeting, text: string): Promise<void>;
  /** Erases the transcript upstream (quorum clears its own buffer afterwards). */
  erase(meeting: Meeting): Promise<void>;
}

export interface ChatOptions {
  confirm?: boolean;
}

/** Whether a chat line is known to be in the meeting (docs/contract.md, chat.post). */
export type ChatDelivery = "confirmed" | "unconfirmed";

export interface JoinArgs {
  url?: string;
  displayName: string;
  voice: boolean;
  voiceId?: string;
  passcode?: string;
  meetingUrl?: string;
  teamsBaseHost?: string;
  /** Companion meetings: the name the `mic` channel's segments are attributed to. */
  hostName?: string;
}
