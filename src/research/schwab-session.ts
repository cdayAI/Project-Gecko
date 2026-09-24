// Shared Schwab session detection for research CLIs.
//
// Returns a ready SchwabRest when the Schwab Trader API is requested or
// auto-detected. Credential sources in order: the Windows DPAPI vault saved
// by the local Schwab setup (see docs/schwab-windows-scanner.md), then
// SCHWAB_CLIENT_ID and SCHWAB_CLIENT_SECRET in the environment or .env plus
// tokens in data/oauth-tokens.json from `npm run auth`. The client is
// market-data-only: quotes, price history and chains; nothing else.
// Returns null (with the reason) when falling back is acceptable; throws
// when the caller demanded Schwab explicitly.

import { loadSchwabApp } from "../brokers/schwab/app-file.js";
import "dotenv/config";
import { SchwabAuth } from "../brokers/schwab/auth.js";
import { SchwabRest } from "../brokers/schwab/rest.js";
import { loadWindowsVaultAuth } from "../brokers/schwab/windows-vault.js";

export type ProviderChoice = "auto" | "yahoo" | "schwab";

export interface SchwabSession {
  readonly rest: SchwabRest | null;
  readonly reason: string;             // why Schwab is or is not in use
}

export async function schwabSession(provider: ProviderChoice): Promise<SchwabSession> {
  if (provider === "yahoo") return { rest: null, reason: "yahoo requested" };
  // An existing but unreadable vault fails closed rather than falling through.
  const vaultAuth = await loadWindowsVaultAuth();
  if (vaultAuth) return { rest: new SchwabRest(vaultAuth, { marketDataOnly: true }), reason: "Windows vault" };
  // Environment first, then the app file written by `npm run schwab-login` (cloud sessions).
  const savedApp = loadSchwabApp();
  const clientId = process.env.SCHWAB_CLIENT_ID ?? savedApp?.clientId ?? "";
  const clientSecret = process.env.SCHWAB_CLIENT_SECRET ?? savedApp?.clientSecret ?? "";
  if (!clientId || !clientSecret) {
    const reason = "no Windows Schwab vault and SCHWAB_CLIENT_ID / SCHWAB_CLIENT_SECRET not set (environment or .env in this directory)";
    if (provider === "schwab") throw new Error(`--provider schwab: ${reason}`);
    return { rest: null, reason };
  }
  const auth = new SchwabAuth({ clientId, clientSecret, redirectUri: process.env.SCHWAB_REDIRECT_URI ?? savedApp?.redirectUri ?? "https://localhost:8443/callback" });
  const loaded = await auth.load();
  if (!loaded) {
    const reason = "no tokens in data/oauth-tokens.json (run npm run auth; the refresh token lasts 7 days)";
    if (provider === "schwab") throw new Error(`--provider schwab: ${reason}`);
    return { rest: null, reason };
  }
  return { rest: new SchwabRest(auth, { marketDataOnly: true }), reason: "environment credentials and token file" };
}

export function parseProvider(value: string | undefined): ProviderChoice {
  const v = (value ?? "").toLowerCase();
  return v === "yahoo" || v === "schwab" ? v : "auto";
}
