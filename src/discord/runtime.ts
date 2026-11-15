import type { DiscordRuntime, OpusDecoderLike } from "./types.js";
import { DISCORD_CHANNELS, DISCORD_SAMPLE_RATE } from "./audio.js";

/**
 * Loads the real discord.js, @discordjs/voice and opusscript. Loaded lazily so a quorum without
 * QUORUM_DISCORD_TOKEN_FILE never initialises them, and so a missing native DAVE module
 * (@snazzah/davey) disables Discord instead of crashing the process.
 *
 * Opus is decoded with opusscript in its pure-JavaScript (asm.js) build, so the bundled
 * quorum.mjs needs no native or .wasm file for audio on amd64 or arm64.
 */
export async function loadDiscordRuntime(): Promise<DiscordRuntime> {
  const [discord, voice, opus] = await Promise.all([
    import("discord.js"),
    import("@discordjs/voice"),
    import("opusscript"),
  ]);
  const OpusScript = opus.default;
  const { Client, GatewayIntentBits } = discord;
  return {
    createClient: () =>
      new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
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
    },
    createDecoder: (): OpusDecoderLike => {
      const dec = new OpusScript(
        DISCORD_SAMPLE_RATE,
        DISCORD_CHANNELS,
        OpusScript.Application.VOIP,
        {
          wasm: false,
        },
      );
      return { decode: (p) => dec.decode(p), delete: () => dec.delete() };
    },
  };
}
