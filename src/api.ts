import * as vscode from 'vscode';
import {
  AiFixAllResult,
  ApiError,
  AuditResult,
  Finding,
  Profile,
  RecheckFixResult,
  ScanJobResult,
  Usage,
  truncateForLog,
} from './types';

export * from './types';

/**
 * Full raw response bodies (which can include stack traces, gateway/proxy
 * error pages, or other backend-internal detail) are logged here, never
 * surfaced directly in a user-facing popup — see parseErrorMessage below.
 */
export const outputChannel = vscode.window.createOutputChannel('Audit Bench Ai');

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

async function apiFetch<T>(context: vscode.ExtensionContext, path: string, init?: RequestInit): Promise<T> {
  const apiKey = await getApiKey(context);
  if (!apiKey) {
    throw new ApiError(401, 'No API key set — run "Audit Bench Ai: Set API Key" first.');
  }

  // A FormData body (multipart file upload) needs fetch to set its own
  // boundary-bearing content-type header — forcing application/json on it
  // would send a body the server can't parse.
  const isFormData = typeof FormData !== 'undefined' && init?.body instanceof FormData;

  const res = await fetch(`${apiUrl()}${path}`, {
    ...init,
    headers: {
      ...(isFormData ? {} : { 'content-type': 'application/json' }),
      authorization: `Bearer ${apiKey}`,
      ...init?.headers,
    },
  });

  if (!res.ok) {
    throw new ApiError(res.status, await safeErrorMessage(res));
  }

  return (await res.json()) as T;
}

/**
 * The raw response body is never shown to the user directly — it can be an
 * HTML gateway error page, a stack trace, or other backend-internal detail.
 * NestJS's own thrown exceptions (the ones actually meant to be read by a
 * user, e.g. "Repository scanning isn't included in the Free plan") come
 * back as `{ message: string | string[] }` JSON, so that shape is trusted
 * and surfaced; anything else falls back to a generic, status-only message.
 * The full raw body always goes to the output channel for debugging.
 */
async function safeErrorMessage(res: Response): Promise<string> {
  const raw = await res.text().catch(() => '');
  outputChannel.appendLine(`[${res.status}] ${res.url}\n${truncateForLog(raw)}`);

  try {
    const parsed = JSON.parse(raw);
    const message = parsed?.message;
    if (typeof message === 'string') return message;
    if (Array.isArray(message) && message.every((m) => typeof m === 'string')) return message.join('; ');
  } catch {
    // Not JSON — an HTML error page or similar. Don't show it verbatim.
  }
  return `Server error (${res.status}) — see the "Audit Bench Ai" output channel for details.`;
}

// Matches the backend's own @MaxLength(200000) on CreateAuditDto.code — refusing
// locally means a too-large file fails instantly instead of after a round trip.
export const MAX_AUDIT_CHARS = 200_000;

export async function auditFile(
  context: vscode.ExtensionContext,
  filename: string,
  code: string,
  signal?: AbortSignal,
): Promise<AuditResult> {
  if (code.length > MAX_AUDIT_CHARS) {
    throw new ApiError(413, `File is too large to audit (${code.length.toLocaleString()} characters, limit ${MAX_AUDIT_CHARS.toLocaleString()}).`);
  }
  const provider = vscode.workspace.getConfiguration('auditbench').get<string>('provider') || undefined;
  return apiFetch<AuditResult>(context, '/audit', {
    method: 'POST',
    body: JSON.stringify({ filename, code, provider }),
    signal,
  });
}

export function getProfile(context: vscode.ExtensionContext): Promise<Profile> {
  return apiFetch<Profile>(context, '/me');
}

export function getUsage(context: vscode.ExtensionContext): Promise<Usage> {
  return apiFetch<Usage>(context, '/me/usage');
}

/**
 * "Fix all" needs a real ScanJob to attach fixes to — the single-file
 * /audit endpoint above doesn't create one. Uploading a one-file zip through
 * the same repo-scan endpoint the CLI and web app use gets a real ScanJob
 * without any backend changes; the fix/recheck endpoints below are scoped
 * to it by :scanJobId exactly like a normal repo scan's would be.
 */
export async function startSingleFileScan(
  context: vscode.ExtensionContext,
  zipBuffer: Buffer,
  filename: string,
  signal?: AbortSignal,
): Promise<ScanJobResult> {
  const provider = vscode.workspace.getConfiguration('auditbench').get<string>('provider') || undefined;
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(zipBuffer)]), filename);
  if (provider) form.append('provider', provider);
  return apiFetch<ScanJobResult>(context, '/repository', { method: 'POST', body: form, signal });
}

export function getScan(context: vscode.ExtensionContext, scanJobId: string, signal?: AbortSignal): Promise<ScanJobResult> {
  return apiFetch<ScanJobResult>(context, `/repository/${scanJobId}`, { signal });
}

export function aiFixAll(
  context: vscode.ExtensionContext,
  scanJobId: string,
  path: string,
  content: string,
  findings: Finding[],
  signal?: AbortSignal,
): Promise<AiFixAllResult> {
  return apiFetch<AiFixAllResult>(context, `/repository/${scanJobId}/fix/ai/all`, {
    method: 'POST',
    body: JSON.stringify({ path, content, findings }),
    signal,
  });
}

export function recheckFix(
  context: vscode.ExtensionContext,
  scanJobId: string,
  path: string,
  content: string,
  signal?: AbortSignal,
): Promise<RecheckFixResult> {
  return apiFetch<RecheckFixResult>(context, `/repository/${scanJobId}/fix/recheck`, {
    method: 'POST',
    body: JSON.stringify({ path, content }),
    signal,
  });
}
