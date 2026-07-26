# audit/bench for VS Code

AI code review — security, logic, performance, architecture, and test-coverage findings — as inline diagnostics in the editor, backed by the same engine as the web app and CLI.

## What it does

- **`audit/bench: Audit Current File`** — sends the active file to your audit/bench account and shows findings as squiggly underlines (red for critical/high, yellow for medium, blue for low).
- Hover any flagged line for the full finding: description, root cause, suggested fix, and an example patch where available.
- A status bar item shows the last verdict (`pass` / `needs work` / `do not ship`) and how many tokens it cost — nothing if the finding was free (cached or resolved by local checks alone).
- Optional **audit on save** (off by default — audits consume plan quota, so this is opt-in).

This talks to the same `POST /audit` endpoint the CLI and web app use — no separate backend needed.

## Setup

1. Install the extension (see **Building & installing locally** below until this is published to the Marketplace).
2. Run **audit/bench: Set API Key** from the Command Palette (`Cmd/Ctrl+Shift+P`). Get your key from the web app: Dashboard → Integrations → "CLI / CI-CD API key". It's stored in VS Code's encrypted secret storage, not in a plain settings file.
3. Open a file and run **audit/bench: Audit Current File**.

By default this points at the production API. To test against a local backend instead, set `auditbench.apiUrl` in your VS Code settings to `http://localhost:4000`.

## Settings

| Setting | Default | Description |
|---|---|---|
| `auditbench.apiUrl` | production URL | API base URL — override for local backend testing |
| `auditbench.provider` | (account default) | Force a specific LLM provider: `anthropic`, `openai`, or `gemini` |
| `auditbench.auditOnSave` | `false` | Automatically audit a file every time you save it |

## Building & installing locally

```bash
npm install
npm run compile
npx vsce package
```

This produces `auditbench-vscode-0.1.0.vsix`. Install it with:

```bash
code --install-extension auditbench-vscode-0.1.0.vsix
```

or from VS Code: Extensions panel → `···` menu → **Install from VSIX...**.

## What's intentionally not in this first version

- **Fix with AI** — the existing `/repository/:scanJobId/fix/ai` endpoint requires an existing repo scan (`ScanJob`) to attach the fix to; a standalone single-file audit from the editor doesn't have one. Hover shows the suggested fix and example patch as text so you can apply it yourself. Wiring up an editor-native fix flow is a natural next step, not a limitation of the API.
- **Whole-repo scans from the editor** — `scan` requires zipping a directory and is already well served by the CLI (`auditbench scan .`) or the web app; re-implementing that inside the extension didn't seem worth it for a first pass.
- **Auto-publish to the Marketplace** — packaging a `.vsix` is included above; actually publishing needs a Marketplace publisher account and a personal access token, which is a one-time setup step for whoever owns the audit/bench publisher identity, not something this extension can do on its own.
# audit-bench-vscode-extenstion
