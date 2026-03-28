import { OpenAICompatibleProvider } from './openai-compatible.provider';

const OPENAI_BASE = 'https://api.openai.com/v1';

export function createOpenAIProvider(apiKey: string, defaultModel: string): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    providerId: 'openai',
    apiKey,
    baseUrl: OPENAI_BASE,
    defaultModel,
  });
}
