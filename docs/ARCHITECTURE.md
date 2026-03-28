# Architecture & Flow — AI Runtime Agent

This document describes **end-to-end behavior**, **module responsibilities**, and **implementation details** for the Discord bot that uses an LLM with tools (Notion + web search) and per-channel memory.

---

## 1. High-level system flow

```
┌─────────────┐     MessageCreate      ┌──────────────┐
│   Discord   │ ─────────────────────► │   bot.ts     │
│   users     │                        │  (discord.js)│
└─────────────┘                        └──────┬───────┘
                                              │
                    1. strip prefix, rate limit
                    2. addMessage(user) → memory.json
                    3. runAgent(channelId, …) 
                                              │
                                              ▼
                                     ┌────────────────┐
                                     │   agent.ts      │
                                     │  agent loop     │
                                     └────────┬───────┘
                                              │
                    buildChannelLlmUserContent │◄── memory + Notion snapshot
                    getLLMProvider()        │
                    llm.sendMessage + tools │
                    tool execution         │
                                              │
                    4. addMessage(assistant) │
                    5. reply in Discord     ▼
                                     ┌────────────────┐
                                     │ Notion / Tavily│
                                     │ (via tools)    │
                                     └────────────────┘
```

**Single message lifecycle**

1. A human posts in a guild channel or DM (non-bot, passes optional `AGENT_PREFIX`).
2. The handler **persists the user line** to `data/memory.json` keyed by **Discord `channelId`** (not per-user isolation).
3. **`runAgent`** builds one LLM **user** blob: channel transcript snippet + Notion task snapshot + instructions.
4. The **LLM** (Gemini, Groq, or OpenAI-compatible) returns either **text** or **tool call(s)**.
5. If tools run, results are appended to the chat as **tool** messages and the model is called again (loop, max 8 steps).
6. Final **assistant text** is stored in memory and sent back to Discord (chunked if long).

---

## 2. Entrypoint & configuration

| File | Role |
|------|------|
| `src/index.ts` | Loads env (via imports), starts `startDiscordBot()`. |
| `src/config/env.ts` | `dotenv` + validated/parsed env: LLM provider(s), Discord, Notion, Tavily, paths, rate limits. |

**Required env (typical)**

- `DISCORD_BOT_TOKEN`, `NOTION_API_KEY`, `NOTION_DATABASE_ID`, `SEARCH_API_KEY` (Tavily)
- At least one LLM key matching `LLM_PROVIDER` / fallback chain (`GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENAI_API_KEY`)

See repository `.env.example` for the full list.

---

## 3. Discord layer (`src/discord/bot.ts`)

**Intents:** `Guilds`, `GuildMessages`, `DirectMessages`, `MessageContent` (required to read message bodies).

**Partials:** `Channel`, `Message` — helps with DMs and some partial structures.

**Behavior**

- **Ignore** bots.
- **Prefix:** If `AGENT_PREFIX` is non-empty, only messages starting with that prefix are handled; the prefix is stripped before the LLM sees the text.
- **Rate limit:** Per **Discord user id** (`author.id`), sliding window (`RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX_REQUESTS`).
- **Memory:** Before calling the agent, **`addMessage(memoryPath, channelId, { userId, role: 'user', content, timestamp })`**.
- After **`runAgent`**, **`addMessage(..., role: 'assistant', userId: bot's id)`** so transcripts include bot replies.
- **Typing:** `sendTyping()` when the channel supports it.
- **Replies:** `message.reply()`; overflow uses `~1900` char chunks.

---

## 4. Memory (`src/services/memory.service.ts`)

**Purpose:** Cheap, file-backed **per-channel** rolling history for **multi-user** context.

**On-disk format (v2)**

```json
{
  "version": 2,
  "channels": {
    "<discordChannelId>": [
      {
        "userId": "<snowflake>",
        "role": "user" | "assistant",
        "content": "...",
        "timestamp": "ISO-8601"
      }
    ]
  }
}
```

**Limits**

- **Up to 100** messages per channel (`MEMORY_MAX_PER_CHANNEL`).
- **`getChannelSnippet`** returns the last **80** lines by default (`DEFAULT_SNIPPET_LIMIT`), formatted for the LLM with `userId` and timestamp on each line.

**Legacy:** Old flat `entries[]` files migrate into `channels.__legacy__` on load.

**API**

- **`addMessage(filePath, channelId, entry)`** — append + trim.
- **`getChannelSnippet(filePath, channelId, limit?)`** — prompt text.
- **`loadMemoryFile`** — internal / inspection.

---

## 5. Prompt assembly (`src/agent/channel-prompt.ts`)

**`buildChannelLlmUserContent(memoryPath, channelId, notionCtx)`**

1. Loads **`getChannelSnippet`** for that channel.
2. Calls **`getTasks`** on Notion and **`formatTasksForLlmContext`** (`src/services/notion.service.ts`) for a **compact task list** (title, status, priority, `task_id`; assignee is documented as not tracked unless you extend the schema).
3. Concatenates fixed instructions: answer the **latest** user line; use earlier lines for **shared / multi-user** context.

