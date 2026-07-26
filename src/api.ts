import * as vscode from 'vscode';

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

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const SECRET_KEY = 'auditbench.apiKey';

export async function getApiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
  return context.secrets.get(SECRET_KEY);
}

export async function setApiKey(context: vscode.ExtensionContext, key: string): Promise<void> {
  await context.secrets.store(SECRET_KEY, key);
}

function apiUrl(): string {
  return vscode.workspace.getConfiguration('auditbench').get<string>('apiUrl')!.replace(/\/$/, '');
}

export async function auditFile(
  context: vscode.ExtensionContext,
  filename: string,
  code: string,
): Promise<AuditResult> {
  const apiKey = await getApiKey(context);
  if (!apiKey) {
    throw new ApiError(401, 'No API key set — run "audit/bench: Set API Key" first.');
  }

  const provider = vscode.workspace.getConfiguration('auditbench').get<string>('provider') || undefined;

  const res = await fetch(`${apiUrl()}/audit`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ filename, code, provider }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new ApiError(res.status, text);
  }

  return (await res.json()) as AuditResult;
}
