/**
 * Canonical values for Notion Status / Priority (exact strings for the API).
 */
export const TASK_STATUS_VALUES = ['Not started', 'In progress', 'Done'] as const;
export type TaskStatusValue = (typeof TASK_STATUS_VALUES)[number];

export const TASK_PRIORITY_VALUES = ['High', 'Medium', 'Low', 'None'] as const;
export type TaskPriorityValue = (typeof TASK_PRIORITY_VALUES)[number];

function compact(s: string): string {
  return s.trim().replace(/\s+/g, ' ');
}

/** Best-effort Levenshtein for short option matching (typos). */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[] = Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + cost);
      prev = tmp;
    }
  }
  return dp[n];
}

function closestToCanon(input: string, canons: readonly string[]): string {
  const t = compact(input).toLowerCase();
  if (!t) return canons[0];
  let best = canons[0];
  let bestScore = Infinity;
  for (const c of canons) {
    const d = levenshtein(t, c.toLowerCase());
    if (d < bestScore) {
      bestScore = d;
      best = c;
    }
  }
  return best;
}

/**
 * Map messy natural language to exactly one allowed status (never returns user raw text).
 */
export function normalizeTaskStatus(raw: string | undefined | null): TaskStatusValue | undefined {
  if (raw == null) return undefined;
  const s = compact(String(raw));
  if (!s) return undefined;

  const t = s.toLowerCase();

  // Exact / near-exact canon
  for (const c of TASK_STATUS_VALUES) {
    if (t === c.toLowerCase()) return c;
  }

  // Semantic buckets (keywords / slang / misspellings)
  const doneHints =
    /\b(done|complete|completed|completd|finish|finished|closed|shipped|resolved|wrap|wrapped|finalize|finalized|chk|checked)\b/i;
  const progressHints =
    /\b(progress|progess|ongoing|active|started|working|current|underway|wip|doing|develop)\b/i;
  const notStartedHints =
    /\b(not\s*started|unstarted|new|todo|pending|backlog|plan|planned|queued)\b/i;

  if (doneHints.test(s) && !notStartedHints.test(s)) return 'Done';
  if (progressHints.test(s)) return 'In progress';
  if (notStartedHints.test(s)) return 'Not started';

  // "complete" substring without word boundary
  if (/complet|finish|clos(e|ed)|wrap\b|done\b/i.test(t) && !/not\s|un-|never/i.test(t)) {
    return 'Done';
  }
  if (/in\s*prog|work|ongoing|current/i.test(t)) return 'In progress';

  return closestToCanon(s, TASK_STATUS_VALUES) as TaskStatusValue;
}

/**
 * Map messy natural language to exactly one allowed priority.
 */
export function normalizeTaskPriority(raw: string | undefined | null): TaskPriorityValue | undefined {
  if (raw == null) return undefined;
  const s = compact(String(raw));
  if (!s) return undefined;

  const t = s.toLowerCase();

  for (const c of TASK_PRIORITY_VALUES) {
    if (t === c.toLowerCase()) return c;
  }

  const highHints =
    /\b(high|urgent|critical|asap|important|priority|p0|emergency|severe|blocking)\b/i;
  const lowHints = /\b(low|minor|trivial|small|nice\s*to|whenever|later|p2|unurgent|not\s*urgent)\b/i;
  const noneHints = /\b(none|no\s*prior|n\/a|unset|—|-\b)\b/i;
  const medHints = /\b(medium|normal|moderate|mid|default|standard)\b/i;

  if (noneHints.test(s)) return 'None';
  if (highHints.test(s) && !lowHints.test(s)) return 'High';
  if (lowHints.test(s) && !highHints.test(s)) return 'Low';
  if (medHints.test(s)) return 'Medium';

  if (/urgent|asap|crit|important/i.test(t) && !/not|low|minor/i.test(t)) return 'High';

  return closestToCanon(s, TASK_PRIORITY_VALUES) as TaskPriorityValue;
}

/** Defaults for new tasks when the model omits fields (per product rules). */
export const DEFAULT_CREATE_STATUS: TaskStatusValue = 'Not started';
export const DEFAULT_CREATE_PRIORITY: TaskPriorityValue = 'Medium';
