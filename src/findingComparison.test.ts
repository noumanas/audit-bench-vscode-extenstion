import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareFindings } from './findingComparison';
import { Finding } from './types';

function finding(title: string): Finding {
  return {
    severity: 'medium',
    category: 'Logic',
    title,
    line: 1,
    description: 'd',
    rootCause: 'r',
    suggestedFix: 's',
    examplePatch: null,
    confidence: 0.8,
  };
}

test('no findings after the fix compares as fully resolved', () => {
  assert.deepEqual(compareFindings([finding('Off-by-one in pagination')], []), {
    stillPresentCount: 0,
    newlySurfacedCount: 0,
  });
});

test('a finding with the exact same title afterward counts as still present', () => {
  const result = compareFindings([finding('Off-by-one in pagination')], [finding('Off-by-one in pagination')]);
  assert.deepEqual(result, { stillPresentCount: 1, newlySurfacedCount: 0 });
});

test('title matching is case/whitespace-insensitive', () => {
  const result = compareFindings([finding('Off-by-one in pagination')], [finding('  OFF-BY-ONE IN PAGINATION  ')]);
  assert.deepEqual(result, { stillPresentCount: 1, newlySurfacedCount: 0 });
});

test('a finding with no matching prior title counts as newly surfaced, not still-present', () => {
  const result = compareFindings([finding('Off-by-one in pagination')], [finding('Missing null check on user input')]);
  assert.deepEqual(result, { stillPresentCount: 0, newlySurfacedCount: 1 });
});

test('a mix of matching and non-matching findings is split correctly', () => {
  const before = [finding('Off-by-one in pagination'), finding('SQL built with string concatenation')];
  const after = [
    finding('Off-by-one in pagination'), // still present
    finding('A brand new finding from the fresh recheck'), // newly surfaced
  ];
  assert.deepEqual(compareFindings(before, after), { stillPresentCount: 1, newlySurfacedCount: 1 });
});
