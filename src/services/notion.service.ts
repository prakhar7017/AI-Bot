import { Client } from '@notionhq/client';
import type { QueryDatabaseResponse } from '@notionhq/client/build/src/api-endpoints';

/** Must match your Notion database property names. */
const TITLE_PROP = 'Title';
const STATUS_PROP = 'Status';
const PRIORITY_PROP = 'Priority';
/** Notion "Created time" column (created_time property); fallback to page root `created_time`. */
const CREATED_TIME_PROP = 'Created time';

/** Indian Standard Time (UTC+5:30) for task timestamps in LLM prompts. */
const INDIAN_TIME_ZONE = 'Asia/Kolkata';

/**
 * Format Notion ISO timestamp for prompts, e.g. "March 28, 2026 10:17 AM IST".
 * Always interpreted in **Asia/Kolkata** regardless of server location.
 */
export function formatCreatedTimeForPrompt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: INDIAN_TIME_ZONE,
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(d);

  const byType: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const p of parts) {
    if (p.type !== 'literal') {
      byType[p.type] = p.value;
    }
  }

  const month = byType.month ?? '';
  const day = byType.day ?? '';
  const year = byType.year ?? '';
  const hour = byType.hour ?? '';
  const minute = byType.minute ?? '';
  const period = (byType.dayPeriod ?? '').toUpperCase();

  return `${month} ${day}, ${year} ${hour}:${minute} ${period} IST`;
}

function getCreatedTimeIsoFromPage(page: DatabasePage): string | null {
  if (page && typeof page === 'object' && 'created_time' in page) {
    const t = (page as { created_time?: string }).created_time;
    if (typeof t === 'string' && t.length > 0) return t;
  }
  const props = 'properties' in page ? page.properties : {};
  const prop = props[CREATED_TIME_PROP];
  if (
    prop &&
    typeof prop === 'object' &&
    'type' in prop &&
    (prop as { type: string }).type === 'created_time' &&
    'created_time' in prop
  ) {
    const ct = (prop as { created_time?: string }).created_time;
    if (typeof ct === 'string' && ct.length > 0) return ct;
  }
  return null;
}

type DatabasePage = QueryDatabaseResponse['results'][number];
type DbProperties = Awaited<ReturnType<Client['databases']['retrieve']>>['properties'];

let schemaCache: { databaseId: string; properties: DbProperties } | null = null;

async function getDbProperties(client: Client, databaseId: string): Promise<DbProperties> {
  if (schemaCache?.databaseId === databaseId) return schemaCache.properties;
  const db = await client.databases.retrieve({ database_id: databaseId });
  schemaCache = { databaseId, properties: db.properties };
  return db.properties;
}

function plainTitleFromProp(prop: unknown): string {
  if (
    prop &&
    typeof prop === 'object' &&
    'type' in prop &&
    (prop as { type: string }).type === 'title' &&
    'title' in prop &&
    Array.isArray((prop as { title: unknown[] }).title)
  ) {
    const items = (prop as { title: Array<{ plain_text?: string }> }).title;
    return items.map((t) => t.plain_text ?? '').join('') || '(untitled)';
  }
  return '(untitled)';
}

function optionLabelFromProp(prop: unknown): string | null {
  if (!prop || typeof prop !== 'object' || !('type' in prop)) return null;
  const p = prop as {
    type: string;
    status?: { name?: string };
    select?: { name?: string };
    multi_select?: Array<{ name?: string }>;
  };
  if (p.type === 'status' && p.status?.name) return p.status.name;
  if (p.type === 'select' && p.select?.name) return p.select.name;
  if (p.type === 'multi_select' && p.multi_select?.length) {
    return p.multi_select.map((x) => x.name).filter(Boolean).join(', ') || null;
  }
  return null;
}

function getTitleFromPage(page: DatabasePage): string {
  const props = 'properties' in page ? page.properties : {};
  return plainTitleFromProp(props[TITLE_PROP]);
}

