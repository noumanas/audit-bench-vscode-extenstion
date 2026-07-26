import * as vscode from 'vscode';
import { Finding, Severity } from './api';

const SEVERITY_MAP: Record<Severity, vscode.DiagnosticSeverity> = {
  critical: vscode.DiagnosticSeverity.Error,
  high: vscode.DiagnosticSeverity.Error,
  medium: vscode.DiagnosticSeverity.Warning,
  low: vscode.DiagnosticSeverity.Information,
};

export const DIAGNOSTIC_SOURCE = 'audit/bench';

/** Stashed alongside each Diagnostic so the hover provider can recover the full finding without re-parsing the message. */
export const findingByDiagnostic = new WeakMap<vscode.Diagnostic, Finding>();

export function findingsToDiagnostics(findings: Finding[], document: vscode.TextDocument): vscode.Diagnostic[] {
  return findings.map((finding) => {
    const lineIndex = finding.line != null ? Math.min(Math.max(finding.line - 1, 0), document.lineCount - 1) : 0;
    const range = document.lineAt(lineIndex).range;

    const diagnostic = new vscode.Diagnostic(
      range,
      `[${finding.category}] ${finding.title}`,
      SEVERITY_MAP[finding.severity],
    );
    diagnostic.source = DIAGNOSTIC_SOURCE;
    diagnostic.code = finding.severity;
    findingByDiagnostic.set(diagnostic, finding);
    return diagnostic;
  });
}

export function findingToHoverMarkdown(finding: Finding): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.isTrusted = false;
  md.appendMarkdown(`**${finding.title}**\n\n`);
  md.appendMarkdown(`\`${finding.category}\` · \`${finding.severity}\` · ${Math.round(finding.confidence * 100)}% confidence\n\n`);
  md.appendMarkdown(`${finding.description}\n\n`);
  md.appendMarkdown(`**Root cause**\n\n${finding.rootCause}\n\n`);
  md.appendMarkdown(`**Suggested fix**\n\n${finding.suggestedFix}\n\n`);
  if (finding.examplePatch) {
    md.appendCodeblock(finding.examplePatch, 'diff');
  }
  return md;
}
