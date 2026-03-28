import {
  FunctionCallingMode,
  GoogleGenerativeAI,
  GoogleGenerativeAIFetchError,
  GoogleGenerativeAIResponseError,
  SchemaType,
  type Content,
  type FunctionCall,
  type FunctionDeclaration,
  type FunctionDeclarationSchema,
  type Part,
  type Tool,
} from '@google/generative-ai';
import type { ChatMessage, ToolDefinition } from '../types/tool.types';
import type { LLMProvider, LLMResponse, LLMSendOptions, LlmProviderId } from '../types/llm.types';

function normalizeGeminiError(err: unknown): string {
  if (err instanceof GoogleGenerativeAIFetchError) {
    const status = err.status;
    const base = err.message || 'Gemini request failed';
    if (status === 429) return `Rate limited (429). Try again shortly. ${base}`;
    if (status === 400 || status === 401 || status === 403) {
      return `Invalid API key or request (${status ?? ''}). ${base}`;
    }
    if (status && status >= 500) return `Server error (${status}): ${base}`;
    return base;
  }
  if (err instanceof GoogleGenerativeAIResponseError) {
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

function openApiStyleToGeminiSchema(
  spec: Record<string, unknown>,
  path: string
): FunctionDeclarationSchema {
  const t = spec.type;
  if (t === 'object' || (t === undefined && spec.properties)) {
    const props = spec.properties;
    const outProps: FunctionDeclarationSchema['properties'] = {};
    if (props && typeof props === 'object' && !Array.isArray(props)) {
      for (const [key, val] of Object.entries(props as Record<string, unknown>)) {
        outProps[key] = jsonSchemaFragmentToSchema(val, `${path}.${key}`);
      }
    }
    if (Object.keys(outProps).length === 0) {
      outProps._unused = {
        type: SchemaType.STRING,
        description: 'Optional; not used.',
      };
    }
    const schema: FunctionDeclarationSchema = {
      type: SchemaType.OBJECT,
      properties: outProps,
      description: typeof spec.description === 'string' ? spec.description : undefined,
    };
    if (Array.isArray(spec.required)) {
      schema.required = spec.required.filter((r): r is string => typeof r === 'string');
    }
    return schema;
  }
  return {
    type: SchemaType.OBJECT,
    properties: { value: { type: SchemaType.STRING, description: 'Fallback' } },
  };
}

function jsonSchemaFragmentToSchema(
  fragment: unknown,
  path: string
): import('@google/generative-ai').Schema {
  if (!fragment || typeof fragment !== 'object' || Array.isArray(fragment)) {
    return { type: SchemaType.STRING };
  }
  const f = fragment as Record<string, unknown>;
  const t = f.type;

  if (t === 'string') {
    return {
      type: SchemaType.STRING,
      description: typeof f.description === 'string' ? f.description : undefined,
    };
  }
  if (t === 'integer') {
    return {
      type: SchemaType.INTEGER,
      description: typeof f.description === 'string' ? f.description : undefined,
    };
  }
  if (t === 'number') {
    return {
      type: SchemaType.NUMBER,
      description: typeof f.description === 'string' ? f.description : undefined,
    };
  }
  if (t === 'boolean') {
    return {
      type: SchemaType.BOOLEAN,
      description: typeof f.description === 'string' ? f.description : undefined,
    };
  }
  if (t === 'array' && f.items) {
    return {
      type: SchemaType.ARRAY,
      items: jsonSchemaFragmentToSchema(f.items, `${path}[]`),
      description: typeof f.description === 'string' ? f.description : undefined,
    };
  }
  if (t === 'object') {
    const props = f.properties;
    const hasProps = props && typeof props === 'object' && !Array.isArray(props);
    const keys = hasProps ? Object.keys(props as object) : [];
    const ap = f.additionalProperties;
    if (keys.length === 0 && (ap === true || (typeof ap === 'object' && ap !== null))) {
      return {
        type: SchemaType.STRING,
        description:
          (typeof f.description === 'string' ? f.description : '') +
          ' Provide a JSON object as a string if needed.',
      };
    }
    return openApiStyleToGeminiSchema(f, path) as import('@google/generative-ai').Schema;
  }
  return { type: SchemaType.STRING, description: `Unknown schema at ${path}` };
}

function toolsToGeminiDeclarations(tools: ToolDefinition[]): FunctionDeclaration[] {
  return tools.map((t) => {
    const fn = t.function;
    const params = openApiStyleToGeminiSchema(
      fn.parameters as unknown as Record<string, unknown>,
      fn.name
    );
    return {
      name: fn.name,
      description: fn.description,
      parameters: params,
    };
  });
}

function buildSystemPrefix(messages: ChatMessage[]): { systemText: string; rest: ChatMessage[] } {
  const systemChunks: string[] = [];
  const rest: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system' && m.content) {
      systemChunks.push(m.content);
    } else {
      rest.push(m);
    }
  }
  return { systemText: systemChunks.join('\n\n').trim(), rest };
}

