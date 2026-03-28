import type { Client } from '@notionhq/client';
import {
  DEFAULT_CREATE_PRIORITY,
  DEFAULT_CREATE_STATUS,
  normalizeTaskPriority,
  normalizeTaskStatus,
} from '../agent/task-schema.normalize';
import type { ToolDefinition } from '../types/tool.types';
import * as notionService from '../services/notion.service';

const STATUS_ENUM_HINT =
  'EXACTLY one of: "Not started" | "In progress" | "Done". Interpret natural language then pass ONLY these strings.';
const PRIORITY_ENUM_HINT =
  'EXACTLY one of: "High" | "Medium" | "Low" | "None". Interpret natural language then pass ONLY these strings.';

export const notionToolDefinitions: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'create_task',
      description:
        'Create a task (Title, Status, Priority). Pass title + optional status/priority using ONLY the exact allowed strings (see parameter descriptions). Infer meaning from user wording; never pass raw phrases like "completed" or "urgent".',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Clear task title (not status/priority).' },
          status: {
            type: 'string',
            description: `Optional. ${STATUS_ENUM_HINT} If user gives no status, omit (server defaults to "Not started").`,
          },
          priority: {
            type: 'string',
            description: `Optional. ${PRIORITY_ENUM_HINT} If user gives no priority, omit (server defaults to "Medium").`,
          },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_tasks',
      description: 'List all tasks in the Notion tasks database.',
      parameters: {
        type: 'object',
        properties: {
          note: {
            type: 'string',
            description: 'Optional; ignored. Pass {} or omit.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_task',
      description:
        'Update a task by page ID. Use title, status, priority (human keys), and/or raw Notion properties.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'Notion page ID of the task.' },
          fields: {
            type: 'object',
            description:
              'Fields to update: title, status, priority, and/or properties (raw Notion property map).',
            properties: {
              title: { type: 'string', description: 'New task title (Title column).' },
              status: { type: 'string', description: STATUS_ENUM_HINT },
              priority: { type: 'string', description: PRIORITY_ENUM_HINT },
              properties: {
                type: 'object',
                description: 'Raw Notion `properties` object for advanced updates.',
                additionalProperties: true,
              },
            },
          },
        },
        required: ['task_id', 'fields'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_task',
      description: 'Archive (soft-delete) a task in Notion by page ID.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'Notion page ID of the task.' },
        },
        required: ['task_id'],
      },
    },
  },
];

export interface NotionToolsContext {
  notion: Client;
  databaseId: string;
}

export async function executeNotionTool(
  name: string,
  argsJson: string,
  ctx: NotionToolsContext
): Promise<string> {
  let args: Record<string, unknown>;
  try {
    args = argsJson ? (JSON.parse(argsJson) as Record<string, unknown>) : {};
  } catch {
    return JSON.stringify({ error: 'Invalid JSON arguments for Notion tool.' });
  }

  try {
    switch (name) {
      case 'create_task': {
        const title = String(args.title ?? '').trim();
        if (!title) return JSON.stringify({ error: 'title is required' });
        const statusRaw = args.status != null ? String(args.status) : undefined;
        const priorityRaw = args.priority != null ? String(args.priority) : undefined;
        const statusNorm = normalizeTaskStatus(statusRaw) ?? DEFAULT_CREATE_STATUS;
        const priorityNorm = normalizeTaskPriority(priorityRaw) ?? DEFAULT_CREATE_PRIORITY;
        const t = await notionService.createTask(ctx.notion, ctx.databaseId, title, {
          status: statusNorm,
          priority: priorityNorm,
        });
        return JSON.stringify({
          ok: true,
          task: t,
          normalized: { status: statusNorm, priority: priorityNorm },
        });
      }
      case 'get_tasks': {
        const tasks = await notionService.getTasks(ctx.notion, ctx.databaseId);
        return JSON.stringify({ ok: true, tasks });
      }
      case 'update_task': {
        const taskId = String(args.task_id ?? '').trim();
        const fields = args.fields;
        if (!taskId) return JSON.stringify({ error: 'task_id is required' });
        if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
          return JSON.stringify({ error: 'fields must be an object' });
        }
        const patch = { ...(fields as Record<string, unknown>) };
        if (typeof patch.status === 'string') {
          patch.status = normalizeTaskStatus(patch.status) ?? patch.status;
        }
        if (typeof patch.priority === 'string') {
          patch.priority = normalizeTaskPriority(patch.priority) ?? patch.priority;
        }
        await notionService.updateTask(ctx.notion, ctx.databaseId, taskId, patch);
        return JSON.stringify({ ok: true, task_id: taskId });
      }
      case 'delete_task': {
        const taskId = String(args.task_id ?? '').trim();
        if (!taskId) return JSON.stringify({ error: 'task_id is required' });
        await notionService.deleteTask(ctx.notion, taskId);
        return JSON.stringify({ ok: true, archived: taskId });
      }
      default:
        return JSON.stringify({ error: `Unknown Notion tool: ${name}` });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return JSON.stringify({ error: msg });
  }
}
