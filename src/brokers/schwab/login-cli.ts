// Non-interactive Schwab login for cloud sessions (pre-approved in
// .claude/settings.json as `Bash(npm run schwab-login *)`).
//
//   npm run schwab-login -- --client-id ID --client-secret SECRET --redirect-uri URL --url
//       prints the Schwab authorize URL; the operator logs in and approves
//   npm run schwab-login -- --code '<the full URL the browser landed on>'
//       exchanges the code for tokens (data/oauth-tokens.json, mode 0600)
//   npm run schwab-login -- --status
//       says whether an app and tokens are on file, and until when
//
// Credentials come from the flags, else SCHWAB_CLIENT_ID / SCHWAB_CLIENT_SECRET /
// SCHWAB_REDIRECT_URI, else data/schwab-app.json. Flags given with --url are
// saved to data/schwab-app.json (mode 0600, gitignored) so --code and later
// scans (`--provider schwab`) find them. Nothing secret is printed or logged.
// Market data only: the session built from these tokens is marketDataOnly.

import * as fs from "node:fs";
import * as path from "node:path";
import { setLogLevel } from "../../core/logger.js";
import { SchwabAuth } from "./auth.js";
import { APP_FILE, loadSchwabApp, type SchwabAppCredentials } from "./app-file.js";

const TOKEN_FILE = path.join("data", "oauth-tokens.json");

function flag(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function resolveApp(argv: readonly string[]): SchwabAppCredentials | null {
  const saved = loadSchwabApp();
  const clientId = flag(argv, "--client-id") ?? process.env.SCHWAB_CLIENT_ID ?? saved?.clientId ?? "";
  const clientSecret = flag(argv, "--client-secret") ?? process.env.SCHWAB_CLIENT_SECRET ?? saved?.clientSecret ?? "";
  const redirectUri = flag(argv, "--redirect-uri") ?? process.env.SCHWAB_REDIRECT_URI ?? saved?.redirectUri ?? "";
  return clientId && clientSecret && redirectUri ? { clientId, clientSecret, redirectUri } : null;
}

function saveApp(app: SchwabAppCredentials): void {
  fs.mkdirSync(path.dirname(APP_FILE), { recursive: true });
  fs.writeFileSync(APP_FILE, JSON.stringify(app, null, 2), { encoding: "utf-8", mode: 0o600 });
  fs.chmodSync(APP_FILE, 0o600);
}

function extractCode(pasted: string): string | null {
  try {
    const code = new URL(pasted).searchParams.get("code");
    if (code) return code;
  } catch {
    // not a full URL; fall through
  }
  const m = pasted.match(/[?&]code=([^&\s]+)/);
  if (m) return decodeURIComponent(m[1]);
  return pasted.length >= 10 && !/\s/.test(pasted) ? pasted : null;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  setLogLevel("warn");
  const app = resolveApp(argv);

  if (argv.includes("--status")) {
    const tokens = fs.existsSync(TOKEN_FILE) ? JSON.parse(fs.readFileSync(TOKEN_FILE, "utf-8")) as { refreshTokenIssuedAt?: number } : null;
    const issued = tokens?.refreshTokenIssuedAt;
    process.stdout.write(`app credentials: ${app ? `on file (redirect ${app.redirectUri})` : "missing"}\n`);
    process.stdout.write(`tokens: ${tokens ? `on file${issued ? `, refresh token issued ${new Date(issued).toISOString().slice(0, 16)}Z, good until about ${new Date(issued + 7 * 86_400_000).toISOString().slice(0, 16)}Z` : ""}` : "missing"}\n`);
    return;
  }
  if (!app) {
    process.stderr.write("Missing credentials: pass --client-id, --client-secret and --redirect-uri (or set SCHWAB_CLIENT_ID, SCHWAB_CLIENT_SECRET, SCHWAB_REDIRECT_URI).\n");
    process.exit(2);
  }
  if (argv.includes("--client-id") || argv.includes("--client-secret") || argv.includes("--redirect-uri")) saveApp(app);
  const auth = new SchwabAuth({ clientId: app.clientId, clientSecret: app.clientSecret, redirectUri: app.redirectUri });

  if (argv.includes("--url")) {
    process.stdout.write(`Open this link, log in to Schwab and approve the app. The browser then lands on a page that will not load; copy that whole address and send it back.\n\n${auth.getAuthorizeUrl()}\n`);
    return;
  }
  const pasted = flag(argv, "--code");
  if (pasted) {
    const code = extractCode(pasted.trim());
    if (!code) { process.stderr.write("Could not find the authorization code in what was pasted.\n"); process.exit(2); }
    await auth.exchangeCode(code);
    process.stdout.write(`Schwab login complete: tokens saved to ${TOKEN_FILE} (mode 0600). The refresh token lasts 7 days.\n`);
    return;
  }
  process.stderr.write("Nothing to do: pass --url, --code '<pasted URL>' or --status.\n");
  process.exit(2);
}

main().catch((err) => {
  // Error text from the token endpoint can echo request details; keep it short and never include secrets.
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`schwab-login failed: ${msg.replace(/[A-Za-z0-9]{40,}/g, "[redacted]").slice(0, 300)}\n`);
  process.exit(1);
});
