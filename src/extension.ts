import * as vscode from 'vscode';
import { auditFile, getApiKey, getUsage, outputChannel, setApiKey } from './api';
import { DIAGNOSTIC_SOURCE, findingByDiagnostic, findingToHoverMarkdown, findingsToDiagnostics } from './diagnostics';
import { refreshAccountPanel, showAccountPanel } from './accountPanel';
import { AuditErrorOutcome, mapAuditError } from './errorMapping';
import { filenameLooksSensitive, findLikelySecret } from './secretsHeuristic';
import { runFixAll } from './fixAll';

const HAS_SHOWN_SEND_NOTICE_KEY = 'auditbench.hasShownSendNotice';

const VERDICT_ICON: Record<string, string> = {
  pass: '$(check) pass',
  needs_work: '$(warning) needs work',
  do_not_ship: '$(error) do not ship',
};

type FileStatus =
  | { kind: 'auditing' }
  | { kind: 'error' }
  | { kind: 'result'; verdict: 'pass' | 'needs_work' | 'do_not_ship'; tooltip: string };

export function activate(context: vscode.ExtensionContext) {
  const diagnostics = vscode.languages.createDiagnosticCollection('auditbench');
  context.subscriptions.push(diagnostics);
  context.subscriptions.push(outputChannel);

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'auditbench.auditCurrentFile';
  context.subscriptions.push(statusBar);

  // Single source of truth, keyed by document URI. The status bar is one
  // shared UI element for every open file, so instead of writing to it from
  // several call sites (each guessing whether its file is still the active
  // one), every call site just records what happened for ITS file here, and
  // renderStatusBar() below is the only place that ever touches `statusBar`
  // — always driven by whichever document is active *right now*, including
  // on tab switches, which the old per-call-site checks couldn't see.
  const statusByUri = new Map<string, FileStatus>();

  function renderStatusBar() {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc) {
      statusBar.hide();
      return;
    }
    const status = statusByUri.get(doc.uri.toString());
    if (!status) {
      statusBar.hide();
      return;
    }
    if (status.kind === 'auditing') {
      statusBar.text = '$(sync~spin) audit/bench';
      statusBar.tooltip = `Auditing ${vscode.workspace.asRelativePath(doc.uri, false)}…`;
    } else if (status.kind === 'error') {
      statusBar.text = '$(error) audit/bench';
      statusBar.tooltip = 'Audit failed — see the "audit/bench" output channel for details.';
    } else {
      statusBar.text = `$(shield) audit/bench: ${VERDICT_ICON[status.verdict] ?? status.verdict}`;
      statusBar.tooltip = status.tooltip;
    }
    statusBar.show();
  }

  // Drives the "Fix All" toolbar button's visibility — only worth showing
  // once there's something to fix, for whichever file is actually active.
  function updateHasFindingsContext() {
    const doc = vscode.window.activeTextEditor?.document;
    const count = doc ? (diagnostics.get(doc.uri)?.length ?? 0) : 0;
    void vscode.commands.executeCommand('setContext', 'auditbench.hasFindings', count > 0);
  }

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => {
      renderStatusBar();
      updateHasFindingsContext();
    }),
  );

  // Quick-glance plan/quota — separate from the verdict item above, always visible once authenticated.
  const accountStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  accountStatusBar.command = 'auditbench.showAccount';
  context.subscriptions.push(accountStatusBar);

  async function refreshAccountStatusBar() {
    const apiKey = await getApiKey(context);
    if (!apiKey) {
      accountStatusBar.hide();
      return;
    }
    try {
      const usage = await getUsage(context);
      accountStatusBar.text = `$(account) ${usage.plan.name} · ${usage.dailyUsed}/${usage.dailyLimit ?? '∞'} today`;
      accountStatusBar.tooltip = 'Click to view account & usage';
      accountStatusBar.show();
    } catch {
      // Non-critical — the panel itself will surface a clearer error if the user opens it.
      accountStatusBar.hide();
    }
    void refreshAccountPanel(context);
  }

  // Keyed by document URI — lets a new audit for the same file cancel an older
  // one still in flight, instead of both racing to write the same diagnostics
  // out of order (and paying for an LLM call whose result gets thrown away
  // regardless).
  const inFlightByUri = new Map<string, AbortController>();

  function setStatus(document: vscode.TextDocument, status: FileStatus) {
    statusByUri.set(document.uri.toString(), status);
    renderStatusBar();
  }

  /**
   * The whole point of this extension is sending file contents to a remote
   * service — that's easy to lose sight of, especially for a file that
   * happens to hold a secret, credential, or other sensitive data. Three
   * layers, in order: a generic notice shown once ever; a per-file, every-time
   * check against filename/content patterns that look like real key material
   * (not just words like "password" — see secretsHeuristic.ts for why that
   * distinction matters); and a size-based confirmation for unusually large
   * files. Only the first is one-time — a prior "Continue" isn't consent for
   * a *different* file that happens to hold an actual credential.
   */
  async function confirmSendToApi(document: vscode.TextDocument, code: string): Promise<boolean> {
    if (!context.globalState.get<boolean>(HAS_SHOWN_SEND_NOTICE_KEY, false)) {
      const choice = await vscode.window.showInformationMessage(
        'audit/bench sends the full contents of the file you audit to your configured LLM provider for review. Avoid auditing files containing secrets, credentials, or other data you don\'t want leaving your machine.',
        { modal: true },
        'Continue',
      );
      if (choice !== 'Continue') return false;
      await context.globalState.update(HAS_SHOWN_SEND_NOTICE_KEY, true);
    }

    // Unlike the notice above, this re-checks every single time — a small,
    // ordinary-looking file can still contain a real key, so a one-time
    // acknowledgment from days ago isn't consent for this specific file.
    const filename = vscode.workspace.asRelativePath(document.uri, false);
    const likelySecret = findLikelySecret(code);
    if (filenameLooksSensitive(filename) || likelySecret) {
      const reason = likelySecret
        ? `${filename} appears to contain a ${likelySecret.rule} on line ${likelySecret.line}`
        : `${filename}'s name suggests it may hold credentials or key material`;
      const choice = await vscode.window.showWarningMessage(
        `${reason}. Send it to the audit service anyway?`,
        { modal: true },
        'Send Anyway',
      );
      if (choice !== 'Send Anyway') return false;
    }

    const warnAboveChars = vscode.workspace.getConfiguration('auditbench').get<number>('warnAboveChars') ?? 20_000;
    if (warnAboveChars > 0 && code.length > warnAboveChars) {
      const choice = await vscode.window.showWarningMessage(
        `${filename} is ${code.length.toLocaleString()} characters — its full contents will be sent to the audit service. Continue?`,
        { modal: true },
        'Audit',
      );
      if (choice !== 'Audit') return false;
    }

    return true;
  }

  /** Shared by runAudit and the "Fix All" command — the aborted case is handled by the caller before this is reached. */
  async function reportAuditError(
    document: vscode.TextDocument,
    filename: string,
    outcome: Exclude<AuditErrorOutcome, { kind: 'aborted' }>,
  ): Promise<void> {
    setStatus(document, { kind: 'error' });

    if (outcome.kind === 'auth-required') {
      const action = await vscode.window.showErrorMessage(
        'audit/bench: not authenticated. Set an API key to run audits.',
        'Set API Key',
      );
      if (action === 'Set API Key') void vscode.commands.executeCommand('auditbench.setApiKey');
      return;
    }
    if (outcome.kind === 'forbidden') {
      vscode.window.showErrorMessage(`audit/bench: ${outcome.message}`);
      return;
    }
    outputChannel.appendLine(`Unexpected error for ${filename}: ${outcome.logDetail}`);
    vscode.window.showErrorMessage(outcome.message);
  }

  async function runAudit(document: vscode.TextDocument) {
    if (document.uri.scheme !== 'file') return;

    const code = document.getText();
    if (!(await confirmSendToApi(document, code))) return;

    const uriKey = document.uri.toString();
    inFlightByUri.get(uriKey)?.abort();
    const controller = new AbortController();
    inFlightByUri.set(uriKey, controller);

    const filename = vscode.workspace.asRelativePath(document.uri, false);
    setStatus(document, { kind: 'auditing' });

    try {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `audit/bench: auditing ${filename}` },
        () => auditFile(context, filename, code, controller.signal),
      );

      // If a newer audit for this same file has since started, its result
      // should win, not this now-stale one (belt-and-suspenders alongside
      // the abort above — diagnostics are keyed per-URI too, same reasoning).
      if (inFlightByUri.get(uriKey) !== controller) return;

      diagnostics.set(document.uri, findingsToDiagnostics(result.findings, document));
      updateHasFindingsContext();

      const costNote =
        result.inputTokens > 0 ? ` (${result.inputTokens + result.outputTokens} tokens)` : ' (no AI credit used)';
      setStatus(document, { kind: 'result', verdict: result.verdict, tooltip: `${result.summary}${costNote}` });

      if (result.verdict === 'do_not_ship') {
        vscode.window.showErrorMessage(`audit/bench: do not ship — ${result.findings.length} finding(s) in ${filename}`);
      } else if (result.verdict === 'needs_work') {
        vscode.window.showWarningMessage(`audit/bench: needs work — ${result.findings.length} finding(s) in ${filename}`);
      } else {
        vscode.window.showInformationMessage(`audit/bench: pass — no blocking findings in ${filename}`);
      }

      // This run may have just spent quota — keep the glance and the open panel (if any) in sync.
      void refreshAccountStatusBar();
    } catch (err) {
      const outcome = mapAuditError(err, controller.signal.aborted);
      if (outcome.kind === 'aborted') return; // Superseded by a newer audit of the same file — not a real failure.
      await reportAuditError(document, filename, outcome);
    } finally {
      if (inFlightByUri.get(uriKey) === controller) inFlightByUri.delete(uriKey);
    }
  }

  async function runFixAllCommand(document: vscode.TextDocument) {
    if (document.uri.scheme !== 'file') return;

    const code = document.getText();
    if (!(await confirmSendToApi(document, code))) return;

    const uriKey = document.uri.toString();
    inFlightByUri.get(uriKey)?.abort();
    const controller = new AbortController();
    inFlightByUri.set(uriKey, controller);

    const filename = vscode.workspace.asRelativePath(document.uri, false);
    setStatus(document, { kind: 'auditing' });

    try {
      const outcome = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `audit/bench: fixing ${filename}` },
        (progress) => runFixAll(context, filename, code, controller.signal, (message) => progress.report({ message })),
      );

      if (inFlightByUri.get(uriKey) !== controller) return;

      if (outcome.kind === 'no-findings') {
        setStatus(document, { kind: 'result', verdict: 'pass', tooltip: 'No issues found — nothing to fix.' });
        vscode.window.showInformationMessage(`audit/bench: no issues found in ${filename} — nothing to fix.`);
        return;
      }

      // This can take long enough (a scan, a fix pass, and a recheck are all
      // sequential LLM-involving round trips) that the user may have kept
      // editing — applying a fix computed against a stale snapshot would
      // silently discard whatever they typed since.
      if (document.getText() !== code) {
        const choice = await vscode.window.showWarningMessage(
          `${filename} was edited while the fix was being generated — applying it now would discard those newer changes. Apply anyway?`,
          { modal: true },
          'Apply Anyway',
        );
        if (choice !== 'Apply Anyway') {
          setStatus(document, {
            kind: 'result',
            verdict: outcome.after.verdict,
            tooltip: 'Fix generated but not applied — the file changed during the operation.',
          });
          return;
        }
      }

      const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
      const edit = new vscode.WorkspaceEdit();
      edit.replace(document.uri, fullRange, outcome.fixedCode);
      await vscode.workspace.applyEdit(edit);

      diagnostics.set(document.uri, findingsToDiagnostics(outcome.after.findings, document));
      updateHasFindingsContext();
      setStatus(document, { kind: 'result', verdict: outcome.after.verdict, tooltip: outcome.explanation });

      const remaining = outcome.after.findings.length;
      const summary = `Fixed ${outcome.originalFindingsCount} finding(s) in ${filename}${outcome.resolved ? ' — all clear now.' : ` — ${remaining} remain, review before committing.`} ${outcome.explanation}`;
      if (outcome.resolved) {
        vscode.window.showInformationMessage(`audit/bench: ${summary}`);
      } else {
        vscode.window.showWarningMessage(`audit/bench: ${summary}`);
      }

      // This spent quota for the scan, the fix, and the recheck — keep usage in sync.
      void refreshAccountStatusBar();
    } catch (err) {
      const outcome = mapAuditError(err, controller.signal.aborted);
      if (outcome.kind === 'aborted') return;
      await reportAuditError(document, filename, outcome);
    } finally {
      if (inFlightByUri.get(uriKey) === controller) inFlightByUri.delete(uriKey);
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('auditbench.auditCurrentFile', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('audit/bench: open a file to audit first.');
        return;
      }
      await runAudit(editor.document);
    }),

    vscode.commands.registerCommand('auditbench.fixAllWithAi', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('audit/bench: open a file to fix first.');
        return;
      }
      await runFixAllCommand(editor.document);
    }),

    vscode.commands.registerCommand('auditbench.setApiKey', async () => {
      const key = await vscode.window.showInputBox({
        title: 'audit/bench API key',
        prompt: 'Paste your API key (Dashboard → Integrations → CLI / CI-CD API key)',
        password: true,
        ignoreFocusOut: true,
        validateInput: (value) => (value.startsWith('abk_') ? undefined : 'audit/bench API keys start with "abk_"'),
      });
      if (!key) return;
      await setApiKey(context, key);
      vscode.window.showInformationMessage('audit/bench: API key saved.');
      void refreshAccountStatusBar();
    }),

    vscode.commands.registerCommand('auditbench.clearFindings', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      diagnostics.delete(editor.document.uri);
      statusByUri.delete(editor.document.uri.toString());
      updateHasFindingsContext();
      statusBar.hide();
    }),

    vscode.commands.registerCommand('auditbench.showAccount', () => {
      showAccountPanel(context);
    }),

    vscode.commands.registerCommand('auditbench.showLogs', () => {
      outputChannel.show();
    }),

    vscode.languages.registerHoverProvider(
      { scheme: 'file' },
      {
        provideHover(document, position) {
          const atLine = diagnostics.get(document.uri)?.filter((d) => d.range.contains(position) && d.source === DIAGNOSTIC_SOURCE);
          if (!atLine || atLine.length === 0) return undefined;

          const contents = atLine
            .map((d) => findingByDiagnostic.get(d))
            .filter((f): f is NonNullable<typeof f> => Boolean(f))
            .map(findingToHoverMarkdown);
          if (contents.length === 0) return undefined;

          return new vscode.Hover(contents);
        },
      },
    ),

    vscode.workspace.onDidSaveTextDocument((document) => {
      if (vscode.workspace.getConfiguration('auditbench').get<boolean>('auditOnSave')) {
        void runAudit(document);
      }
    }),
  );

  void getApiKey(context).then((key) => {
    if (!key) {
      statusBar.text = '$(shield) audit/bench: no API key';
      statusBar.tooltip = 'Click to set your API key, or run "audit/bench: Set API Key"';
      statusBar.command = 'auditbench.setApiKey';
      statusBar.show();
      return;
    }
    void refreshAccountStatusBar();
  });
}

export function deactivate() {}
