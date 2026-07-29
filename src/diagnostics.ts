import * as vscode from 'vscode';
import { Finding, Severity } from './api';

const SEVERITY_MAP: Record<Severity, vscode.DiagnosticSeverity> = {
  critical: vscode.DiagnosticSeverity.Error,
  high: vscode.DiagnosticSeverity.Error,
  medium: vscode.DiagnosticSeverity.Warning,
  low: vscode.DiagnosticSeverity.Information,
};

export const DIAGNOSTIC_SOURCE = 'Audit Bench Ai';

/** Stashed alongside each Diagnostic so the hover provider can recover the full finding without re-parsing the message. */
export const findingByDiagnostic = new WeakMap<vscode.Diagnostic, Finding>();

export function findingsToDiagnostics(findings: Finding[], document: vscode.TextDocument): vscode.Diagnostic[] {
  return findings.map((finding) => {
    const lineIndex = finding.line != null ? Math.min(Math.max(finding.line - 1, 0), document.lineCount - 1) : 0;
    const range = document.lineAt(lineIndex).range;

    // The title reads plainly on its own — category/severity shows in the
    // Problems panel's own "source(code)" badge instead of being baked into
    // the message text, the same way a linter's rule ID would be.
    const diagnostic = new vscode.Diagnostic(range, finding.title, SEVERITY_MAP[finding.severity]);
    diagnostic.source = DIAGNOSTIC_SOURCE;
    diagnostic.code = `${finding.category} · ${finding.severity}`;
    findingByDiagnostic.set(diagnostic, finding);
    return diagnostic;
  });
}

/**
 * The backend only ever promises "a short code snippet showing the fix" for
 * examplePatch — never a guarantee of unified-diff format. Rendering it
 * unconditionally as 'diff' mislabels the common case (plain code) as diff
 * context lines, which most themes render dim/monochrome instead of properly
 * syntax-highlighted — this only reaches for 'diff' when the content actually
 * looks like one (real +/-/@@ markers), and otherwise highlights it as the
 * file's own language.
 */
function looksLikeUnifiedDiff(patch: string): boolean {
  const lines = patch.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) return false;
  const diffLines = lines.filter((l) => /^[+\-]/.test(l) || l.startsWith('@@')).length;
  return diffLines / lines.length >= 0.5;
}

export function findingToHoverMarkdown(finding: Finding, languageId: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.isTrusted = false;
  md.appendMarkdown(`**${finding.title}**\n\n`);
  md.appendMarkdown(`\`${finding.category}\` · \`${finding.severity}\` · ${Math.round(finding.confidence * 100)}% confidence\n\n`);
  md.appendMarkdown(`${finding.description}\n\n`);
  md.appendMarkdown(`**Root cause**\n\n${finding.rootCause}\n\n`);
  md.appendMarkdown(`**Suggested fix**\n\n${finding.suggestedFix}\n\n`);
  if (finding.examplePatch) {
    md.appendCodeblock(finding.examplePatch, looksLikeUnifiedDiff(finding.examplePatch) ? 'diff' : languageId);
  }
  return md;
}
