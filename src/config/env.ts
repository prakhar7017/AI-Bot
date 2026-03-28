import { config as loadEnv } from 'dotenv';
import { resolve } from 'path';

loadEnv();

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

function optionalEnv(name: string, fallback: string): string {
  const v = process.env[name]?.trim();
  return v && v.length > 0 ? v : fallback;
}

function optionalInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const env = {
  geminiApiKey: requireEnv('GEMINI_API_KEY'),
  /** Gemini model id (see Google AI Studio / Vertex). */
  geminiModel: optionalEnv('GEMINI_MODEL', 'gemini-1.5-flash'),
  notionApiKey: requireEnv('NOTION_API_KEY'),
  notionDatabaseId: requireEnv('NOTION_DATABASE_ID'),
  discordBotToken: requireEnv('DISCORD_BOT_TOKEN'),
  /** Tavily API key */
  searchApiKey: requireEnv('SEARCH_API_KEY'),

  /** If set, only messages starting with this prefix trigger the agent (empty = any non-empty message when not a bot). */
  agentPrefix: optionalEnv('AGENT_PREFIX', ''),
  memoryPath: resolve(process.cwd(), optionalEnv('AGENT_MEMORY_PATH', 'data/memory.json')),
  rateLimitWindowMs: optionalInt('RATE_LIMIT_WINDOW_MS', 60_000),
  rateLimitMaxRequests: optionalInt('RATE_LIMIT_MAX_REQUESTS', 12),
} as const;