function getStatusFromPage(page: DatabasePage): string | null {
  const props = 'properties' in page ? page.properties : {};
  return optionLabelFromProp(props[STATUS_PROP]);
}

function getPriorityFromPage(page: DatabasePage): string | null {
  const props = 'properties' in page ? page.properties : {};
  return optionLabelFromProp(props[PRIORITY_PROP]);
}

/** Option names configured on the database property (for fuzzy matching). */
function listConfiguredOptionNames(cfg: DbProperties[string]): string[] {
  if (!cfg || typeof cfg !== 'object' || !('type' in cfg)) return [];
  const c = cfg as {
    type: string;
    select?: { options?: Array<{ name?: string }> };
    multi_select?: { options?: Array<{ name?: string }> };
    status?: { options?: Array<{ name?: string }> };
  };
  if (c.type === 'select' && c.select?.options?.length) {
    return c.select.options.map((o) => o.name).filter((n): n is string => Boolean(n && String(n).trim()));
  }
  if (c.type === 'multi_select' && c.multi_select?.options?.length) {
    return c.multi_select.options.map((o) => o.name).filter((n): n is string => Boolean(n && String(n).trim()));
  }
  if (c.type === 'status' && c.status?.options?.length) {
    return c.status.options.map((o) => o.name).filter((n): n is string => Boolean(n && String(n).trim()));
  }
  return [];
}

/** Map user/model text to the exact option name Notion expects (case/spacing). */
function resolveOptionName(configured: string[], input: string): string {
  const raw = input.trim();
  if (!raw) return raw;
  if (configured.length === 0) return raw;
  if (configured.includes(raw)) return raw;
  const lower = raw.toLowerCase();
  const hit = configured.find((n) => n.toLowerCase() === lower);
  return hit ?? raw;
}

/**
 * Build Notion API payload for Status / Priority / similar columns from DB schema types.
 * Returns null if the column type is unsupported (e.g. formula) or property missing.
 */
function patchOptionField(
  propName: string,
  value: string,
  schema: DbProperties
): Record<string, unknown> | null {
  const cfg = schema[propName];
  if (!cfg) return null;
  const t = cfg.type;
  const options = listConfiguredOptionNames(cfg);
  const nameForApi = resolveOptionName(options, value);

  if (t === 'status') {
    return { [propName]: { status: { name: nameForApi } } };
  }
  if (t === 'select') {
    return { [propName]: { select: { name: nameForApi } } };
  }
  if (t === 'multi_select') {
    return { [propName]: { multi_select: [{ name: nameForApi }] } };
  }
  if (t === 'rich_text') {
    return {
      [propName]: {
        rich_text: [{ type: 'text', text: { content: nameForApi } }],
      },
    };
  }
  return null;
}

export interface NotionTask {
  id: string;
  title: string;
  status: string | null;
  priority: string | null;
  /** ISO-8601 from Notion (page or Created time column) */
  createdTime: string | null;
}

export function createNotionClient(token: string): Client {
  return new Client({ auth: token });
}

export async function createTask(
  client: Client,
  databaseId: string,
  title: string,
  extras?: { status?: string; priority?: string }
): Promise<NotionTask> {
  const schema = await getDbProperties(client, databaseId);
  const properties: Record<string, unknown> = {
    [TITLE_PROP]: {
      title: [{ type: 'text', text: { content: title } }],
    },
  };

  let appliedStatus: string | null = null;
  const st = extras?.status?.trim();
  if (st) {
    const patch = patchOptionField(STATUS_PROP, st, schema);
    if (patch) {
      Object.assign(properties, patch);
      appliedStatus = resolveOptionName(listConfiguredOptionNames(schema[STATUS_PROP]), st);
    } else {
      console.warn(
        `[notion] Status "${st}" not applied: column missing or unsupported type for "${STATUS_PROP}".`
      );
    }
  }

  let appliedPriority: string | null = null;
  const pr = extras?.priority?.trim();
  if (pr) {
    const patch = patchOptionField(PRIORITY_PROP, pr, schema);
    if (patch) {
      Object.assign(properties, patch);
      appliedPriority = resolveOptionName(listConfiguredOptionNames(schema[PRIORITY_PROP]), pr);
    } else {
      const pCfg = schema[PRIORITY_PROP];
      const pType = pCfg && 'type' in pCfg ? pCfg.type : 'missing';
      console.warn(
        `[notion] Priority "${pr}" not applied: "${PRIORITY_PROP}" is type "${pType}" (unsupported) or missing. Use select, multi_select, status, or rich_text.`
      );
    }
  }

  const page = await client.pages.create({
    parent: { database_id: databaseId },
    properties,
  } as Parameters<Client['pages']['create']>[0]);

  const created = getCreatedTimeIsoFromPage(page as DatabasePage);
  return {
    id: page.id,
    title,
    status: appliedStatus,
    priority: appliedPriority,
    createdTime: created,
  };
}

