# audit/bench for VS Code

AI code review — security, logic, performance, architecture, and test-coverage findings — as inline diagnostics in the editor, backed by the same engine as the web app and CLI.

## What it does

- **`audit/bench: Audit Current File`** — sends the active file to your audit/bench account and shows findings as squiggly underlines (red for critical/high, yellow for medium, blue for low).
- Hover any flagged line for the full finding: description, root cause, suggested fix, and an example patch where available.
- A status bar item shows the last verdict (`pass` / `needs work` / `do not ship`) and how many tokens it cost — nothing if the finding was free (cached or resolved by local checks alone).
- Optional **audit on save** (off by default — audits consume plan quota, so this is opt-in).
- **`audit/bench: Show Account & Usage`** — a panel showing your name/email, plan, and daily/monthly AI-audit quota with reset times. A second status bar item shows a quick glance (e.g. "Pro · 3/50 today") and opens the full panel on click; it refreshes automatically after every audit you run, so quota shown here never goes stale.
- **`audit/bench: Show Logs`** — opens the "audit/bench" output channel. Errors shown in popups are always a short, safe message; the full detail (raw server error bodies, stack traces — capped in length) goes here, never into a message box, since either can contain more than you'd want in something that copy/pastes or screenshots easily.
- **`audit/bench: Fix All Issues with AI`** — a toolbar button (and context-menu entry) that appears once a file has findings. Fixes every finding in one AI pass and applies the result directly to the editor, then re-checks the fixed code and updates the diagnostics to match. See **How "Fix All" actually works** below — it's doing more than it looks like.

This talks to the same `POST /audit`, `GET /me`, `GET /me/usage`, and repo-scan/fix endpoints the CLI and web app use — no separate backend needed.

### How "Fix All" actually works

The backend's AI-fix endpoints are scoped to an existing repo scan (a `ScanJob`) — that's how the web app's fix-in-editor flow works too. A single-file editor audit (`POST /audit`) doesn't create one of those. Rather than needing a backend change, "Fix All" gets a real `ScanJob` to attach to by zipping just the one open file and uploading it through the same repo-scan endpoint the CLI's `auditbench scan` and the web app's repo upload use — a one-file "repo." Concretely, each run does, in order: zip → upload → poll until the scan completes → send every finding to the bulk AI-fix endpoint → apply the returned fixed content to your editor → re-check the fixed code against the same scan. That's up to three separate AI calls (the scan itself, the fix, the recheck) — notably more than a plain "Audit Current File" — so this is never triggered automatically, only by explicitly clicking the button or running the command. It also requires your plan to include repository scanning (the same `repositoryScan` plan flag the CLI's `scan` command needs) — a Free-plan account will get a clear "not included in your plan" message rather than the request silently failing.

If the file changes while the fix is being generated (a real possibility — the round trip can take a while), applying the fix would silently discard those newer edits, so it asks for confirmation first instead.

