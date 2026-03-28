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

function optionalKey(name: string): string {
  return process.env[name]?.trim() ?? '';
}

function optionalInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const env = {
  /** Primary backend: gemini | groq | openai */
  llmProvider: optionalEnv('LLM_PROVIDER', 'gemini'),
  /** When true (default), try other providers in order if the current one fails. */
  llmFallbackEnabled: optionalEnv('LLM_FALLBACK', 'true').toLowerCase() !== 'false',

  geminiApiKey: optionalKey('GEMINI_API_KEY'),
  groqApiKey: optionalKey('GROQ_API_KEY'),
  openaiApiKey: optionalKey('OPENAI_API_KEY'),

  geminiModel: optionalEnv('GEMINI_MODEL', 'gemini-1.5-flash'),
  groqModel: optionalEnv('GROQ_MODEL', 'llama-3.3-70b-versatile'),
  openaiModel: optionalEnv('OPENAI_MODEL', 'gpt-4o-mini'),

  notionApiKey: requireEnv('NOTION_API_KEY'),
  notionDatabaseId: requireEnv('NOTION_DATABASE_ID'),
  discordBotToken: requireEnv('DISCORD_BOT_TOKEN'),
  /** Tavily API key */
  searchApiKey: requireEnv('SEARCH_API_KEY'),

  agentPrefix: optionalEnv('AGENT_PREFIX', ''),
  memoryPath: resolve(process.cwd(), optionalEnv('AGENT_MEMORY_PATH', 'data/memory.json')),
  rateLimitWindowMs: optionalInt('RATE_LIMIT_WINDOW_MS', 60_000),
  rateLimitMaxRequests: optionalInt('RATE_LIMIT_MAX_REQUESTS', 12),
} as const;
