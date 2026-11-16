import type { Meeting } from "./meeting.js";

/** What a platform must provide; the tool layer does validation and state checks first. */
export interface PlatformAdapter {
  /** Starts joining; resolves once the platform accepted the request (state may still be joining). */
  join(meeting: Meeting, args: JoinArgs): Promise<void>;
  leave(meeting: Meeting): Promise<void>;
  /** Refreshes meeting state and participants from the platform when the live feed may be stale. */
  refresh(meeting: Meeting): Promise<void>;
  chat(meeting: Meeting, text: string): Promise<void>;
  say(meeting: Meeting, text: string): Promise<void>;
  /** Erases the transcript upstream (quorum clears its own buffer afterwards). */
  erase(meeting: Meeting): Promise<void>;
}

export interface JoinArgs {
  url?: string;
  displayName: string;
  voice: boolean;
  voiceId?: string;
  passcode?: string;
  meetingUrl?: string;
  teamsBaseHost?: string;
}
