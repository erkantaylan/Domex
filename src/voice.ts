import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  NoSubscriberBehavior,
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
// It keeps going with nobody connected, so a clip always reaches its end and a game can't get stuck.
const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
player.on("error", (error) => console.error("Clip failed:", error.message));

// Plays one file in the channel the bot is in. Resolves when it has finished or been stopped.
export async function playFile(guild: Guild, filePath: string) {
  const connection = getVoiceConnection(guild.id);
  if (connection?.state.status !== VoiceConnectionStatus.Ready) throw new Error("Not in a voice channel");

  connection.subscribe(player);
  player.play(createAudioResource(filePath));
  await entersState(player, AudioPlayerStatus.Playing, 5_000);
  await new Promise<void>((resolve) => player.once(AudioPlayerStatus.Idle, () => resolve()));
}

export function stopAudio() {
  player.stop();
}

// The page's test button: plays a random clip from assets/.
export async function playRandomClip(guild: Guild) {
  const files = (await readdir("assets", { recursive: true })).filter((name) => name.endsWith(".mp3"));
  const clip = files[Math.floor(Math.random() * files.length)];
  if (!clip) throw new Error("No clips in assets/");
  void playFile(guild, join("assets", clip)).catch((error) => console.error("Clip failed:", error));
}
