// No `import * as vscode` here on purpose — this is the pure decision logic
// behind runAudit's catch block, factored out so it's unit-testable with a
// plain node:test run instead of needing the vscode API mocked.

import { ApiError, truncateForLog } from './types';

export type AuditErrorOutcome =
  | { kind: 'aborted' }
  | { kind: 'auth-required' }
  | { kind: 'forbidden'; message: string }
  | { kind: 'unexpected'; message: string; logDetail: string };

/**
 * `aborted` must come from the AbortController's own `signal.aborted`, not
 * from pattern-matching the shape of `err` — different Node/undici versions
 * haven't always thrown a real DOMException for a cancelled fetch, so relying
 * on err's type/name can silently misclassify a cancellation as a real failure.
 */
export function mapAuditError(err: unknown, aborted: boolean): AuditErrorOutcome {
  if (aborted) return { kind: 'aborted' };

  if (err instanceof ApiError && err.status === 401) return { kind: 'auth-required' };

  // 403's message is already sanitized in api.ts's safeErrorMessage — these are
  // NestJS's own deliberately user-facing messages (e.g. a plan-upgrade prompt),
  // not raw upstream text, so it's fine to show directly.
  if (err instanceof ApiError && err.status === 403) return { kind: 'forbidden', message: err.message };

  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  return {
    kind: 'unexpected',
    message: 'audit/bench: audit failed unexpectedly — see the "audit/bench" output channel for details.',
    logDetail: truncateForLog(detail),
  };
}
