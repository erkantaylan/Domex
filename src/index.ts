import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { runMigrations } from "./db";
import { captureLogs } from "./logs";
import { closeLeftoverGames, handleGuess, isGameRunning, startGame, stopGame } from "./game";
import { addMessage, startChatPage } from "./chat-page";
import { currentVoiceChannelId, joinVoice, leaveVoice, listVoiceChannels, playFile, playRandomClip, stopAudio } from "./voice";

captureLogs();

const { DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID } = process.env;

if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID || !DISCORD_GUILD_ID) {
  throw new Error("A setting is missing in .env. See .env.example for the list.");
}

// One simple command, just to prove the bot can hear us and answer.
const commands = [
  new SlashCommandBuilder().setName("ping").setDescription("Check that the bot is awake"),
  new SlashCommandBuilder()
    .setName("game")
    .setDescription("Play Language Jungle")
    .addSubcommand((sub) => sub.setName("start").setDescription("Start a game in your voice channel"))
    .addSubcommand((sub) => sub.setName("stop").setDescription("Stop the current game")),
];

await runMigrations();
await closeLeftoverGames();

// Register on the test server only, so the command appears right away.
const rest = new REST().setToken(DISCORD_TOKEN);
await rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID), {
  body: commands.map((command) => command.toJSON()),
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

client.once(Events.ClientReady, async (ready) => {
  console.log(`Online as ${ready.user.tag}`);
  const guild = await ready.guilds.fetch(DISCORD_GUILD_ID);

  startChatPage(3100, {
    // Only the channels where the bot is allowed to write.
    async listChannels() {
      const me = guild.members.me ?? (await guild.members.fetchMe());
      return [...guild.channels.cache.values()]
        .filter(
          (channel) =>
            channel.isTextBased() && !channel.isThread() && channel.permissionsFor(me).has(["ViewChannel", "SendMessages"]),
        )
        .map((channel) => ({ id: channel.id, name: channel.name }));
    },
    async send(channelId, text) {
      const channel = await guild.channels.fetch(channelId);
      if (!channel?.isTextBased()) throw new Error("Not a text channel");
      // No pings: text like @everyone stays plain text.
      await channel.send({ content: text, allowedMentions: { parse: [] } });
    },
    listVoiceChannels: () => listVoiceChannels(guild),
    currentVoiceChannelId: () => currentVoiceChannelId(guild),
    // The page's voice buttons do nothing during a game, so they can't break it.
    joinVoice: async (channelId) => {
      if (isGameRunning(guild.id)) throw new Error("A game is running");
      await joinVoice(guild, channelId);
    },
    leaveVoice: () => {
      if (!isGameRunning(guild.id)) leaveVoice(guild);
    },
    playClip: async () => {
      if (isGameRunning(guild.id)) throw new Error("A game is running");
      await playRandomClip(guild);
    },
  });

  // Fill the page with recent messages from each channel the bot can read.
  const channels = await guild.channels.fetch();
  let skipped = 0;
  for (const channel of channels.values()) {
    if (!channel?.isTextBased()) continue;
    try {
      const recent = await channel.messages.fetch({ limit: 50 });
      recent.forEach(addMessage);
    } catch {
      skipped++;
    }
  }
  console.log(`History loaded. Channels skipped: ${skipped}`);
});

client.on(Events.MessageCreate, (message) => {
  addMessage(message);
  if (!message.guildId || message.author.bot) return;
  const react = (emoji: string) => message.react(emoji);
  handleGuess(message.guildId, message.channelId, message.author.id, message.content, react).catch((error) =>
    console.error("Couldn't handle a guess:", error),
  );
});

async function handleGameCommand(interaction: ChatInputCommandInteraction<"cached">) {
  const { guild } = interaction;

  if (interaction.options.getSubcommand() === "stop") {
    const stopped = stopGame(guild.id);
    await interaction.reply({
      content: stopped ? "Stopping the game." : "No game is running.",
      flags: stopped ? undefined : MessageFlags.Ephemeral,
    });
    return;
  }

  const channel = interaction.member.voice.channel;
  const problem = !channel
    ? "Join a voice channel first, then try again."
    : channel.type !== ChannelType.GuildVoice
      ? "Games only work in a normal voice channel."
      : !channel.permissionsFor(guild.members.me!).has(["ViewChannel", "Connect", "Speak", "SendMessages"])
        ? "I don't have permission to play and chat in that channel."
        : isGameRunning(guild.id)
          ? "A game is already running."
          : null;
  if (problem || !channel || channel.type !== ChannelType.GuildVoice) {
    await interaction.reply({ content: problem ?? "Something went wrong.", flags: MessageFlags.Ephemeral });
    return;
  }

  // Joining voice can take longer than Discord's 3 seconds to answer a command.
  await interaction.deferReply();
  try {
    await startGame({
      guildId: guild.id,
      channelId: channel.id,
      startedBy: interaction.user.id,
      say: (content) => channel.send({ content, allowedMentions: { parse: [] } }),
      join: () => joinVoice(guild, channel.id),
      play: (filePath) => playFile(guild, filePath),
      stopAudio,
      leave: () => leaveVoice(guild),
    });
    await interaction.editReply(`Game on! Listen in <#${channel.id}> and type your answers in its chat.`);
  } catch (error) {
    console.error("Couldn't start a game:", error);
    await interaction.editReply("I couldn't start the game.");
  }
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isChatInputCommand() && interaction.commandName === "ping") {
    await interaction.reply("Pong! I'm awake.");
  }
  if (interaction.isChatInputCommand() && interaction.commandName === "game" && interaction.inCachedGuild()) {
    await handleGameCommand(interaction).catch((error) => console.error("Game command failed:", error));
  }
});

await client.login(DISCORD_TOKEN);
