import * as vscode from 'vscode';
import { ApiError, auditFile, getApiKey, setApiKey } from './api';
import { DIAGNOSTIC_SOURCE, findingByDiagnostic, findingToHoverMarkdown, findingsToDiagnostics } from './diagnostics';

const VERDICT_ICON: Record<string, string> = {
  pass: '$(check) pass',
  needs_work: '$(warning) needs work',
  do_not_ship: '$(error) do not ship',
};

export function activate(context: vscode.ExtensionContext) {
  const diagnostics = vscode.languages.createDiagnosticCollection('auditbench');
  context.subscriptions.push(diagnostics);

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'auditbench.auditCurrentFile';
  context.subscriptions.push(statusBar);

  async function runAudit(document: vscode.TextDocument) {
    if (document.uri.scheme !== 'file') return;

    const filename = vscode.workspace.asRelativePath(document.uri, false);
    statusBar.text = '$(sync~spin) audit/bench';
    statusBar.tooltip = `Auditing ${filename}…`;
    statusBar.show();

    try {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `audit/bench: auditing ${filename}` },
        () => auditFile(context, filename, document.getText()),
      );

      diagnostics.set(document.uri, findingsToDiagnostics(result.findings, document));

      statusBar.text = `$(shield) audit/bench: ${VERDICT_ICON[result.verdict] ?? result.verdict}`;
      const costNote =
        result.inputTokens > 0 ? ` (${result.inputTokens + result.outputTokens} tokens)` : ' (no AI credit used)';
      statusBar.tooltip = `${result.summary}${costNote}`;

      if (result.verdict === 'do_not_ship') {
        vscode.window.showErrorMessage(`audit/bench: do not ship — ${result.findings.length} finding(s) in ${filename}`);
      } else if (result.verdict === 'needs_work') {
        vscode.window.showWarningMessage(`audit/bench: needs work — ${result.findings.length} finding(s) in ${filename}`);
      } else {
        vscode.window.showInformationMessage(`audit/bench: pass — no blocking findings in ${filename}`);
      }
    } catch (err) {
      statusBar.text = '$(error) audit/bench';
      if (err instanceof ApiError && err.status === 401) {
        const action = await vscode.window.showErrorMessage(
          'audit/bench: not authenticated. Set an API key to run audits.',
          'Set API Key',
        );
        if (action === 'Set API Key') void vscode.commands.executeCommand('auditbench.setApiKey');
        return;
      }
      if (err instanceof ApiError && err.status === 403) {
        vscode.window.showErrorMessage(`audit/bench: ${err.message}`);
        return;
      }
      vscode.window.showErrorMessage(`audit/bench: audit failed — ${(err as Error).message}`);
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
    }),

    vscode.commands.registerCommand('auditbench.clearFindings', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      diagnostics.delete(editor.document.uri);
      statusBar.hide();
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
    }
  });
}

export function deactivate() {}
