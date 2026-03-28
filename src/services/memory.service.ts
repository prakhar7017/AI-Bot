import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname } from 'path';

export interface MemoryEntry {
  at: string;
  userKey: string;
  role: 'user' | 'assistant';
  content: string;
}

export interface MemoryFileShape {
  entries: MemoryEntry[];
}

const MAX_ENTRIES = 200;

async function ensureDir(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

export async function loadMemory(filePath: string): Promise<MemoryFileShape> {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as MemoryFileShape;
    if (!parsed || !Array.isArray(parsed.entries)) {
      return { entries: [] };
    }
    return { entries: parsed.entries.slice(-MAX_ENTRIES) };
  } catch {
    return { entries: [] };
  }
}

export async function appendMemory(
  filePath: string,
  userKey: string,
  role: 'user' | 'assistant',
  content: string
): Promise<void> {
  await ensureDir(filePath);
  const mem = await loadMemory(filePath);
  mem.entries.push({
    at: new Date().toISOString(),
    userKey,
    role,
    content: content.slice(0, 8000),
  });
  mem.entries = mem.entries.slice(-MAX_ENTRIES);
  await writeFile(filePath, JSON.stringify(mem, null, 2), 'utf8');
}

export function memoryToChatSnippets(entries: MemoryEntry[], userKey: string, limit = 12): string {
  const mine = entries.filter((e) => e.userKey === userKey).slice(-limit);
  if (!mine.length) return '';
  return mine.map((e) => `[${e.role}] ${e.content}`).join('\n');
}
