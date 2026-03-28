import { OpenAICompatibleProvider } from './openai-compatible.provider';

const GROQ_BASE = 'https://api.groq.com/openai/v1';

export function createGroqProvider(apiKey: string, defaultModel: string): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    providerId: 'groq',
    apiKey,
    baseUrl: GROQ_BASE,
    defaultModel,
  });
}
