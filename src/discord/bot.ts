import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type GuildMember,
  type Message,
} from 'discord.js';
import { env } from '../config/env';
import { runAgent } from '../agent/agent';
import { createNotionClient } from '../services/notion.service';
import { addMessage } from '../services/memory.service';
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

function authorDisplayName(message: Message): string {
  const u = message.author;
  const memberNick = message.member?.displayName;
  if (memberNick) return memberNick;
  if (u.globalName) return u.globalName;
  return u.username;
}

/**
 * Text stored in channel memory (mention stripped in servers for readability; DM prefix stripped when configured).
 */
function messageBodyForMemory(message: Message, botUserId: string): string {
  const trimmed = message.content.trim();
  const inGuildOrGroup =
    Boolean(message.guild) || message.channel.type === ChannelType.GroupDM;
  if (inGuildOrGroup) {
    const withoutMention = trimmed
      .replace(new RegExp(`<@!?${botUserId}>\\s*`, 'g'), '')
      .trim();
    return withoutMention || trimmed;
  }
  if (env.agentPrefix && trimmed.startsWith(env.agentPrefix)) {
    return trimmed.slice(env.agentPrefix.length).trim();
  }
  return trimmed;
}

/** Whether this human message is written into rolling memory (context for later pings). */
function shouldRecordInMemory(message: Message): boolean {
  const trimmed = message.content?.trim() ?? '';
  if (!trimmed) return false;
  if (message.guild) return true;
  if (message.channel.type === ChannelType.GroupDM) return true;
  if (env.agentPrefix) {
    if (!trimmed.startsWith(env.agentPrefix)) return false;
    return trimmed.slice(env.agentPrefix.length).trim().length > 0;
  }
  return true;
}

/** Whether to run the agent and reply in this channel (mention in servers / group DMs; DM rules unchanged). */
function messageInvokesAgent(message: Message, botUserId: string): boolean {
  if (!shouldRecordInMemory(message)) return false;
  if (message.guild) return message.mentions.users.has(botUserId);
  if (message.channel.type === ChannelType.GroupDM) return message.mentions.users.has(botUserId);
  return true;
}

async function resolveGuildMember(message: Message): Promise<GuildMember | null> {
  if (!message.guild) return null;
  if (message.member) return message.member;
  try {
    return await message.guild.members.fetch(message.author.id);
  } catch {
    return null;
  }
}

/**
 * When DISCORD_AGENT_ROLE_IDS is set, guild members must have one of those roles to get replies / Notion tools.
 * DMs and group DMs are not role-checked (no guild roles).
 */
async function memberHasAgentRole(message: Message): Promise<boolean> {
  const ids = env.discordAgentRoleIds;
  if (!ids.length) return true;
  if (!message.guild) return true;
  const m = await resolveGuildMember(message);
  if (!m) return false;
  return ids.some((id) => m.roles.cache.has(id));
}

export async function startDiscordBot(): Promise<void> {
  const notion = createNotionClient(env.notionApiKey);
  const notionCtx: NotionToolsContext = {
    notion,
    databaseId: env.notionDatabaseId,
  };

  const memoryPath = env.memoryPath;

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

      const botUserId = message.client.user?.id;
      if (!botUserId) return;

      if (!shouldRecordInMemory(message)) return;

      const channelId = message.channelId;
      const userKey = message.author.id;
      const userLabel = authorDisplayName(message);
      const body = messageBodyForMemory(message, botUserId);
      if (!body) return;

      const now = new Date().toISOString();
      await addMessage(memoryPath, channelId, {
        userId: userKey,
        userLabel,
        role: 'user',
        content: body,
        timestamp: now,
      });

      if (!messageInvokesAgent(message, botUserId)) return;

      if (!(await memberHasAgentRole(message))) {
        await message.reply(
          'You need a permitted server role to use this bot (replies and Notion actions). Ask an admin if you think this is wrong.',
        );
        return;
      }

      console.log('[discord] Incoming', {
        user: userKey,
        name: userLabel,
        channel: channelId,
        preview: body.slice(0, 120),
      });

      if (!limiter.allow(userKey)) {
        await message.reply('You are sending too many messages. Please wait a bit and try again.');
        return;
      }

      const sendable = asSendableChannel(message.channel);
      if (sendable) {
        await sendable.sendTyping();
      }

      const botLabel =
        message.client.user?.globalName ?? message.client.user?.username ?? 'assistant';
      let reply: string;
      try {
        reply = await runAgent(channelId, userKey, body, {
          notionCtx,
          searchApiKey: env.searchApiKey,
          memoryPath,
        });
      } catch (err) {
        console.error('[discord] runAgent error:', err);
        reply = 'Something went wrong running the assistant.';
      }

      await addMessage(memoryPath, channelId, {
        userId: botUserId,
        userLabel: botLabel,
        role: 'assistant',
        content: reply,
        timestamp: new Date().toISOString(),
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
