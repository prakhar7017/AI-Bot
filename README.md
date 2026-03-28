# AI Runtime Agent (Discord + LLM + Notion + Search)

Node.js + TypeScript Discord bot that runs an **LLM agent** with **function calling**: Notion task CRUD (normalized status/priority), **Tavily** web search, **per-channel** conversation memory (JSON), and **multi-LLM** support (Gemini / Groq / OpenAI-compatible) with optional fallback.

## Quick start

```bash
cp .env.example .env
# Fill DISCORD_BOT_TOKEN, NOTION_*, SEARCH_API_KEY (Tavily), and LLM key(s)
npm install
npm run dev
```

- **Build:** `npm run build` → `npm start`
- **Docs:** Full flow and implementation details → [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## Discord setup (minimal)

1. [Discord Developer Portal](https://discord.com/developers/applications): create app → Bot → copy token → **Message Content Intent** ON.
2. OAuth2 URL: scope `bot`; grant **Send Messages**, **Read Message History**, etc.
3. Optional: set `AGENT_PREFIX` so only messages starting with that string trigger the bot.

## Environment highlights

| Variable | Purpose |
|----------|---------|
| `LLM_PROVIDER` | `gemini` \| `groq` \| `openai` |
| `LLM_FALLBACK` | `true` / `false` — try other providers on failure |
| `GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENAI_API_KEY` | As needed |
| `NOTION_API_KEY`, `NOTION_DATABASE_ID` | Task database |
| `SEARCH_API_KEY` | Tavily |
| `AGENT_MEMORY_PATH` | Default `data/memory.json` |
| `AGENT_PREFIX` | Optional command prefix |

See `.env.example` for models and optional tuning.

## License

MIT
