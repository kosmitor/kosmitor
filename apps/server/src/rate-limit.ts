/**
 * Attempt counting for the sign-in form, so a password cannot be guessed at
 * speed. ponytail: counts live in this process; put them in a table if several
 * servers must share one count.
 */
const attempts = new Map<string, number[]>();

/** Records an attempt under `key` and says whether it is one too many in the window. */
export function tooManyAttempts(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const recent = (attempts.get(key) ?? []).filter((t) => t > now - windowMs);
  recent.push(now);
  attempts.set(key, recent);
  if (attempts.size > 10_000) for (const [k, times] of attempts) if (times.every((t) => t <= now - windowMs)) attempts.delete(k);
  return recent.length > limit;
}

/** Only for tests, which sign in more often than anyone. */
export function forgetAttempts(): void {
  attempts.clear();
}
