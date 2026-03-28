import type { ChatMessage, ToolDefinition } from './tool.types';

/** Canonical outcome from any LLM provider (tool loop uses this, then maps to assistant shape). */
export type LLMResponse =
  | { type: 'text'; content: string }
  | { type: 'tool_call'; name: string; arguments: Record<string, unknown> }
  | {
      type: 'tool_calls';
      calls: Array<{ name: string; arguments: Record<string, unknown> }>;
    };

export type LlmProviderId = 'gemini' | 'groq' | 'openai';

export interface LLMSendOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

/**
 * Pluggable LLM backend. Implementations return {@link LLMResponse} (not provider-raw payloads).
 */
export interface LLMProvider {
  /** Stable id for logging (e.g. gemini, groq, openai). */
  readonly id: LlmProviderId;
  sendMessage(
    messages: ChatMessage[],
    tools: ToolDefinition[] | undefined,
    options?: LLMSendOptions
  ): Promise<LLMResponse>;
}
