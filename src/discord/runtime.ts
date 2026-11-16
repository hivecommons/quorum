import type { DiscordRuntime, OpusDecoderLike, OpusEncoderLike } from "./types.js";
import { DISCORD_CHANNELS, DISCORD_SAMPLE_RATE } from "./audio.js";

/**
 * Loads the real discord.js, @discordjs/voice and opusscript. Loaded lazily so a quorum without
 * QUORUM_DISCORD_TOKEN_FILE never initialises them, and so a missing native DAVE module
 * (@snazzah/davey) disables Discord instead of crashing the process.
 *
 * Opus is decoded and encoded with opusscript in its pure-JavaScript (asm.js) build, so the
 * bundled quorum.mjs needs no native or .wasm file for audio on amd64 or arm64. Speech is handed to
 * @discordjs/voice as ready Opus packets (StreamType.Opus) rather than raw PCM: a raw resource
 * would make prism-media require() an Opus module at runtime, and its opusscript path loads the
 * .wasm build, which the single-file bundle does not carry.
 */
export async function loadDiscordRuntime(): Promise<DiscordRuntime> {
  const [discord, voice, opus] = await Promise.all([
    import("discord.js"),
    import("@discordjs/voice"),
    import("opusscript"),
  ]);
  const OpusScript = opus.default;
  const { Client, GatewayIntentBits } = discord;
  const opusOptions = { wasm: false };
  return {
    createClient: ({ messageContent }) =>
      new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildVoiceStates,
          GatewayIntentBits.GuildMessages,
          ...(messageContent ? [GatewayIntentBits.MessageContent] : []),
        ],
      }) as unknown as ReturnType<DiscordRuntime["createClient"]>,
    voice: {
      joinVoiceChannel: (opts) =>
        voice.joinVoiceChannel(
          opts as Parameters<typeof voice.joinVoiceChannel>[0],
        ) as unknown as ReturnType<DiscordRuntime["voice"]["joinVoiceChannel"]>,
      entersState: (target, status, timeoutMs) =>
        voice.entersState(
          target as unknown as Parameters<typeof voice.entersState>[0],
          status as Parameters<typeof voice.entersState>[1],
          timeoutMs,
        ),
      Status: voice.VoiceConnectionStatus,
      AfterSilence: voice.EndBehaviorType.AfterSilence,
      createAudioPlayer: () =>
        voice.createAudioPlayer() as unknown as ReturnType<
          DiscordRuntime["voice"]["createAudioPlayer"]
        >,
      createOpusResource: (stream) =>
        voice.createAudioResource(stream, { inputType: voice.StreamType.Opus }),
      PlayerIdle: voice.AudioPlayerStatus.Idle,
    },
    createDecoder: (): OpusDecoderLike => {
      const dec = new OpusScript(
        DISCORD_SAMPLE_RATE,
        DISCORD_CHANNELS,
        OpusScript.Application.VOIP,
        opusOptions,
      );
      return { decode: (p) => dec.decode(p), delete: () => dec.delete() };
    },
    createEncoder: (): OpusEncoderLike => {
      const enc = new OpusScript(
        DISCORD_SAMPLE_RATE,
        DISCORD_CHANNELS,
        OpusScript.Application.AUDIO,
        opusOptions,
      );
      return { encode: (p, frameSize) => enc.encode(p, frameSize), delete: () => enc.delete() };
    },
  };
}
