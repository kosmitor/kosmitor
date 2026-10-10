/**
 * PostHog in the browser, when analytics.posthog is set: pageviews, clicks,
 * uncaught errors and the person behind them. Without it nothing here runs.
 */
import posthog from 'posthog-js';
import { config } from './config.ts';
import type { User } from './session.tsx';

const settings = config.analytics.posthog;
if (settings) {
  posthog.init(settings.key, { api_host: settings.host, capture_pageview: 'history_change', capture_exceptions: true, person_profiles: 'identified_only' });
}

/** Reports errors caught by React before they reach the browser's global handlers. */
export function captureException(error: unknown): void {
  if (settings) posthog.captureException(error);
}

/** Names the signed-in person, so their pageviews and errors are theirs. */
export function identify(user: User): void {
  if (settings) posthog.identify(user.id, { email: user.email, name: user.name });
}

/** Forgets the person on sign-out, so the next one in this browser starts clean. */
export function forget(): void {
  if (settings) posthog.reset();
}
