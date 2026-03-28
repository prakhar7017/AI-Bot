import axios, { AxiosError } from 'axios';
import type { ChatMessage, ToolDefinition } from '../types/tool.types';
import type { LLMProvider, LLMResponse, LLMSendOptions, LlmProviderId } from '../types/llm.types';

/** OpenAI / Groq chat message shape. */
interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

function chatMessagesToOpenAI(messages: ChatMessage[]): OpenAIChatMessage[] {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return {
        role: 'tool',
        content: m.content ?? '',
        tool_call_id: m.tool_call_id,
        name: m.name,
      };
    }
    if (m.role === 'assistant' && m.tool_calls?.length) {
      return {
        role: 'assistant',
        content: m.content,
        tool_calls: m.tool_calls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments ?? '{}',
          },
        })),
      };
    }
    return {
      role: m.role as 'system' | 'user' | 'assistant',
      content: m.content,
    };
  });
}

function toolsToOpenAI(tools: ToolDefinition[]): unknown[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    },
  }));
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      role?: string;
      content?: string | null;
      tool_calls?: Array<{
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  error?: { message?: string };
}

function parseOpenAICompletion(data: ChatCompletionResponse): LLMResponse {
  const msg = data.choices?.[0]?.message;
  if (!msg) {
    return { type: 'text', content: '' };
  }
  const tcalls = msg.tool_calls?.filter((tc) => tc.function?.name);
  if (tcalls?.length) {
    const calls = tcalls.map((tc) => {
      let args: Record<string, unknown> = {};
      try {
        args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch {
        args = {};
      }
      return { name: tc.function!.name!, arguments: args };
    });
    if (calls.length === 1) {
      return { type: 'tool_call', name: calls[0].name, arguments: calls[0].arguments };
    }
    return { type: 'tool_calls', calls };
  }
  const text = typeof msg.content === 'string' ? msg.content.trim() : '';
  return { type: 'text', content: text };
}

function isAxiosError(err: unknown): err is AxiosError<{ error?: { message?: string } }> {
  return axios.isAxiosError(err);
}

function normalizeAxiosLLMError(err: unknown, label: string): Error {
  if (isAxiosError(err)) {
    const st = err.response?.status;
    const apiMsg = err.response?.data?.error?.message ?? err.message;
    if (st === 429) return new Error(`${label} rate limited (429): ${apiMsg}`);
    if (st === 403) return new Error(`${label} forbidden (403): ${apiMsg}`);
    if (st === 401) return new Error(`${label} unauthorized (401): ${apiMsg}`);
    if (st && st >= 500) return new Error(`${label} server error (${st}): ${apiMsg}`);
    if (err.code === 'ECONNABORTED' || err.code === 'ENOTFOUND' || err.code === 'ECONNRESET') {
      return new Error(`${label} network error: ${err.message}`);
    }
    return new Error(`${label}: ${apiMsg}`);
  }
  if (err instanceof Error) return new Error(`${label}: ${err.message}`);
  return new Error(`${label}: ${String(err)}`);
}

export interface OpenAICompatibleConfig {
  providerId: LlmProviderId;
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
}

/**
 * OpenAI-compatible chat completions (used for Groq and OpenAI).
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly id: LlmProviderId;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultModel: string;

  constructor(cfg: OpenAICompatibleConfig) {
    this.id = cfg.providerId;
    this.apiKey = cfg.apiKey;
    this.baseUrl = cfg.baseUrl.replace(/\/$/, '');
    this.defaultModel = cfg.defaultModel;
  }

  async sendMessage(
    messages: ChatMessage[],
    tools: ToolDefinition[] | undefined,
    options?: LLMSendOptions
  ): Promise<LLMResponse> {
    const model = options?.model ?? this.defaultModel;
    const body: Record<string, unknown> = {
      model,
      messages: chatMessagesToOpenAI(messages),
      temperature: options?.temperature ?? 0.3,
      max_tokens: options?.maxTokens ?? 2048,
    };
    if (tools?.length) {
      body.tools = toolsToOpenAI(tools);
      body.tool_choice = 'auto';
    }

    const label = this.id === 'groq' ? 'Groq' : 'OpenAI';
    try {
      const res = await axios.post<ChatCompletionResponse>(`${this.baseUrl}/chat/completions`, body, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 120_000,
        validateStatus: () => true,
      });

      if (res.status >= 400) {
        const msg = res.data?.error?.message ?? res.statusText;
        throw new Error(`HTTP ${res.status}: ${msg}`);
      }

      const out = parseOpenAICompletion(res.data);
      console.log(`[llm] completion provider=${this.id} model=${model}`);
      return out;
    } catch (err) {
      throw normalizeAxiosLLMError(err, label);
    }
  }
}
