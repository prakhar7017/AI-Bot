import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message,
} from 'discord.js';
import { env } from '../config/env';
import { runAgent } from '../agent/agent';
import { createNotionClient } from '../services/notion.service';
import type { NotionToolsContext } from '../tools/notion.tools';
import { createRateLimiter } from '../services/rate-limit.service';

const limiter = createRateLimiter(env.rateLimitWindowMs, env.rateLimitMaxRequests);

/** Narrow to channels that support send/sendTyping (avoids PartialGroupDMChannel typing gaps). */
type SendableChannel = {
  sendTyping(): Promise<unknown>;
  send(content: string): Promise<unknown>;
};

function asSendableChannel(ch: Message['channel']): SendableChannel | null {
  if (!ch.isTextBased()) return null;
  const anyCh = ch as unknown as { sendTyping?: unknown; send?: unknown };
  if (typeof anyCh.sendTyping === 'function' && typeof anyCh.send === 'function') {
    return ch as unknown as SendableChannel;
  }
  return null;
}

function stripPrefix(content: string): string | null {
  const prefix = env.agentPrefix;
  const trimmed = content.trim();
  if (!prefix) {
    return trimmed.length > 0 ? trimmed : null;
  }
  if (!trimmed.startsWith(prefix)) {
    return null;
  }
  const rest = trimmed.slice(prefix.length).trim();
  return rest.length > 0 ? rest : null;
}

export async function startDiscordBot(): Promise<void> {
  const notion = createNotionClient(env.notionApiKey);
  const notionCtx: NotionToolsContext = {
    notion,
    databaseId: env.notionDatabaseId,
  };

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.Message],
  });

  client.once(Events.ClientReady, (c) => {
    console.log(`[discord] Logged in as ${c.user?.tag}`);
  });

  client.on(Events.MessageCreate, async (message: Message) => {
    try {
      if (message.author.bot) return;

      const text = stripPrefix(message.content);
      if (text == null) return;

      const userKey = message.author.id;
      console.log('[discord] Incoming', { user: userKey, channel: message.channelId, preview: text.slice(0, 120) });

      if (!limiter.allow(userKey)) {
        await message.reply('You are sending too many messages. Please wait a bit and try again.');
        return;
      }

      const sendable = asSendableChannel(message.channel);
      if (sendable) {
        await sendable.sendTyping();
      }

      const reply = await runAgent(userKey, text, {
        notionCtx,
        searchApiKey: env.searchApiKey,
        memoryPath: env.memoryPath,
      });

      const chunkSize = 1900;
      if (reply.length <= chunkSize) {
        await message.reply(reply);
      } else {
        for (let i = 0; i < reply.length; i += chunkSize) {
          const part = reply.slice(i, i + chunkSize);
          if (i === 0) await message.reply(part);
          else if (sendable) await sendable.send(part);
          else await message.reply(part);
        }
      }

      console.log('[discord] Responded', { user: userKey, len: reply.length });
    } catch (e) {
      console.error('[discord] Handler error:', e);
      try {
        await message.reply('Something went wrong handling your message.');
      } catch {
        /* ignore */
      }
    }
  });

  await client.login(env.discordBotToken);
}
