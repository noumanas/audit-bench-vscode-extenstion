// No `import * as vscode` here on purpose — same reasoning as errorMapping.ts,
// kept unit-testable with plain node:test.
//
// These are the same rules the backend's own secrets scanner uses
// (audit-bench-backend/src/analysis/secrets-scanner.ts) — ported rather than
// reinvented, so the client-side pre-send warning holds to the same
// low-false-positive bar as the server's. A bare word match on "password" or
// "secret" would fire on a huge fraction of ordinary code (tests, comments,
// auth-handling code that's specifically about *not* hardcoding one) and
// train people to click through it without reading — these patterns instead
// look for values *shaped like* a real key/token, not just words about them.

const CONTENT_RULES: { name: string; pattern: RegExp }[] = [
  { name: 'AWS Access Key', pattern: /AKIA[0-9A-Z]{16}/ },
  { name: 'Private Key', pattern: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'Slack Token', pattern: /xox[baprs]-[0-9A-Za-z-]{10,}/ },
  { name: 'Stripe Live Key', pattern: /sk_live_[0-9A-Za-z]{16,}/ },
  { name: 'GitHub Token', pattern: /gh[pousr]_[0-9A-Za-z]{20,}/ },
  {
    name: 'Hardcoded API/Secret Key',
    pattern: /(api|secret|access)[_-]?key\s*[:=]\s*['"][A-Za-z0-9\-_/+=]{16,}['"]/i,
  },
];

// A reference to an out-of-band secret (env var, template interpolation) is
// the opposite of a hardcoded one — skip lines that are clearly that.
const SKIP_PATTERNS = [/process\.env/, /import\.meta\.env/, /\$\{/, /os\.environ/];

// Common filenames/extensions that are almost always secret material
// themselves, regardless of what's inside — checked separately from content,
// since e.g. a `.pem` file's *content* is just base64 that won't match the
// content rules above but the file itself is the secret.
const SENSITIVE_FILENAME_PATTERNS: RegExp[] = [
  /(^|[/\\])\.env(\..+)?$/i,
  /(^|[/\\])id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|pfx|p12|jks)$/i,
  /(^|[/\\])(credentials|secrets?|serviceaccount[^/\\]*)\.(json|ya?ml)$/i,
];

export interface LikelySecret {
  rule: string;
  line: number;
}

/** Checked independent of file size — a small file can still hold a real secret. */
export function filenameLooksSensitive(relativePath: string): boolean {
  return SENSITIVE_FILENAME_PATTERNS.some((p) => p.test(relativePath));
}

/** Returns the first match found (if any) — enough to warn on, no need to enumerate every hit. */
export function findLikelySecret(code: string): LikelySecret | undefined {
  const lines = code.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (SKIP_PATTERNS.some((p) => p.test(line))) continue;
    for (const rule of CONTENT_RULES) {
      if (rule.pattern.test(line)) return { rule: rule.name, line: i + 1 };
    }
  }
  return undefined;
}
