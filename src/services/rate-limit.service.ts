export interface RateLimiter {
  allow(key: string): boolean;
}

/**
 * Fixed window rate limit: max `max` hits per `windowMs` per key.
 */
export function createRateLimiter(windowMs: number, max: number): RateLimiter {
  const state = new Map<string, { windowStart: number; count: number }>();

  return {
    allow(key: string): boolean {
      const now = Date.now();
      let s = state.get(key);
      if (!s || now - s.windowStart >= windowMs) {
        s = { windowStart: now, count: 0 };
        state.set(key, s);
      }
      if (s.count >= max) return false;
      s.count += 1;
      return true;
    },
  };
}
