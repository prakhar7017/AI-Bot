import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname } from 'path';

/** One stored line of channel conversation (multi-user). */
export interface MemoryEntry {
  userId: string;
  role: 'user' | 'assistant';
  content: string;
  /** ISO-8601 timestamp */
  timestamp: string;
}

/** v2 on-disk shape: rolling history per Discord channel/DM id. */
export interface MemoryFileV2 {
  version: 2;
  channels: Record<string, MemoryEntry[]>;
}

/** Legacy flat list (pre–per-channel); migrated on load. */
interface MemoryFileV1 {
  entries: Array<{
    at: string;
    userKey: string;
    role: 'user' | 'assistant';
    content: string;
  }>;
}

/** Max messages kept per channel (prototype budget). */
export const MEMORY_MAX_PER_CHANNEL = 100;

/** Default lines included in LLM prompt. */
export const DEFAULT_SNIPPET_LIMIT = 80;

async function ensureDir(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

function trimChannel(entries: MemoryEntry[]): MemoryEntry[] {
  return entries.slice(-MEMORY_MAX_PER_CHANNEL);
}

function normalizeFile(raw: unknown): MemoryFileV2 {
  if (!raw || typeof raw !== 'object') {
    return { version: 2, channels: {} };
  }
  const o = raw as Record<string, unknown>;

  if (o.version === 2 && o.channels && typeof o.channels === 'object' && !Array.isArray(o.channels)) {
    const channels: Record<string, MemoryEntry[]> = {};
    for (const [channelId, list] of Object.entries(o.channels as Record<string, MemoryEntry[]>)) {
      if (!Array.isArray(list)) continue;
      channels[channelId] = trimChannel(
        list.map((e) => ({
          userId: String(e.userId ?? ''),
          role: e.role === 'assistant' ? 'assistant' : 'user',
          content: String(e.content ?? ''),
          timestamp: String(e.timestamp ?? new Date().toISOString()),
        }))
      );
    }
    return { version: 2, channels };
  }

  if (Array.isArray((o as { entries?: unknown }).entries)) {
    const v1 = o as unknown as MemoryFileV1;
    const migrated: MemoryEntry[] = v1.entries.map((e) => ({
      userId: e.userKey,
      role: e.role,
      content: e.content,
      timestamp: e.at,
    }));
    return {
      version: 2,
      channels: migrated.length ? { __legacy__: trimChannel(migrated) } : {},
    };
  }

  return { version: 2, channels: {} };
}

export async function loadMemoryFile(filePath: string): Promise<MemoryFileV2> {
  try {
    const raw = await readFile(filePath, 'utf8');
    return normalizeFile(JSON.parse(raw) as unknown);
  } catch {
    return { version: 2, channels: {} };
  }
}

async function saveMemoryFile(filePath: string, data: MemoryFileV2): Promise<void> {
  await ensureDir(filePath);
  await writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Append a message to a channel's rolling window (read → modify → write).
 */
export async function addMessage(filePath: string, channelId: string, entry: MemoryEntry): Promise<void> {
  const data = await loadMemoryFile(filePath);
  const list = data.channels[channelId] ?? [];
  list.push({
    userId: entry.userId,
    role: entry.role,
    content: entry.content.slice(0, 8000),
    timestamp: entry.timestamp || new Date().toISOString(),
  });
  data.channels[channelId] = trimChannel(list);
  await saveMemoryFile(filePath, data);
}

/**
 * Last `limit` messages for a channel, formatted for the LLM (multi-user aware).
 */
export async function getChannelSnippet(
  filePath: string,
  channelId: string,
  limit: number = DEFAULT_SNIPPET_LIMIT
): Promise<string> {
  const data = await loadMemoryFile(filePath);
  const list = data.channels[channelId] ?? [];
  const slice = list.slice(-Math.min(limit, MEMORY_MAX_PER_CHANNEL));
  if (!slice.length) return '';

  return slice
    .map((e) => {
      const roleTag = e.role === 'assistant' ? 'assistant' : 'user';
      return `[${e.timestamp}] ${roleTag} userId=${e.userId}: ${e.content}`;
    })
    .join('\n');
}
