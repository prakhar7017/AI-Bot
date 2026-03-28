import type { ChatMessage, ToolCall, ToolDefinition } from '../types/tool.types';
import { getLLMProvider } from '../factory/llm.factory';
import { llmResponseToAssistantMessage } from '../providers/llm-response.adapter';
import { notionToolDefinitions, executeNotionTool, type NotionToolsContext } from '../tools/notion.tools';
import { searchToolDefinitions, executeSearchTool } from '../tools/search.tools';
import { buildChannelLlmUserContent } from './channel-prompt';

const SYSTEM_PROMPT = `You are an AI Runtime Agent that can perform real-world actions using tools.

Your responsibilities:

* Manage tasks in Notion
* Perform web searches
* Assist users via Discord

You often see **multiple Discord users** in the same channel transcript (each line has a userId). Use that shared context to interpret follow-ups, "that task", and pronouns across users.

Rules:

* Always decide between responding or calling a tool
* Never hallucinate real-time data
* Use tools when needed
* Keep responses concise

## Notion tasks: intelligent parsing (critical)

When calling create_task or update_task, you must reason about user intent and pass **only** these exact strings—never raw user phrases.

**Status** (exactly one of):
* "Not started"
* "In progress"
* "Done"

**Priority** (exactly one of):
* "High"
* "Medium"
* "Low"
* "None"

Interpret meaning (typos, slang, indirect wording are OK to understand—but **output must be one of the strings above**):
* Completion / wrap up / finished / shipped → "Done"
* Currently working / ongoing / WIP → "In progress"
* New / TODO / not begun → "Not started"
* Urgent / critical / important / ASAP → "High"
* Minor / trivial / not urgent → "Low"
* Explicitly no priority → "None"
* Neutral / ordinary importance → "Medium"

If you omit status or priority on **create_task**, the system defaults to "Not started" and "Medium"—but you should still set them explicitly when the user clearly implies values.

Make best-effort decisions; do not ask the user to disambiguate unless the request is impossible to act on.`;

const MAX_AGENT_STEPS = 8;

const allTools: ToolDefinition[] = [...notionToolDefinitions, ...searchToolDefinitions];

export interface AgentDeps {
  notionCtx: NotionToolsContext;
  searchApiKey: string;
  memoryPath: string;
}

function hasToolCalls(message: { tool_calls?: ToolCall[] } | null | undefined): boolean {
  return Boolean(message?.tool_calls && message.tool_calls.length > 0);
}

function assistantText(message: { content?: string | null; refusal?: string | null }): string {
  const refusal = message.refusal?.trim();
  if (refusal) return refusal;
  const c = message.content?.trim();
  if (c) return c;
  return '';
}

async function executeToolCall(
  call: ToolCall,
  deps: AgentDeps
): Promise<{ tool_call_id: string; content: string }> {
  const name = call.function.name;
  const id = call.id;
  const rawArgs = call.function.arguments ?? '{}';

  const notionNames = new Set(notionToolDefinitions.map((t) => t.function.name));
  const searchNames = new Set(searchToolDefinitions.map((t) => t.function.name));

  let content: string;
  if (notionNames.has(name)) {
    content = await executeNotionTool(name, rawArgs, deps.notionCtx);
  } else if (searchNames.has(name)) {
    content = await executeSearchTool(name, rawArgs, deps.searchApiKey);
  } else {
    content = JSON.stringify({ error: `Unknown tool: ${name}` });
  }

  return { tool_call_id: id, content };
}

/**
 * Run the agent loop: model → tool execution → model until text reply or max steps.
 * Expects the **user** line already appended to per-channel memory by the Discord handler.
 */
export async function runAgent(
  channelId: string,
  _authorUserId: string,
  _userText: string,
  deps: AgentDeps
): Promise<string> {
  const augmentedUser = await buildChannelLlmUserContent(deps.memoryPath, channelId, deps.notionCtx);

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: augmentedUser },
  ];

  const llm = getLLMProvider();

  let step = 0;
  let lastError: string | null = null;

  while (step < MAX_AGENT_STEPS) {
    step += 1;
    let assistantMsg;
    try {
      const raw = await llm.sendMessage(messages, allTools, {
        temperature: 0.3,
        maxTokens: 2048,
      });
      assistantMsg = llmResponseToAssistantMessage(raw);
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      console.error('[agent] LLM error:', lastError);
      return 'I ran into a problem reaching the AI service. Please try again in a moment.';
    }

    messages.push({
      role: 'assistant',
      content: assistantMsg.content ?? null,
      tool_calls: assistantMsg.tool_calls,
    });

    if (!hasToolCalls(assistantMsg)) {
      const out = assistantText(assistantMsg);
      const finalText = out || 'Done.';
      return finalText;
    }

    const calls = assistantMsg.tool_calls ?? [];
    console.log('[agent] Tool calls:', calls.map((c) => c.function.name).join(', '));

    for (const call of calls) {
      const { tool_call_id, content } = await executeToolCall(call, deps);
      console.log('[agent] Tool result', call.function.name, content.slice(0, 500));
      messages.push({
        role: 'tool',
        tool_call_id,
        name: call.function.name,
        content,
      });
    }
  }

  const fallback =
    lastError ??
    'I took too many steps handling tools. Please narrow the request or try again.';
  return fallback;
}

export function getToolDefinitionsForDiagnostics(): ToolDefinition[] {
  return allTools;
}
