// Generic in-memory per-key rate limiter (sliding-window-less fixed window).
// Not safe across multiple server instances — single-process only.

export type RateLimitResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterMs: number };

type Bucket = { count: number; resetAt: number };

// Buckets past their resetAt are swept every SWEEP_INTERVAL calls so idle
// keys don't accumulate forever on a long-lived server process.
const SWEEP_INTERVAL = 500;

export function createRateLimiter(maxRequests: number, windowMs: number) {
  const buckets = new Map<string, Bucket>();
  let callsSinceSweep = 0;

  return function checkRateLimit(key: string, now: number = Date.now()): RateLimitResult {
    callsSinceSweep += 1;
    if (callsSinceSweep >= SWEEP_INTERVAL) {
      callsSinceSweep = 0;
      for (const [bucketKey, bucket] of buckets) {
        if (now >= bucket.resetAt) {
          buckets.delete(bucketKey);
        }
      }
    }

    const existing = buckets.get(key);
    if (existing === undefined || now >= existing.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true };
    }

    if (existing.count >= maxRequests) {
      return { allowed: false, retryAfterMs: existing.resetAt - now };
    }

    existing.count += 1;
    return { allowed: true };
  };
}
