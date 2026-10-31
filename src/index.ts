import { Client, Events, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from "discord.js";
import { addMessage, startChatPage } from "./chat-page";
import { currentVoiceChannelId, joinVoice, leaveVoice, listVoiceChannels } from "./voice";

const { DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID } = process.env;

if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID || !DISCORD_GUILD_ID) {
  throw new Error("A setting is missing in .env. See .env.example for the list.");
}

// One simple command, just to prove the bot can hear us and answer.
const commands = [new SlashCommandBuilder().setName("ping").setDescription("Check that the bot is awake")];

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
    joinVoice: (channelId) => joinVoice(guild, channelId),
    leaveVoice: () => leaveVoice(guild),
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

client.on(Events.MessageCreate, addMessage);

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isChatInputCommand() && interaction.commandName === "ping") {
    await interaction.reply("Pong! I'm awake.");
  }
});

await client.login(DISCORD_TOKEN);
