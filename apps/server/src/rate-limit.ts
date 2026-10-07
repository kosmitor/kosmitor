/**
 * Failed-attempt counting for the sign-in form, so a password cannot be guessed at
 * speed. ponytail: counts live in this process; put them in a table if several
 * servers must share one count.
 */
const attempts = new Map<string, number[]>();
let swept = 0;

const recent = (key: string, windowMs: number, now: number): number[] =>
  (attempts.get(key) ?? []).filter((t) => t > now - windowMs);

/** Whether `key` already has `limit` failures in the window. Records nothing. */
export function tooManyFailures(key: string, limit: number, windowMs: number): boolean {
  return recent(key, windowMs, Date.now()).length >= limit;
}

/** Records a failed attempt under `key`. */
export function recordFailure(key: string, windowMs: number): void {
  const now = Date.now();
  const times = recent(key, windowMs, now);
  times.push(now);
  attempts.set(key, times);
  // Stale keys go at most once a minute, so a flood of new keys cannot make every call scan them all.
  if (attempts.size > 10_000 && now - swept > 60_000) {
    swept = now;
    for (const [k, t] of attempts) if (t.every((x) => x <= now - windowMs)) attempts.delete(k);
  }
}

/** Forgets the failures under `key`: the right password came from there. */
export function clearFailures(key: string): void {
  attempts.delete(key);
}

/** Only for tests, which sign in more often than anyone. */
export function forgetAttempts(): void {
  attempts.clear();
}
