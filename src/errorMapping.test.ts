import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from './types';
import { mapAuditError } from './errorMapping';

test('an aborted request maps to "aborted" regardless of the error shape', () => {
  // Deliberately pass unrelated error shapes alongside aborted:true — the
  // whole point of the fix is that classification depends only on the
  // signal, never on pattern-matching err's type/name.
  assert.deepEqual(mapAuditError(new Error('anything'), true), { kind: 'aborted' });
  assert.deepEqual(mapAuditError(undefined, true), { kind: 'aborted' });
  assert.deepEqual(mapAuditError(new ApiError(500, 'boom'), true), { kind: 'aborted' });
});

test('a 401 ApiError maps to "auth-required"', () => {
  const outcome = mapAuditError(new ApiError(401, 'No API key set'), false);
  assert.deepEqual(outcome, { kind: 'auth-required' });
});

test('a 403 ApiError maps to "forbidden" and preserves its (already-sanitized) message', () => {
  const outcome = mapAuditError(new ApiError(403, "Repository scanning isn't included in the Free plan."), false);
  assert.deepEqual(outcome, { kind: 'forbidden', message: "Repository scanning isn't included in the Free plan." });
});

test('a generic Error maps to "unexpected" with a safe message and a logged detail', () => {
  const outcome = mapAuditError(new Error('ECONNREFUSED'), false);
  assert.equal(outcome.kind, 'unexpected');
  if (outcome.kind !== 'unexpected') return;
  assert.match(outcome.message, /audit failed unexpectedly/);
  assert.match(outcome.logDetail, /ECONNREFUSED/);
});

test('a non-Error thrown value is still handled without throwing', () => {
  const outcome = mapAuditError('a plain string rejection', false);
  assert.equal(outcome.kind, 'unexpected');
  if (outcome.kind !== 'unexpected') return;
  assert.match(outcome.logDetail, /a plain string rejection/);
});

test('an overly long error detail is truncated before logging', () => {
  const outcome = mapAuditError(new Error('x'.repeat(5000)), false);
  assert.equal(outcome.kind, 'unexpected');
  if (outcome.kind !== 'unexpected') return;
  assert.ok(outcome.logDetail.length < 2100, `expected truncation, got length ${outcome.logDetail.length}`);
  assert.match(outcome.logDetail, /truncated/);
});
