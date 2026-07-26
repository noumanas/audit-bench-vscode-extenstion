// Deliberately has no `import * as vscode` — kept importable from a plain
// `node:test` run with no extension-host mocking, so the pure logic in
// errorMapping.ts (and its tests) can depend on this without dragging in
// the vscode module.

export type Severity = 'critical' | 'high' | 'medium' | 'low';

export interface Finding {
  severity: Severity;
  category: string;
  title: string;
  line: number | null;
  description: string;
  rootCause: string;
  suggestedFix: string;
  examplePatch: string | null;
  confidence: number;
}

export interface AuditResult {
  verdict: 'pass' | 'needs_work' | 'do_not_ship';
  summary: string;
  findings: Finding[];
  aiInvoked: boolean;
  fromCache: boolean;
  inputTokens: number;
  outputTokens: number;
}

export interface Plan {
  slug: string;
  name: string;
  dailyAuditLimit: number | null;
  monthlyAuditLimit: number | null;
  repositoryScan: boolean;
}

export interface Profile {
  id: string;
  email: string;
  name: string | null;
  plan: Plan;
}

export interface Usage {
  plan: Plan;
  dailyUsed: number;
  dailyLimit: number | null;
  monthlyUsed: number;
  monthlyLimit: number | null;
  dailyResetsAt: string;
  monthlyResetsAt: string;
}

export interface ScanFileResult {
  id: string;
  path: string;
  verdict: 'pass' | 'needs_work' | 'do_not_ship' | null;
  findings: Finding[];
}

export interface ScanJobResult {
  id: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  provider: string;
  error: string | null;
  files?: ScanFileResult[];
}

export interface AiFixAllResult {
  /** The full file content with every targeted finding fixed — replaces the editor's content wholesale. */
  fixedCode: string;
  explanation: string;
}

export interface RecheckFixResult {
  before: { verdict: string | null; findingsCount: number };
  after: { verdict: 'pass' | 'needs_work' | 'do_not_ship'; findings: Finding[] };
  resolved: boolean;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const MAX_LOGGED_DETAIL_CHARS = 2000;

/** Caps how much of any single error/response body ever lands in the output channel — it's opt-in to view, but not unbounded. */
export function truncateForLog(text: string): string {
  return text.length > MAX_LOGGED_DETAIL_CHARS ? `${text.slice(0, MAX_LOGGED_DETAIL_CHARS)}… (truncated)` : text;
}
