import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { failure, type ToolResult } from "./errors.js";
import type { Logger } from "./log.js";
import { silentLogger } from "./log.js";
import type { Quorum } from "./service.js";
import { VERSION } from "./version.js";

/**
 * The MCP surface: the seven contract tools with JSON Schemas. Arguments are validated by the
 * service, not the SDK, so a bad argument still yields the contract error shape. Each result is
 * returned both as `structuredContent` and as JSON text; `isError` is set when `ok` is false.
 */

const meetingId = { type: "string", description: "The meeting_id meeting.join returned" };

export const TOOLS = [
  {
    name: "meeting.join",
    description:
      "Join a meeting. Google Meet, Teams and Zoom are inferred from url; Discord takes " +
      '{platform:"discord", guild_id, channel_id}. Returns {meeting_id, platform, state}.',
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Meeting link (Meet, Teams, Zoom)" },
        display_name: { type: "string", description: "Name the bot shows in the meeting" },
        platform: { type: "string", enum: ["google_meet", "teams", "zoom", "discord"] },
        guild_id: { type: "string", description: "Discord server id" },
        channel_id: { type: "string", description: "Discord voice channel id" },
        voice: { type: "boolean", description: "Start the bot with voice so say works" },
        voice_id: {
          type: "string",
          description: "TTS voice for say (Discord: a Kokoro voice such as af_heart)",
        },
      },
    },
  },
  {
    name: "meeting.leave",
    description: "Leave a meeting. Returns {state}.",
    inputSchema: {
      type: "object",
      properties: { meeting_id: meetingId },
      required: ["meeting_id"],
    },
  },
  {
    name: "meeting.status",
    description: "Current state and participants. Returns {state, participants:[{id,name}]}.",
    inputSchema: {
      type: "object",
      properties: { meeting_id: meetingId },
      required: ["meeting_id"],
    },
  },
  {
    name: "transcript.read",
    description:
      "Final transcript segments with seq greater than after_seq. Returns {segments, next_seq}; " +
      "pass next_seq back as after_seq to continue.",
    inputSchema: {
      type: "object",
      properties: { meeting_id: meetingId, after_seq: { type: "integer", minimum: 0 } },
      required: ["meeting_id"],
    },
  },
  {
    name: "chat.post",
    description:
      "Post a line in the meeting chat. Returns {posted_at, delivery}. With confirm:true it waits " +
      "for the platform to report the line in the meeting: delivery is confirmed, or unconfirmed " +
      "when no verdict came in time; a send the platform reports as failed is platform_unavailable.",
    inputSchema: {
      type: "object",
      properties: { meeting_id: meetingId, text: { type: "string" }, confirm: { type: "boolean" } },
      required: ["meeting_id", "text"],
    },
  },
  {
    name: "say",
    description:
      "Speak text aloud in the meeting. Lines of one meeting play one after another, never over " +
      "each other. Returns {queued:true, duration_ms?, first_audio_ms?, synth_ms?, cached?}: " +
      "duration_ms is the clip's real length when the platform reports it, first_audio_ms the " +
      "time from the request to the first audio. A line the platform could not speak (for " +
      "example a muted microphone) is platform_unavailable naming the reason.",
    inputSchema: {
      type: "object",
      properties: { meeting_id: meetingId, text: { type: "string" } },
      required: ["meeting_id", "text"],
    },
  },
  {
    name: "say.tone",
    description:
      "Play the listening tone: a short, soft two-note chime that tells the room the bot heard " +
      "its name and is about to answer. Not speech. Returns {played}: true when the bot was " +
      "asked to play it, false when it was dropped on purpose (a line is being spoken, the bot " +
      "has no voice, or the platform has no tone). Never waits for the sound and never queues " +
      "behind speech.",
    inputSchema: {
      type: "object",
      properties: { meeting_id: meetingId },
      required: ["meeting_id"],
    },
  },
  {
    name: "say.prewarm",
    description:
      "Get fixed lines (an introduction, acknowledgements, a goodbye) ready so a later say of " +
      "the same text starts at once. Returns {queued}: the pieces sent for synthesis in the " +
      "background; 0 when they are ready already or the platform prepares its own speech.",
    inputSchema: {
      type: "object",
      properties: { meeting_id: meetingId, texts: { type: "array", items: { type: "string" } } },
      required: ["meeting_id", "texts"],
    },
  },
  {
    name: "meeting.delete",
    description: "Erase the meeting's transcript upstream and in quorum. Returns {deleted:true}.",
    inputSchema: {
      type: "object",
      properties: { meeting_id: meetingId },
      required: ["meeting_id"],
    },
  },
] as const;

export type ToolName = (typeof TOOLS)[number]["name"];

export function callTool(q: Quorum, name: string, args: unknown): Promise<ToolResult> {
  switch (name) {
    case "meeting.join":
      return q.join(args);
    case "meeting.leave":
      return q.leave(args);
    case "meeting.status":
      return q.status(args);
    case "transcript.read":
      return q.readTranscript(args);
    case "chat.post":
      return q.chatPost(args);
    case "say":
      return q.say(args);
    case "say.tone":
      return q.sayTone(args);
    case "say.prewarm":
      return q.sayPrewarm(args);
    case "meeting.delete":
      return q.delete(args);
    default:
      return Promise.resolve(failure("invalid_argument", `unknown tool ${name}`));
  }
}

const TOOL_NAMES: ReadonlySet<string> = new Set(TOOLS.map((t) => t.name));

/**
 * One log line per tool call: tool, outcome, error code and duration. The tool name comes from
 * the client, so anything outside the contract list is logged as "unknown" to keep the value
 * set bounded. Arguments and results are never logged.
 */
export function logToolCall(
  log: Logger,
  name: string,
  result: ToolResult,
  durationMs: number,
): void {
  const fields = {
    tool: TOOL_NAMES.has(name) ? name : "unknown",
    ok: result.ok,
    ...(result.ok ? {} : { error_code: result.error.code }),
    duration_ms: Math.round(durationMs),
  };
  if (result.ok) {
    log.info("tool call", fields);
  } else {
    log.warn("tool call failed", fields);
  }
}

export function createMcpServer(q: Quorum, log: Logger = silentLogger): Server {
  const server = new Server({ name: "quorum", version: VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS.map((t) => ({ ...t })) }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const started = performance.now();
    const result = await callTool(q, req.params.name, req.params.arguments);
    logToolCall(log, req.params.name, result, performance.now() - started);
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result as unknown as Record<string, unknown>,
      isError: !result.ok,
    };
  });
  return server;
}
