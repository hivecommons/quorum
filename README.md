# Quorum

Quorum lets AI agents take part in live meetings. It joins Microsoft Teams, Google Meet, Zoom and Discord as a participant, streams a per-speaker transcript, and exposes the meeting to agents as Model Context Protocol (MCP) tools: join and leave, read the transcript, post in the meeting chat, speak, and erase the transcript.

Quorum is part of [Hive Commons](https://github.com/hivecommons). Its first consumer is [Hive](https://github.com/hivecommons/hive), where Spektacular asks clarifying questions during the meeting and hive agents research topics in the background, posting results back while the conversation continues.

The interface hive, quorum and spektacular build against is [docs/contract.md](docs/contract.md) (`quorum.contract/v1`).

## How hive runs it

Quorum is a child process inside the hive container, like the `spektacular` binary. It listens on loopback only; no extra container or pod change is needed.

1. Hive writes a fresh random bearer token to a file at boot, and the tenant's Vexa API key (and, if used, the Discord bot token) from its keystore to files.
2. Hive starts `node quorum.mjs serve` with the `QUORUM_*` variables below and supervises it. `GET /healthz` answers `{"ok":true,...}` once it is listening.
3. Hive is the MCP client: `POST http://127.0.0.1:8765/mcp` with `Authorization: Bearer <token>` (streamable HTTP, stateless, JSON responses). Tools: `meeting.join`, `meeting.leave`, `meeting.status`, `transcript.read`, `chat.post`, `say`, `meeting.delete`. Every result is `{ok:true,...}` or `{ok:false,error:{code,message}}` in `structuredContent` and as JSON text.
4. Hive follows each meeting on `GET /events?meeting_id=<id>` (Server-Sent Events, same bearer): `segment`, `chat` and `state` events, one JSON object per `data:` line, `id:` = `seq`. Reconnect with `after_seq=<last seq>` to replay what was missed. `GET /events` without `meeting_id` carries every meeting, including Discord `/hive join` requests.
5. On SIGTERM quorum leaves Discord channels and exits. Vexa bots keep running until hive calls `meeting.leave`; a restarted quorum that is asked to join the same meeting adopts the running bot.

Meet, Teams and Zoom go through a shared [Vexa](https://github.com/Vexa-ai/vexa) deployment (hivecommons/vexa). Discord goes directly from quorum to Discord voice, with audio transcribed by the shared Whisper service.

## Configuration

Secrets are only ever read from files, on use, so hive can rotate them without a restart; their values are redacted from every log line.

| Variable                            | Default                                                                               | Meaning                                                                                                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `QUORUM_LISTEN`                     | `127.0.0.1:8765`                                                                      | `host:port` to listen on. Keep it on loopback.                                                                                                                      |
| `QUORUM_TOKEN_FILE`                 | required                                                                              | File holding the bearer token for `/mcp` and `/events`.                                                                                                             |
| `QUORUM_VEXA_URL`                   | unset                                                                                 | Vexa gateway base URL. Unset: Meet, Teams and Zoom answer `platform_unavailable`.                                                                                   |
| `QUORUM_VEXA_API_KEY_FILE`          | unset                                                                                 | File holding the tenant Vexa API key (scopes `bot`, `tx`), sent as `X-API-Key`.                                                                                     |
| `QUORUM_VEXA_VOICE`                 | `false`                                                                               | Default for `meeting.join` `voice`: start Vexa bots able to speak.                                                                                                  |
| `QUORUM_VEXA_TIMEOUT_MS`            | `15000`                                                                               | Timeout for each Vexa REST call.                                                                                                                                    |
| `QUORUM_VEXA_WS_BACKOFF_MIN_MS`     | `1000`                                                                                | First reconnect delay for the Vexa `/ws` feed.                                                                                                                      |
| `QUORUM_VEXA_WS_BACKOFF_MAX_MS`     | `30000`                                                                               | Reconnect delay cap (exponential, jittered).                                                                                                                        |
| `QUORUM_LOBBY_TIMEOUT_S`            | `600`                                                                                 | How long a bot waits in a lobby before the meeting fails with `lobby_timeout`.                                                                                      |
| `QUORUM_ECHO_WINDOW_S`              | `120`                                                                                 | How long the bot's own chat lines are recognised and dropped when Vexa reads them back.                                                                             |
| `QUORUM_DISCORD_TOKEN_FILE`         | unset                                                                                 | File holding the Discord bot token. Unset: Discord answers `platform_unavailable`.                                                                                  |
| `QUORUM_DISCORD_COMMANDS`           | `guild`                                                                               | Register `/hive` per guild (instant), `global`, or `off`.                                                                                                           |
| `QUORUM_DISCORD_SILENCE_MS`         | `500`                                                                                 | Silence that ends a Discord utterance.                                                                                                                              |
| `QUORUM_DISCORD_MIN_SEGMENT_MS`     | `300`                                                                                 | Utterances shorter than this are dropped.                                                                                                                           |
| `QUORUM_DISCORD_MAX_SEGMENT_S`      | `30`                                                                                  | Longer speech is cut into segments of this length.                                                                                                                  |
| `QUORUM_DISCORD_JOIN_TIMEOUT_S`     | `20`                                                                                  | How long joining a voice channel may take.                                                                                                                          |
| `QUORUM_DISCORD_REQUEST_TTL_S`      | `300`                                                                                 | How long a `/hive join` request waits for hive's approval.                                                                                                          |
| `QUORUM_TRANSCRIBE_URL`             | unset                                                                                 | Base URL of the Whisper service for Discord audio (`/v1/audio/transcriptions` is appended). Required for Discord.                                                   |
| `QUORUM_TRANSCRIBE_TOKEN_FILE`      | unset                                                                                 | File holding that service's API token, sent as `X-API-Key`.                                                                                                         |
| `QUORUM_TRANSCRIBE_LANGUAGE`        | unset                                                                                 | Force a transcription language (`en`, `de`, ...); unset lets Whisper detect it.                                                                                     |
| `QUORUM_TRANSCRIBE_TIMEOUT_MS`      | `60000`                                                                               | Timeout for each transcription request.                                                                                                                             |
| `QUORUM_TRANSCRIBE_HOTWORDS`        | Betty, leave, pull request, PR, issue, board pressure, hive and the hive's repo names | Vocabulary sent with every transcription request as Whisper prompt and hotwords (comma-separated; replaces the default). The bot's display name is always sent too. |
| `QUORUM_DISCORD_VAD_THRESHOLD`      | `500`                                                                                 | Frame RMS (int16 scale) below which a Discord segment's leading and trailing audio is cut before transcription.                                                     |
| `QUORUM_TRANSCRIBE_MAX_ATTEMPTS`    | `4`                                                                                   | Tries per segment on 429, 5xx or no answer before it is dropped.                                                                                                    |
| `QUORUM_TRANSCRIBE_BACKOFF_BASE_MS` | `250`                                                                                 | First retry backoff; doubles each try, with jitter.                                                                                                                 |
| `QUORUM_TRANSCRIBE_BACKOFF_MAX_MS`  | `4000`                                                                                | Ceiling on one backoff, `Retry-After` included.                                                                                                                     |
| `QUORUM_TTS_URL`                    | unset                                                                                 | Base URL of the Kokoro TTS service for Discord `say` (`/v1/audio/speech` is appended). Unset: Discord `say` answers `platform_unavailable`.                         |
| `QUORUM_TTS_TOKEN_FILE`             | unset                                                                                 | File holding that service's API token, sent as `X-API-Key`.                                                                                                         |
| `QUORUM_TTS_VOICE`                  | `af_heart`                                                                            | Kokoro voice for Discord `say` when `meeting.join` gives no `voice_id`.                                                                                             |
| `QUORUM_COMPANION_MAX_CHUNK_BYTES`  | `131072`                                                                              | Largest companion audio chunk (raw 16 kHz mono s16le PCM).                                                                                                          |
| `QUORUM_COMPANION_SILENCE_MS`       | `500`                                                                                 | Silence that ends a companion utterance.                                                                                                                            |
| `QUORUM_COMPANION_MIN_SPEECH_MS`    | `300`                                                                                 | Companion utterances with less speech than this are dropped.                                                                                                        |
| `QUORUM_COMPANION_MAX_SEGMENT_S`    | `20`                                                                                  | Longer companion speech is cut into segments of this length.                                                                                                        |
| `QUORUM_COMPANION_VAD_THRESHOLD`    | `500`                                                                                 | Frame RMS (int16 scale) that counts as speech.                                                                                                                      |
| `QUORUM_COMPANION_OUTBOX_MAX`       | `200`                                                                                 | Lines kept for the companion window.                                                                                                                                |
| `QUORUM_TTS_TIMEOUT_MS`             | `30000`                                                                               | Timeout for each TTS request.                                                                                                                                       |
| `QUORUM_CHAT_MAX_CHARS`             | `2000`                                                                                | Longest `chat.post` text.                                                                                                                                           |
| `QUORUM_CHAT_CONFIRM_TIMEOUT_MS`    | `30000`                                                                               | How long `chat.post {confirm:true}` waits for Vexa to report the line posted or failed.                                                                             |
| `QUORUM_CHAT_CONFIRM_POLL_MS`       | `500`                                                                                 | Interval between delivery-record reads while it waits.                                                                                                              |
| `QUORUM_SAY_MAX_CHARS`              | `1000`                                                                                | Longest `say` text (Vexa's own limit).                                                                                                                              |
| `QUORUM_SAY_CONFIRM_TIMEOUT_MS`     | `60000`                                                                               | How long a Vexa `say` waits for the bot to report the line spoken before the next line is sent.                                                                     |
| `QUORUM_TRANSCRIPT_BUFFER`          | `2000`                                                                                | Final segments kept per meeting for `transcript.read` and SSE replay.                                                                                               |
| `QUORUM_MEETING_RETENTION_S`        | `3600`                                                                                | How long an ended meeting stays readable before quorum forgets it.                                                                                                  |
| `QUORUM_SSE_HEARTBEAT_S`            | `15`                                                                                  | Interval of `: ping` comments on `/events`.                                                                                                                         |
| `QUORUM_MAX_BODY_BYTES`             | `1048576`                                                                             | Largest `/mcp` request body.                                                                                                                                        |
| `QUORUM_LOG_LEVEL`                  | `info`                                                                                | `debug`, `info`, `warn` or `error`. Logs are JSON lines on stderr.                                                                                                  |

## Platforms

**Google Meet, Teams, Zoom.** `meeting.join {url, display_name, voice?}`. The platform and the native meeting id come from the URL (the same parser Vexa uses: Meet codes and nicknames, Teams `/meet/<id>?p=` short links including government clouds, legacy `meetup-join` links, Zoom `/j/`, `/w/`, `/wc/` links on `zoom.us`, `zoomgov.com` and vanity hosts). The bot joins with recording off. States follow Vexa's bot lifecycle: `requested`, `joining`, `lobby` (awaiting admission), `live`, then `ended`, `failed` (reason `lobby_timeout` when nobody admitted it) or `blocked` (the platform refused a guest bot). `say` needs the bot to have joined with `voice:true` and a Vexa with the speak route (hivecommons/vexa#3); otherwise it answers `platform_unavailable`. A `voice_id` given at join is sent as the `voice` of each speak request.

**Companion.** `meeting.join {platform:"companion", display_name, host_name?}`. No bot joins anything: the desktop companion ([hivecommons/quorum-companion](https://github.com/hivecommons/quorum-companion)) captures a person's own meeting client audio (`call`) and microphone (`mic`) after they accept a consent prompt, and hive relays the PCM to `POST /companion/audio`. Each channel is cut at silence and transcribed by the shared Whisper service (`QUORUM_TRANSCRIBE_URL` is required). `chat.post` lines go to an outbox the companion window reads (`GET /companion/outbox`); `say` answers `platform_unavailable`. See docs/contract.md, "Companion audio".

**Discord.** `meeting.join {platform:"discord", guild_id, channel_id, voice_id?}`. Create a bot in the Discord developer portal, invite it with the `applications.commands` and `bot` scopes and the View Channel, Connect, Speak and Send Messages permissions, and give hive the token. Each speaking user's audio is cut at silence, transcribed, and emitted as a final segment with `speaker.id` = the Discord user id. `chat.post` writes to the voice channel's text chat.

- **Typed chat.** Lines people type in the voice channel's built-in text chat arrive as `chat` events (bots, webhooks and quorum's own posts are skipped). This needs the privileged **Message Content Intent**: in the developer portal open the application, then Bot, then Privileged Gateway Intents, and turn it on. If it is off, Discord refuses the login; quorum logs `the MessageContent intent is not enabled` once, connects again without it, and everything except typed chat keeps working.
- **Speech.** With `QUORUM_TTS_URL` set, the bot joins unmuted and `say` synthesizes the text with Kokoro (`response_format: "pcm"`, 24 kHz mono), upsamples it to 48 kHz stereo, encodes it with the bundled pure-JavaScript Opus encoder and plays it into the channel. Clips play one after another in the order `say` was called. The voice is `voice_id` from `meeting.join`, else `QUORUM_TTS_VOICE`. A TTS failure answers `upstream_error`.

Members can ask for the bot with `/hive join` from a voice channel. Quorum then emits `{"type":"state","state":"requested","platform":"discord","guild_id":...,"channel_id":...,"requested_by":{...}}` on `GET /events`. Hive approves by calling `meeting.join` for that channel (the request's `meeting_id` is kept) or declines with `meeting.leave`. `/hive leave` makes the bot leave at once.

## Release bundle

Each release attaches `quorum.mjs` (one ESM file, Node 22 or later, amd64 and arm64) and `quorum.mjs.sha256`:

```bash
curl -fsSLO https://github.com/hivecommons/quorum/releases/download/v0.2.2/quorum.mjs
curl -fsSLO https://github.com/hivecommons/quorum/releases/download/v0.2.2/quorum.mjs.sha256
sha256sum -c quorum.mjs.sha256
node quorum.mjs version
```

Every pure-JavaScript dependency is inlined. Opus audio is decoded with opusscript's pure-JavaScript build and voice encryption uses Node's built-in AES-GCM, so nothing native is needed for Meet, Teams, Zoom, or Discord audio.

The one native piece is Discord's DAVE end-to-end encryption, `@snazzah/davey`, which `@discordjs/voice` requires and which ships per-platform binaries (linux x64 and arm64, glibc and musl). It cannot live inside a single JavaScript file. To use Discord, install it next to the bundle, at the version `package-lock.json` pins:

```bash
install -d /opt/quorum && cp quorum.mjs /opt/quorum/
npm install --prefix /opt/quorum --no-save @snazzah/davey@0.1.12
```

Without it quorum runs normally and logs `discord disabled`; Discord tools answer `platform_unavailable`. CI smoke-tests the bundle both ways, from a directory with no other `node_modules`, on amd64 and arm64 runners before a release is published.

Cutting a release: bump `version` in `package.json` and `src/version.ts`, merge, then push a tag `v<version>`. `.github/workflows/release.yml` checks that the tag matches, runs lint, typecheck, tests and the build, smoke-tests on both architectures, and creates the GitHub release with both assets.

## Local development

```bash
npm ci
npm test              # vitest, with fakes for Vexa (HTTP and WebSocket), discord.js and Whisper
npm run test:coverage # the same with the 90% lines and branches gate on src/
npm run lint
npm run typecheck
npm run build         # tsc, then dist/quorum.mjs and its checksum
npm run smoke         # runs dist/quorum.mjs from an empty directory
```

To try quorum by hand without Vexa, run the bundled fake gateway. It accepts any bot, walks it through joining, lobby and live, then sends a transcript line every few seconds and a chat line now and then:

```bash
node scripts/dev-fake-vexa.mjs &          # http://127.0.0.1:18056, API key "dev-key"
dir=$(mktemp -d); echo dev-token-0123456789 > "$dir/token"; echo dev-key > "$dir/vexa"
QUORUM_TOKEN_FILE="$dir/token" QUORUM_VEXA_URL=http://127.0.0.1:18056 \
  QUORUM_VEXA_API_KEY_FILE="$dir/vexa" node dist/quorum.mjs serve &

curl -s http://127.0.0.1:8765/mcp \
  -H 'Authorization: Bearer dev-token-0123456789' -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"meeting.join","arguments":{"url":"https://meet.google.com/abc-defg-hij","display_name":"Hive notes"}}}'
# then, with the meeting_id from the answer:
curl -sN 'http://127.0.0.1:8765/events?meeting_id=<meeting_id>' -H 'Authorization: Bearer dev-token-0123456789'
```

## Built on

- [Vexa](https://github.com/Vexa-ai/vexa) (Apache-2.0) joins Teams, Meet and Zoom and produces the transcript. Quorum contributes upstream; hivecommons/vexa carries only what upstream has not released yet.
- [discord.js](https://discord.js.org) and [@discordjs/voice](https://github.com/discordjs/discord.js/tree/main/packages/voice) (Apache-2.0) for Discord, with [@snazzah/davey](https://github.com/Snazzah/davey) (MIT) for DAVE and [opusscript](https://github.com/abalabahaha/opusscript) (MIT) for Opus.
- [joinly](https://github.com/joinly-ai/joinly) (MIT) is the design reference for exposing a meeting as MCP tools.

## Contributing

Contributions are welcome under the Developer Certificate of Origin. Sign off every commit with `git commit -s`; CI checks every commit.

## License

Apache-2.0. See [LICENSE](LICENSE).
