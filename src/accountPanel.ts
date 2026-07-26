import * as vscode from 'vscode';
import { ApiError, getProfile, getUsage, Profile, Usage } from './api';

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function fmtLimit(used: number, limit: number | null): string {
  return limit === null ? `${used} / unlimited` : `${used} / ${limit}`;
}

function pct(used: number, limit: number | null): number {
  if (limit === null || limit === 0) return 0;
  return Math.min(100, Math.round((used / limit) * 100));
}

function fmtResetsAt(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function renderBody(profile: Profile, usage: Usage): string {
  return /* html */ `
    <div class="card">
      <div class="row">
        <div class="avatar">${escapeHtml((profile.name || profile.email).slice(0, 1).toUpperCase())}</div>
        <div>
          <div class="name">${escapeHtml(profile.name || profile.email)}</div>
          <div class="muted">${escapeHtml(profile.email)}</div>
        </div>
        <div class="plan-badge">${escapeHtml(profile.plan.name)}</div>
      </div>
    </div>

    <div class="card">
      <div class="section-title">Daily AI audits</div>
      <div class="bar"><div class="bar-fill" style="width:${pct(usage.dailyUsed, usage.dailyLimit)}%"></div></div>
      <div class="row space-between muted small">
        <span>${fmtLimit(usage.dailyUsed, usage.dailyLimit)}</span>
        <span>resets ${escapeHtml(fmtResetsAt(usage.dailyResetsAt))}</span>
      </div>
    </div>

    <div class="card">
      <div class="section-title">Monthly AI audits</div>
      <div class="bar"><div class="bar-fill" style="width:${pct(usage.monthlyUsed, usage.monthlyLimit)}%"></div></div>
      <div class="row space-between muted small">
        <span>${fmtLimit(usage.monthlyUsed, usage.monthlyLimit)}</span>
        <span>resets ${escapeHtml(fmtResetsAt(usage.monthlyResetsAt))}</span>
      </div>
    </div>

    <div class="card">
      <div class="row space-between">
        <span>Repository scans</span>
        <span class="${usage.plan.repositoryScan ? 'ok' : 'muted'}">${
          usage.plan.repositoryScan ? 'Included on this plan' : 'Not included — upgrade to Pro or higher'
        }</span>
      </div>
    </div>

    <button id="refresh">Refresh</button>
  `;
}

function shell(inner: string): string {
  return /* html */ `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    padding: 16px;
  }
  .card {
    background: var(--vscode-editorWidget-background);
    border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
    border-radius: 6px;
    padding: 12px 14px;
    margin-bottom: 10px;
  }
  .row { display: flex; align-items: center; gap: 10px; }
  .space-between { justify-content: space-between; }
  .avatar {
    width: 32px; height: 32px; border-radius: 50%;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    display: flex; align-items: center; justify-content: center;
    font-weight: 600; flex-shrink: 0;
  }
  .name { font-weight: 600; }
  .muted { color: var(--vscode-descriptionForeground); }
  .small { font-size: 11px; }
  .ok { color: var(--vscode-terminal-ansiGreen, #3fb950); }
  .plan-badge {
    margin-left: auto;
    font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    padding: 3px 8px; border-radius: 10px;
  }
  .section-title { font-size: 11px; text-transform: uppercase; letter-spacing: 0.03em; color: var(--vscode-descriptionForeground); margin-bottom: 8px; }
  .bar {
    height: 6px; border-radius: 3px; overflow: hidden;
    background: var(--vscode-progressBar-background, var(--vscode-widget-border));
    margin-bottom: 6px;
  }
  .bar-fill { height: 100%; background: var(--vscode-button-background); }
  button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none; border-radius: 4px; padding: 6px 14px; cursor: pointer; font-size: 13px;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  .error {
    color: var(--vscode-errorForeground);
    padding: 12px 0;
  }
</style>
</head>
<body>
${inner}
<script>
  const vscode = acquireVsCodeApi();
  document.getElementById('refresh')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'refresh' });
  });
</script>
</body>
</html>`;
}

let panel: vscode.WebviewPanel | undefined;

export function showAccountPanel(context: vscode.ExtensionContext): void {
  if (panel) {
    panel.reveal();
    void refresh(context);
    return;
  }

  panel = vscode.window.createWebviewPanel('auditbenchAccount', 'audit/bench: Account', vscode.ViewColumn.Beside, {
    enableScripts: true,
    retainContextWhenHidden: true,
  });

  panel.onDidDispose(() => {
    panel = undefined;
  });

  panel.webview.onDidReceiveMessage((msg) => {
    if (msg?.type === 'refresh') void refresh(context);
  });

  void refresh(context);
}

/** Called after every audit run too, so quota shown here never goes stale. */
export async function refreshAccountPanel(context: vscode.ExtensionContext): Promise<void> {
  if (panel) await refresh(context);
}

async function refresh(context: vscode.ExtensionContext): Promise<void> {
  if (!panel) return;
  panel.webview.html = shell('<p class="muted">Loading…</p>');
  try {
    const [profile, usage] = await Promise.all([getProfile(context), getUsage(context)]);
    panel.webview.html = shell(renderBody(profile, usage));
  } catch (err) {
    const message =
      err instanceof ApiError && err.status === 401
        ? 'Not authenticated — run "audit/bench: Set API Key" first.'
        : `Failed to load account: ${(err as Error).message}`;
    panel.webview.html = shell(`<div class="error">${escapeHtml(message)}</div><button id="refresh">Retry</button>`);
  }
}
