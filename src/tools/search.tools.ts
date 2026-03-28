import type { ToolDefinition } from '../types/tool.types';
import { webSearch } from '../services/search.service';

export const searchToolDefinitions: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web for up-to-date information. Use for real-time facts.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query.' },
        },
        required: ['query'],
      },
    },
  },
];

export async function executeSearchTool(name: string, argsJson: string, searchApiKey: string): Promise<string> {
  if (name !== 'web_search') {
    return JSON.stringify({ error: `Unknown search tool: ${name}` });
  }

  let args: { query?: string };
  try {
    args = argsJson ? (JSON.parse(argsJson) as { query?: string }) : {};
  } catch {
    return JSON.stringify({ error: 'Invalid JSON arguments for web_search.' });
  }

  const query = String(args.query ?? '').trim();
  if (!query) {
    return JSON.stringify({ error: 'query is required' });
  }

  try {
    const { summary } = await webSearch(query, searchApiKey);
    return JSON.stringify({ ok: true, summary });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return JSON.stringify({ error: msg });
  }
}