The **system** prompt in `agent.ts` adds tool rules, Notion status/priority enums, and multi-user guidance.

---

## 6. Agent loop (`src/agent/agent.ts`)

**Inputs:** `channelId`, `authorUserId`, `userText` (the latter two are kept for API compatibility; the LLM user content is rebuilt from **memory + Notion**, and the triggering user line is already in memory).

**Steps**

1. Build `messages = [ system, user where user = buildChannelLlmUserContent(...) ]`.
2. **`getLLMProvider()`** — see §7.
3. Loop up to **`MAX_AGENT_STEPS` (8)**:
   - `llm.sendMessage(messages, allTools, options)` → **`LLMResponse`** (`src/types/llm.types.ts`).
   - **`llmResponseToAssistantMessage`** (`src/providers/llm-response.adapter.ts`) converts to OpenAI-like assistant shape with `tool_calls` + string `function.arguments` JSON.
   - If no tool calls → return final assistant string.
   - Else → **`executeToolCall`** per call → push **`role: 'tool'`** messages → repeat.

**Tools wired:** all definitions from `notion.tools.ts` + `search.tools.ts`.

**Notion normalization:** `create_task` / `update_task` paths use **`task-schema.normalize.ts`** so status/priority map to exact allowed strings before Notion API calls.

---

## 7. LLM providers (`src/factory`, `src/providers`)

**Types (`src/types/llm.types.ts`)**

- **`LLMProvider`:** `sendMessage(messages, tools, options?)` → **`LLMResponse`** (`text` | `tool_call` | `tool_calls`).
- **`ChatMessage` / `ToolDefinition`:** `src/types/tool.types.ts` (OpenAI-style chat + JSON-schema tools).

**Factory (`src/factory/llm.factory.ts`)**

- **`LLM_PROVIDER`:** `gemini` | `groq` | `openai`.
- **`getLLMProvider()`:** Singleton. If **`LLM_FALLBACK`** is not `false`, wraps a **chain**: primary first, then any other provider that has an API key, order **gemini → groq → openai**. On failure, tries the next provider (logs failures and successful fallback).
- **`resetLLMProviderCache()`** — mainly for tests.

**Implementations**

| Provider | File | Transport |
|----------|------|-----------|
| Gemini | `providers/gemini.provider.ts` | `@google/generative-ai`, `functionDeclarations`, system prepended to first user |
| Groq | `providers/groq.provider.ts` + `openai-compatible.provider.ts` | HTTPS `api.groq.com/openai/v1/chat/completions` |
| OpenAI | `providers/openai.provider.ts` + same compatible class | `api.openai.com/v1/chat/completions` |

**Adapter** (`llm-response.adapter.ts`): unified **`LLMResponse`** → assistant message shape expected by the tool loop.

---

## 8. Notion (`src/services/notion.service.ts`, `src/tools/notion.tools.ts`)

**Database assumptions (property names)**

- **Title** — Notion `title`
- **Status** — native `status` or `select` (schema introspected via `databases.retrieve`)
- **Priority** — `select`, `multi_select`, `rich_text`, or `status` as supported

**CRUD (tools)**

- `create_task`, `get_tasks`, `update_task`, `delete_task` (archive)

**Task context for prompts:** `getTasks` + `formatTasksForLlmContext` (snapshot; live data via `get_tasks` tool).

---

## 9. Web search (`src/services/search.service.ts`, `src/tools/search.tools.ts`)

- **`web_search(query)`** — Tavily HTTP API via **axios**; summarized text returned as tool result JSON for the LLM.

---

## 10. Supporting utilities

| Module | Role |
|--------|------|
| `src/services/rate-limit.service.ts` | In-memory per-user throttle for Discord |
| `src/agent/task-schema.normalize.ts` | Semantic + fuzzy mapping to allowed Status/Priority strings |

---

## 11. Project layout (reference)

```
src/
  index.ts
  config/env.ts
  agent/
    agent.ts
    channel-prompt.ts
    task-schema.normalize.ts
  discord/bot.ts
  factory/llm.factory.ts
  providers/
    gemini.provider.ts
    groq.provider.ts
    openai.provider.ts
    openai-compatible.provider.ts
    llm-response.adapter.ts
  services/
    memory.service.ts
    notion.service.ts
    search.service.ts
    rate-limit.service.ts
  tools/
    notion.tools.ts
    search.tools.ts
  types/
    tool.types.ts
    llm.types.ts
data/
  memory.json          # default; configurable via AGENT_MEMORY_PATH
```

---

## 12. Operational notes

- **Prototype storage:** One JSON file; concurrent writers are not fully transactional — acceptable for a single bot process.
- **Secrets:** Never commit `.env`; use `.env.example` as a template.
- **Discord:** Enable **Message Content Intent** for the bot in the Developer Portal.
- **Testing:** Smoke-test in one channel with multiple users, then Notion CRUD, then a question that should trigger `web_search`.

For a short **runbook** (env invite, smoke tests), see the project `README.md`.