**On "some findings remain" after a fix:** the recheck step re-audits the whole file from scratch — it's a fresh, independent review, not a check of "were these specific N findings resolved." That means a non-zero finding count afterward doesn't necessarily mean the fix failed on what it was asked to fix; it can just as easily mean the fresh pass noticed something different. The summary message says which one actually happened — "N of the original findings are still there" (the fix genuinely didn't resolve them) versus "a fresh full re-check surfaced M new ones" (the original findings look resolved; these are separate) — using a best-effort title match, since there's no stable ID linking a finding across two independent audit calls.

### A note on what actually gets sent

Auditing a file sends its **full contents** to your configured LLM provider — that's the whole point, but it's easy to forget when you're auditing whatever file happens to be open. Three separate checks run before anything is sent:

1. **A one-time notice** the first time you ever run an audit, explaining that file contents leave your machine. Shown once, not on every run.
2. **A per-file, every-time check** for filenames (`.env`, `id_rsa`, `*.pem`, `credentials.json`, and similar) and content that's *shaped like* a real key or token — an AWS access key, a PEM private key header, a Slack/Stripe/GitHub token, or a hardcoded `apiKey = "..."`-style assignment. This reuses the same rules the backend's own secrets scanner uses, deliberately not a bare word match on "password" or "secret" — that would flag a huge fraction of ordinary code (tests, comments, auth-handling code that's specifically about *not* hardcoding a secret) and train you to click through it without reading. A prior "Continue" on the notice above doesn't cover this — it re-checks every single audit, including ones triggered by auto-save.
3. **A size-based confirmation** for anything over `auditbench.warnAboveChars` (20,000 characters by default), since a large file is also a slower, more expensive request.

None of this is a substitute for judgment — the content check is a heuristic, not a guarantee, and won't catch every way a file can hold something sensitive.

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
| `auditbench.warnAboveChars` | `20000` | Ask for confirmation before auditing a file larger than this many characters. Set to `0` to disable. |

## Building & installing locally

```bash
npm install
npm run compile
npm run package
```

Use `npm run package`, not `npx vsce package` — `npx` can resolve to the old, deprecated standalone `vsce` package on the registry instead of the `@vscode/vsce` installed here, which fails with a confusing "Missing extension name" error. `npm run package` always uses the local one.

This produces `auditbench-vscode-0.1.0.vsix`. Install it with:

```bash
code --install-extension auditbench-vscode-0.1.0.vsix
```

(if `code` isn't recognized, run **"Shell Command: Install 'code' command in PATH"** from VS Code's Command Palette first) — or skip the CLI and use the UI: Extensions panel → `···` menu → **Install from VSIX...**.

## Tests

```bash
npm test
```

Covers three modules with plain `node:test`, no VS Code mocking needed, since all three deliberately have no `vscode` import:

- **`errorMapping.ts`** — cancellation detection, 401/403/unexpected-error handling, and log truncation.
- **`secretsHeuristic.ts`** — real key-shaped content is flagged (AWS keys, PEM headers, Slack/Stripe/GitHub tokens, hardcoded key assignments), legitimate env-var references aren't, and — the case that matters most here — ordinary code that merely *mentions* "password" or "secret" is explicitly asserted **not** to trigger a warning, since that's exactly the false-positive failure mode a naive word-match would have hit.
- **`findingComparison.ts`** — the title-match heuristic "Fix All" uses to tell "this specific finding is still here" apart from "the post-fix recheck surfaced something different" (see **How "Fix All" actually works** above).

These are the parts of the extension's control flow most likely to regress silently or quietly get weaker (a mis-classified error can leak upstream detail into a popup; a loosened secrets pattern either stops catching real keys or starts nagging on everything until people click through it without reading). The command registrations, status bar rendering, and webview panel are UI glue over this logic and are exercised manually (see **Testing it live** below) rather than through automated tests — wiring up `@vscode/test-electron` for real extension-host integration tests would be the next step if this needs more than manual verification.

## Testing it live

Fastest loop while making changes: open this folder in VS Code and press **F5** — compiles the extension and opens a second "Extension Development Host" window with it loaded, breakpoints and all. `Cmd/Ctrl+R` in that window reloads it after you change code, no need to stop and restart. Alternatively, package and install a real `.vsix` as described above and use your normal window.

## What's intentionally not in this first version

- **Fixing a single finding at a time** — only "Fix All" exists; picking one finding out of several to fix on its own would need its own smaller scan-and-fix round trip per finding, which isn't built yet. Hover still shows each finding's suggested fix and example patch as text if you'd rather apply just one by hand.
- **Whole-repo scans from the editor** — `scan` requires zipping a directory and is already well served by the CLI (`auditbench scan .`) or the web app; re-implementing that inside the extension didn't seem worth it for a first pass. "Fix All"'s one-file zip upload is a narrower, purpose-specific use of the same endpoint, not a step toward general repo scanning from here.
- **Auto-publish to the Marketplace** — packaging a `.vsix` is included above; actually publishing needs a Marketplace publisher account and a personal access token, which is a one-time setup step for whoever owns the audit/bench publisher identity, not something this extension can do on its own.