function chatMessagesToGeminiContents(messages: ChatMessage[]): Content[] {
  const { systemText, rest } = buildSystemPrefix(messages);
  const out: Content[] = [];
  let prependedSystem = false;

  const prefixFirstUser = (text: string): string => {
    if (!prependedSystem && systemText) {
      prependedSystem = true;
      return `${systemText}\n\n${text}`;
    }
    return text;
  };

  let i = 0;
  while (i < rest.length) {
    const m = rest[i];

    if (m.role === 'user') {
      const text = prefixFirstUser(m.content ?? '');
      out.push({ role: 'user', parts: [{ text }] });
      i += 1;
      continue;
    }

    if (m.role === 'assistant') {
      const parts: Part[] = [];
      if (m.content && m.content.trim()) {
        parts.push({ text: m.content });
      }
      if (m.tool_calls?.length) {
        for (const tc of m.tool_calls) {
          let args: object = {};
          try {
            args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
          } catch {
            args = {};
          }
          parts.push({
            functionCall: {
              name: tc.function.name,
              args,
            },
          });
        }
      }
      if (parts.length === 0) {
        parts.push({ text: '' });
      }
      out.push({ role: 'model', parts });
      i += 1;
      continue;
    }

    if (m.role === 'tool') {
      const funcParts: Part[] = [];
      while (i < rest.length && rest[i].role === 'tool') {
        const tm = rest[i];
        if (tm.name && tm.tool_call_id !== undefined) {
          const payload = tm.content ?? '';
          let responseBody: object;
          try {
            responseBody = JSON.parse(payload);
          } catch {
            responseBody = { result: payload };
          }
          funcParts.push({
            functionResponse: {
              name: tm.name,
              response: responseBody,
            },
          });
        }
        i += 1;
      }
      if (funcParts.length > 0) {
        out.push({ role: 'function', parts: funcParts });
      }
      continue;
    }

    i += 1;
  }

  return out;
}

function parsePartsToLLMResponse(parts: Part[] | undefined): LLMResponse {
  const list = parts ?? [];
  const calls: FunctionCall[] = [];
  const textParts: string[] = [];

  for (const p of list) {
    if ('functionCall' in p && p.functionCall?.name) {
      calls.push(p.functionCall);
    }
    if ('text' in p && typeof p.text === 'string' && p.text.length > 0) {
      textParts.push(p.text);
    }
  }

  if (calls.length > 1) {
    return {
      type: 'tool_calls',
      calls: calls.map((c) => ({
        name: c.name,
        arguments: (c.args as Record<string, unknown>) ?? {},
      })),
    };
  }
  if (calls.length === 1) {
    return {
      type: 'tool_call',
      name: calls[0].name,
      arguments: (calls[0].args as Record<string, unknown>) ?? {},
    };
  }
  return { type: 'text', content: textParts.join('').trim() || '' };
}

export class GeminiProvider implements LLMProvider {
  readonly id: LlmProviderId = 'gemini';

  constructor(
    private readonly apiKey: string,
    private readonly defaultModel: string
  ) {}

  async sendMessage(
    messages: ChatMessage[],
    tools: ToolDefinition[] | undefined,
    options?: LLMSendOptions
  ): Promise<LLMResponse> {
    const modelName = options?.model ?? this.defaultModel;
    const genAI = new GoogleGenerativeAI(this.apiKey);
    const declarations = tools?.length ? toolsToGeminiDeclarations(tools) : [];
    const toolPayload: Tool[] | undefined =
      declarations.length > 0 ? [{ functionDeclarations: declarations }] : undefined;

    const model = genAI.getGenerativeModel({
      model: modelName,
      tools: toolPayload,
      toolConfig: toolPayload
        ? {
            functionCallingConfig: { mode: FunctionCallingMode.AUTO },
          }
        : undefined,
    });

    const contents = chatMessagesToGeminiContents(messages);

    try {
      const result = await model.generateContent({
        contents,
        generationConfig: {
          temperature: options?.temperature ?? 0.3,
          maxOutputTokens: options?.maxTokens ?? 2048,
        },
      });

      const raw = result.response as import('@google/generative-ai').GenerateContentResponse & {
        promptFeedback?: import('@google/generative-ai').PromptFeedback;
      };
      if (raw.promptFeedback?.blockReason) {
        const msg = raw.promptFeedback.blockReasonMessage ?? String(raw.promptFeedback.blockReason);
        throw new Error(`Prompt blocked: ${msg}`);
      }

      const cands = raw.candidates;
      if (!cands?.length) {
        throw new Error('Gemini returned no candidates');
      }

      return parsePartsToLLMResponse(cands[0].content?.parts);
    } catch (err) {
      throw new Error(`Gemini: ${normalizeGeminiError(err)}`);
    }
  }
}
