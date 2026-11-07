import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type VoiceChannel } from "discord.js";
import type { EasyRoundView } from "./game";

// Discord allows button labels up to 80 characters, and language names can be longer.
const MAX_LABEL = 80;

// The button only carries the round and the option's place, never the name: names can be long.
function buttonId(roundId: number, index: number) {
  return `easy:${roundId}:${index}`;
}

export function parseEasyButtonId(customId: string) {
  const match = /^easy:(\d+):(\d+)$/.exec(customId);
  return match ? { roundId: Number(match[1]), index: Number(match[2]) } : null;
}

function label(name: string) {
  return name.length > MAX_LABEL ? `${name.slice(0, MAX_LABEL - 1)}…` : name;
}

// One row of 5 buttons. Once the right answer is known, they switch off and the right one turns green.
function buttonRow(roundId: number, options: string[], rightIndex?: number) {
  const over = rightIndex !== undefined;
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    options.map((name, index) =>
      new ButtonBuilder()
        .setCustomId(buttonId(roundId, index))
        .setLabel(label(name))
        .setStyle(!over ? ButtonStyle.Primary : index === rightIndex ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setDisabled(over),
    ),
  );
}

// Posts an easy round's buttons in the game's channel, and hands back what the game can do with the message.
export async function postEasyRound(
  channel: VoiceChannel,
  roundId: number,
  options: string[],
  total: number,
): Promise<EasyRoundView> {
  const message = await channel.send({
    content: `Pick the language! 0/${total} picked`,
    components: [buttonRow(roundId, options)],
    allowedMentions: { parse: [] },
  });
  let picked = 0;
  return {
    showPicked: (count, of) => {
      picked = count;
      return message.edit({ content: `Pick the language! ${count}/${of} picked` });
    },
    close: (rightIndex) =>
      message.edit({ content: `Round over: ${picked}/${total} picked.`, components: [buttonRow(roundId, options, rightIndex)] }),
  };
}