export async function getTasks(client: Client, databaseId: string): Promise<NotionTask[]> {
  const res = await client.databases.query({
    database_id: databaseId,
    page_size: 100,
  });

  const tasks = res.results.map((p) => ({
    id: p.id,
    title: getTitleFromPage(p),
    status: getStatusFromPage(p),
    priority: getPriorityFromPage(p),
    createdTime: getCreatedTimeIsoFromPage(p),
  }));
  tasks.sort((a, b) => {
    const ta = a.createdTime ? new Date(a.createdTime).getTime() : 0;
    const tb = b.createdTime ? new Date(b.createdTime).getTime() : 0;
    return tb - ta;
  });
  return tasks;
}

/**
 * Compact snapshot for system prompt context (no assignee until a People column is added to the schema).
 */
export function formatTasksForLlmContext(tasks: NotionTask[], maxLines = 45): string {
  if (!tasks.length) {
    return '(no tasks in database)';
  }
  const lines = tasks.slice(0, maxLines).map((t) => {
    const st = t.status ?? '—';
    const pr = t.priority ?? '—';
    const created =
      t.createdTime && t.createdTime.length > 0
        ? formatCreatedTimeForPrompt(t.createdTime)
        : '—';
    return `- task_id=${t.id} | title="${t.title}" | created="${created}" | status=${st} | priority=${pr} | assignee=(not tracked; add People column if needed)`;
  });
  const extra = tasks.length > maxLines ? `\n… and ${tasks.length - maxLines} more (call get_tasks).` : '';
  return lines.join('\n') + extra;
}

/**
 * Update a task. Human keys: `title`, `status`, `priority`, or raw `properties` for advanced Notion payloads.
 */
export async function updateTask(
  client: Client,
  databaseId: string,
  taskId: string,
  fields: Record<string, unknown>
): Promise<void> {
  const schema = await getDbProperties(client, databaseId);
  const properties: Record<string, unknown> = {};

  if (typeof fields.title === 'string') {
    properties[TITLE_PROP] = {
      title: [{ type: 'text', text: { content: fields.title } }],
    };
  }

  if (typeof fields.status === 'string' && fields.status.trim()) {
    const v = fields.status.trim();
    const patch = patchOptionField(STATUS_PROP, v, schema);
    if (patch) Object.assign(properties, patch);
    else console.warn(`[notion] update_task: status "${v}" skipped (column type or missing).`);
  }

  if (typeof fields.priority === 'string' && fields.priority.trim()) {
    const v = fields.priority.trim();
    const patch = patchOptionField(PRIORITY_PROP, v, schema);
    if (patch) Object.assign(properties, patch);
    else console.warn(`[notion] update_task: priority "${v}" skipped (column type or missing).`);
  }

  let raw: unknown = fields.properties;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      raw = JSON.parse(raw) as unknown;
    } catch {
      raw = undefined;
    }
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    Object.assign(properties, raw as Record<string, unknown>);
  }

  await client.pages.update({
    page_id: taskId,
    properties,
  } as Parameters<Client['pages']['update']>[0]);
}

export async function deleteTask(client: Client, taskId: string): Promise<void> {
  await client.pages.update({
    page_id: taskId,
    archived: true,
  });
}
