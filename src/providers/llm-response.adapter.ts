import type { GrokChoiceMessage, ToolCall } from '../types/tool.types';
import type { LLMResponse } from '../types/llm.types';

function makeToolCallId(name: string, index: number): string {
  return `call_${Date.now()}_${index}_${name}`;
}

/** Map unified {@link LLMResponse} to the assistant message shape the agent loop expects. */
export function llmResponseToAssistantMessage(response: LLMResponse): GrokChoiceMessage {
  if (response.type === 'text') {
    return {
      role: 'assistant',
      content: response.content,
      refusal: null,
    };
  }

  const toToolCalls = (items: Array<{ name: string; arguments: Record<string, unknown> }>): ToolCall[] =>
    items.map((item, i) => ({
      id: makeToolCallId(item.name, i),
      type: 'function' as const,
      function: {
        name: item.name,
        arguments: JSON.stringify(item.arguments ?? {}),
      },
    }));

  if (response.type === 'tool_call') {
    return {
      role: 'assistant',
      content: null,
      tool_calls: toToolCalls([{ name: response.name, arguments: response.arguments ?? {} }]),
      refusal: null,
    };
  }

  return {
    role: 'assistant',
    content: null,
    tool_calls: toToolCalls(response.calls),
    refusal: null,
  };
}
