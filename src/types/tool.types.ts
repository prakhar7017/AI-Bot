/** Chat / LLM message roles (OpenAI-compatible; used with Gemini + tool loop). */
export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

/** Single function tool invocation from the model. */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/** One message in the conversation (API shape). */
export interface ChatMessage {
  role: ChatRole;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

/** JSON-schema style tool definition (converted to Gemini functionDeclarations). */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

/** Normalized result of executing a tool (string for LLM consumption). */
export interface ToolExecutionResult {
  toolCallId: string;
  name: string;
  content: string;
  error?: boolean;
}

/** Assistant turn from the LLM (OpenAI-compatible; returned by Gemini service). */
export interface GrokChoiceMessage {
  role: 'assistant';
  content: string | null;
  tool_calls?: ToolCall[];
  refusal?: string | null;
}

