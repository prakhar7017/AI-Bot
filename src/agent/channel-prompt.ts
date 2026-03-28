import * as notionService from '../services/notion.service';
import { getChannelSnippet, DEFAULT_SNIPPET_LIMIT } from '../services/memory.service';
import type { NotionToolsContext } from '../tools/notion.tools';

/**
 * Build the user-turn prompt: per-channel transcript + Notion snapshot + instructions for group context.
 */
export async function buildChannelLlmUserContent(
  memoryPath: string,
  channelId: string,
  notionCtx: NotionToolsContext,
  options?: { snippetLimit?: number }
): Promise<string> {
  const limit = options?.snippetLimit ?? DEFAULT_SNIPPET_LIMIT;
  const history = await getChannelSnippet(memoryPath, channelId, limit);
  const tasks = await notionService.getTasks(notionCtx.notion, notionCtx.databaseId);
  const taskBlock = notionService.formatTasksForLlmContext(tasks);

  return `## Channel conversation (multi-user)
Each line is one Discord message. \`userId\` = author's snowflake. \`name="..."\` = nickname or display name **as stored by this bot when the message arrived** (authoritative for this channel). Chronological: oldest first, newest last.

${history || '(no messages in rolling window yet)'}

## Recent Notion tasks (snapshot — each line includes created time, status, priority; call get_tasks for live data)
${taskBlock}

## Your job
Respond to the **latest user message** at the **bottom** of the transcript.

If the latest message asks for **who said something**, **usernames**, **display names**, or to list **people without repeating numeric IDs**, answer using \`name="..."\` from the transcript. Only omit names for lines that have no \`name=\` field (then you may mention userId). Do not refuse or apologize for lacking Discord access—the names in the log are exactly what you may quote.

Otherwise use earlier lines from other users as shared context for tasks, pronouns, and follow-ups. When tasks are ambiguous, prefer get_tasks or cite task_id from the snapshot.`;
}
