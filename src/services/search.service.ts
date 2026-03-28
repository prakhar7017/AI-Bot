import axios, { AxiosError } from 'axios';

const TAVILY_URL = 'https://api.tavily.com/search';

export interface WebSearchResult {
  summary: string;
  raw?: unknown;
}

function extractErrorMessage(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const ax = err as AxiosError<{ message?: string; detail?: string }>;
    return (
      ax.response?.data?.message ??
      ax.response?.data?.detail ??
      ax.response?.statusText ??
      ax.message ??
      'Search request failed'
    );
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Tavily search; returns a concise text summary for the LLM.
 */
export async function webSearch(query: string, apiKey: string): Promise<WebSearchResult> {
  const q = query.trim();
  if (!q) {
    return { summary: 'Empty search query.' };
  }

  try {
    const res = await axios.post(
      TAVILY_URL,
      {
        api_key: apiKey,
        query: q,
        search_depth: 'basic',
        include_answer: true,
        max_results: 5,
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 45_000,
        validateStatus: () => true,
      }
    );

    if (res.status >= 400) {
      const msg =
        (res.data as { message?: string })?.message ??
        (typeof res.data === 'string' ? res.data : JSON.stringify(res.data));
      throw new Error(`Tavily error (${res.status}): ${msg}`);
    }

    const data = res.data as {
      answer?: string;
      results?: Array<{ title?: string; url?: string; content?: string }>;
    };

    const parts: string[] = [];
    if (data.answer) {
      parts.push(`Answer: ${data.answer}`);
    }
    if (data.results?.length) {
      const snippets = data.results
        .slice(0, 5)
        .map((r, i) => `${i + 1}. ${r.title ?? 'Untitled'} — ${r.url ?? ''}\n   ${(r.content ?? '').slice(0, 400)}`)
        .join('\n');
      parts.push(`Sources:\n${snippets}`);
    }

    const summary = parts.join('\n\n').trim() || 'No results returned.';
    return { summary, raw: data };
  } catch (err) {
    throw new Error(`Search: ${extractErrorMessage(err)}`);
  }
}
