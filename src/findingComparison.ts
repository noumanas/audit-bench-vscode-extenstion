// No `import * as vscode` here on purpose — same reasoning as the other
// pure modules (errorMapping.ts, secretsHeuristic.ts).

import { Finding } from './types';

export interface FindingComparison {
  /** Findings after the fix whose title exactly matches one from before the fix — very likely the same issue, still there. */
  stillPresentCount: number;
  /** Findings after the fix with no matching title beforehand — likely surfaced by the recheck's fresh, independent full audit, not a failure to fix what was targeted. */
  newlySurfacedCount: number;
}

function normalizeTitle(title: string): string {
  return title.trim().toLowerCase();
}

/**
 * recheckFix runs a completely fresh, independent audit of the fixed code —
 * it does not verify "were these N specific findings resolved," it just
 * re-reviews the whole file from scratch. So a non-zero finding count
 * afterward doesn't necessarily mean the fix failed; it can just as easily
 * mean the fresh pass noticed something different. This is a best-effort
 * heuristic (title match only, no stable finding IDs exist across two
 * independent audit calls) to tell those two cases apart for the user
 * instead of lumping them together as an undifferentiated "issues remain."
 */
export function compareFindings(before: Finding[], after: Finding[]): FindingComparison {
  const beforeTitles = new Set(before.map((f) => normalizeTitle(f.title)));
  let stillPresentCount = 0;
  for (const finding of after) {
    if (beforeTitles.has(normalizeTitle(finding.title))) stillPresentCount++;
  }
  return { stillPresentCount, newlySurfacedCount: after.length - stillPresentCount };
}
