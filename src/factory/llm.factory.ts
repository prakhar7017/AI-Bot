import { env } from '../config/env';
import { GeminiProvider } from '../providers/gemini.provider';
import { createGroqProvider } from '../providers/groq.provider';
import { createOpenAIProvider } from '../providers/openai.provider';
import type { LLMProvider, LLMSendOptions, LlmProviderId } from '../types/llm.types';
import type { ChatMessage, ToolDefinition } from '../types/tool.types';

const FALLBACK_ORDER: LlmProviderId[] = ['gemini', 'groq', 'openai'];

export function parseLlmProvider(raw: string): LlmProviderId {
  const v = raw.trim().toLowerCase();
  if (v === 'gemini' || v === 'groq' || v === 'openai') return v;
  throw new Error(`Invalid LLM_PROVIDER "${raw}". Use gemini, groq, or openai.`);
}

/** Heuristic for logging (quota / network issues are common fallback reasons). */
export function isLikelyTransientLlmError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (/429|rate limit|quota|RESOURCE_EXHAUSTED|too many requests/i.test(msg)) return true;
  if (/503|502|504|timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|ECONNREFUSED|network|Server error/i.test(msg))
    return true;
  return false;
}

function createConcreteProvider(id: LlmProviderId): LLMProvider | null {
  switch (id) {
    case 'gemini': {
      const key = env.geminiApiKey;
      if (!key) return null;
      return new GeminiProvider(key, env.geminiModel);
    }
    case 'groq': {
      const key = env.groqApiKey;
      if (!key) return null;
      return createGroqProvider(key, env.groqModel);
    }
    case 'openai': {
      const key = env.openaiApiKey;
      if (!key) return null;
      return createOpenAIProvider(key, env.openaiModel);
    }
    default:
      return null;
  }
}

/** Ordered list: primary first, then remaining providers from the standard fallback order (with API keys). */
function buildFallbackChain(primary: LlmProviderId): LLMProvider[] {
  const chain: LLMProvider[] = [];
  const seen = new Set<LlmProviderId>();

  const push = (id: LlmProviderId) => {
    if (seen.has(id)) return;
    const p = createConcreteProvider(id);
    if (p) {
      chain.push(p);
      seen.add(id);
    }
  };

  push(primary);
  for (const id of FALLBACK_ORDER) {
    push(id);
  }

  return chain;
}

class FallbackLLMProvider implements LLMProvider {
  readonly id: LlmProviderId;

  constructor(
    primaryId: LlmProviderId,
    private readonly chain: LLMProvider[]
  ) {
    this.id = primaryId;
  }

  getChainIds(): string[] {
    return this.chain.map((p) => p.id);
  }

  async sendMessage(
    messages: ChatMessage[],
    tools: ToolDefinition[] | undefined,
    options?: LLMSendOptions
  ) {
    let lastErr: Error | null = null;
    for (let i = 0; i < this.chain.length; i++) {
      const p = this.chain[i];
      try {
        const response = await p.sendMessage(messages, tools, options);
        if (i > 0) {
          console.warn(`[llm] Fallback succeeded with provider "${p.id}" after ${i} failure(s).`);
        }
        return response;
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        lastErr = err;
        const transient = isLikelyTransientLlmError(err);
        console.error(`[llm] Provider "${p.id}" failed${transient ? ' (transient-like)' : ''}:`, err.message);
        if (i < this.chain.length - 1) {
          console.warn(`[llm] Trying fallback provider: ${this.chain[i + 1]!.id}`);
          continue;
        }
      }
    }
    throw lastErr ?? new Error('All LLM providers failed');
  }
}

let singleton: LLMProvider | null = null;

function buildLlmProvider(): LLMProvider {
  const primary = parseLlmProvider(env.llmProvider);

  if (env.llmFallbackEnabled) {
    const chain = buildFallbackChain(primary);
    if (chain.length === 0) {
      throw new Error(
        'No LLM providers available. Set GEMINI_API_KEY, GROQ_API_KEY, and/or OPENAI_API_KEY for your chosen LLM_PROVIDER and fallbacks.'
      );
    }
    const fb = new FallbackLLMProvider(primary, chain);
    console.log(`[llm] Active primary: ${primary}; fallback chain: ${fb.getChainIds().join(' → ')}`);
    return fb;
  }

  const single = createConcreteProvider(primary);
  if (!single) {
    const keyName =
      primary === 'gemini' ? 'GEMINI_API_KEY' : primary === 'groq' ? 'GROQ_API_KEY' : 'OPENAI_API_KEY';
    throw new Error(`LLM_PROVIDER is "${primary}" but ${keyName} is missing.`);
  }
  console.log(`[llm] Active provider: ${primary} (fallback disabled)`);
  return single;
}

/**
 * Shared LLM instance (factory + optional fallback). Swap via `LLM_PROVIDER` / keys in env.
 */
export function getLLMProvider(): LLMProvider {
  if (!singleton) {
    singleton = buildLlmProvider();
  }
  return singleton;
}

/** For unit tests or hot-reload experiments. */
export function resetLLMProviderCache(): void {
  singleton = null;
}
