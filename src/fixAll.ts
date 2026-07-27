import AdmZip from 'adm-zip';
import * as vscode from 'vscode';
import { aiFixAll, getScan, recheckFix, startSingleFileScan } from './api';
import { compareFindings } from './findingComparison';
import { Finding, ScanJobResult } from './types';

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

export type FixAllOutcome =
  | { kind: 'no-findings' }
  | {
      kind: 'fixed';
      fixedCode: string;
      explanation: string;
      originalFindingsCount: number;
      after: { verdict: 'pass' | 'needs_work' | 'do_not_ship'; findings: Finding[] };
      resolved: boolean;
      /** How many of the findings shown after the fix look like the same ones from before, vs new ones the fresh recheck surfaced — see findingComparison.ts. */
      stillPresentCount: number;
      newlySurfacedCount: number;
    };

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new Error('Aborted'));
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('Aborted'));
    });
  });
}

/** A zip of exactly one file — the repo-scan endpoint doesn't care that it's not a whole repo. */
function zipSingleFile(relativePath: string, content: string): Buffer {
  const zip = new AdmZip();
  zip.addFile(relativePath, Buffer.from(content, 'utf8'));
  return zip.toBuffer();
}

async function waitForScanCompletion(
  context: vscode.ExtensionContext,
  scanJobId: string,
  signal: AbortSignal,
  onProgress: (message: string) => void,
): Promise<ScanJobResult> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const job = await getScan(context, scanJobId, signal);
    if (job.status === 'completed' || job.status === 'failed') return job;
    onProgress(`Scanning… (${job.status})`);
    await sleep(POLL_INTERVAL_MS, signal);
  }
  throw new Error('Timed out waiting for the scan to complete.');
}

/**
 * The whole "fix + re-audit" loop, driven from a single open file instead of
 * a pre-existing repo scan: zip the live editor content as a one-file scan
 * (so there's a real ScanJob to attach fixes to — the plain /audit endpoint
 * doesn't create one), wait for it, bulk-fix every finding in one AI pass,
 * then re-check the fixed code against the same scan context.
 *
 * Costs multiple LLM calls (the scan itself, the bulk fix, and the recheck)
 * — notably more than a single "Audit Current File" — so this is only ever
 * invoked from an explicit user action, never automatically.
 */
export async function runFixAll(
  context: vscode.ExtensionContext,
  relativePath: string,
  code: string,
  signal: AbortSignal,
  onProgress: (message: string) => void,
): Promise<FixAllOutcome> {
  onProgress('Zipping file…');
  const zipBuffer = zipSingleFile(relativePath, code);
  const zipName = `${relativePath.replace(/[\\/]/g, '_')}.zip`;

  onProgress('Uploading for scan…');
  const started = await startSingleFileScan(context, zipBuffer, zipName, signal);

  onProgress('Scanning…');
  const finished = await waitForScanCompletion(context, started.id, signal, onProgress);
  if (finished.status === 'failed') {
    throw new Error(finished.error || 'Scan failed.');
  }

  const scanFile = finished.files?.find((f) => f.path === relativePath) ?? finished.files?.[0];
  const findings = scanFile?.findings ?? [];
  if (findings.length === 0) {
    return { kind: 'no-findings' };
  }

  onProgress(`Fixing ${findings.length} finding${findings.length === 1 ? '' : 's'}…`);
  const fix = await aiFixAll(context, finished.id, relativePath, code, findings, signal);

  onProgress('Re-checking the fix…');
  const recheck = await recheckFix(context, finished.id, relativePath, fix.fixedCode, signal);
  const comparison = compareFindings(findings, recheck.after.findings);

  return {
    kind: 'fixed',
    fixedCode: fix.fixedCode,
    explanation: fix.explanation,
    originalFindingsCount: findings.length,
    after: recheck.after,
    resolved: recheck.resolved,
    stillPresentCount: comparison.stillPresentCount,
    newlySurfacedCount: comparison.newlySurfacedCount,
  };
}
