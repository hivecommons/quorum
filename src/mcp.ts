import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { failure, type ToolResult } from "./errors.js";
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
    description: "Speak text aloud in the meeting. Returns {queued:true}.",
    inputSchema: {
      type: "object",
      properties: { meeting_id: meetingId, text: { type: "string" } },
      required: ["meeting_id", "text"],
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
    case "meeting.delete":
      return q.delete(args);
    default:
      return Promise.resolve(failure("invalid_argument", `unknown tool ${name}`));
  }
}

export function createMcpServer(q: Quorum): Server {
  const server = new Server({ name: "quorum", version: VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS.map((t) => ({ ...t })) }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const result = await callTool(q, req.params.name, req.params.arguments);
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result as unknown as Record<string, unknown>,
      isError: !result.ok,
    };
  });
  return server;
}
