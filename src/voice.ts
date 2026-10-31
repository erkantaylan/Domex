import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  VoiceConnectionStatus,
} from "@discordjs/voice";
import type { Guild } from "discord.js";

// The voice channels the bot is allowed to see and join.
export async function listVoiceChannels(guild: Guild) {
  // Read the bot's own copy of the list. The page asks every 2 seconds, and
  // asking Discord that often gets the bot rate limited.
  const me = guild.members.me ?? (await guild.members.fetchMe());
  return [...guild.channels.cache.values()]
    .filter((channel) => channel.isVoiceBased() && channel.permissionsFor(me).has(["ViewChannel", "Connect"]))
    .map((channel) => ({ id: channel.id, name: channel.name }));
}

// Which voice channel the bot is in right now, if any.
export function currentVoiceChannelId(guild: Guild) {
  const connection = getVoiceConnection(guild.id);
  if (connection?.state.status !== VoiceConnectionStatus.Ready) return null;
  return connection.joinConfig.channelId;
}

export async function joinVoice(guild: Guild, channelId: string) {
  const connection = joinVoiceChannel({
    channelId,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true,
  });

  // If someone drags the bot out, wait briefly in case it's only moving
  // channels. If it doesn't come back, clean up so the page shows it as out.
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
    }
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  } catch (error) {
    if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
    throw error;
  }
}

export function leaveVoice(guild: Guild) {
  player.stop();
  getVoiceConnection(guild.id)?.destroy();
}

// One player for the bot. It turns a clip into sound the voice channel can hear.
const player = createAudioPlayer();
player.on("error", (error) => console.error("Clip failed:", error.message));
player.on(AudioPlayerStatus.Idle, () => console.log("Clip finished"));

// Plays a random clip from assets/ in the channel the bot is in.
export async function playRandomClip(guild: Guild) {
  const connection = getVoiceConnection(guild.id);
  if (connection?.state.status !== VoiceConnectionStatus.Ready) throw new Error("Not in a voice channel");

  const clips = (await readdir("assets")).filter((name) => name.endsWith(".mp3"));
  const clip = clips[Math.floor(Math.random() * clips.length)];
  if (!clip) throw new Error("No clips in assets/");

  connection.subscribe(player);
  player.play(createAudioResource(join("assets", clip)));
  await entersState(player, AudioPlayerStatus.Playing, 5_000);
  console.log("Clip playing");
}
