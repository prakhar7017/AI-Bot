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
Each line is one message in this Discord channel/DM. \`userId\` is the Discord snowflake of the author. The transcript is chronological (oldest first, newest last). Assistant lines use the bot's user id.

${history || '(no messages in rolling window yet)'}

## Recent Notion tasks (snapshot — each line includes created time, status, priority; call get_tasks for live data)
${taskBlock}

## Your job
Respond to the **latest user message** at the **bottom** of the transcript. Use earlier lines from **other userIds** as shared context: resolve "that task", pronouns, and follow-up questions cooperatively. When tasks are ambiguous, prefer get_tasks or cite task_id from the snapshot.`;
}
