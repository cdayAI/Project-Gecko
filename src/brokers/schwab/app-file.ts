// Schwab app credentials saved by `npm run schwab-login` (data/schwab-app.json,
// mode 0600, gitignored). Read by the login CLI and by research sessions when
// the SCHWAB_* environment variables are absent. Never logged.

import * as fs from "node:fs";
import * as path from "node:path";

export const APP_FILE = path.join("data", "schwab-app.json");
export interface SchwabAppCredentials { readonly clientId: string; readonly clientSecret: string; readonly redirectUri: string }

export function loadSchwabApp(): SchwabAppCredentials | null {
  try {
    if (!fs.existsSync(APP_FILE)) return null;
    const j = JSON.parse(fs.readFileSync(APP_FILE, "utf-8")) as Partial<SchwabAppCredentials>;
    return typeof j.clientId === "string" && typeof j.clientSecret === "string" && typeof j.redirectUri === "string" && j.clientId && j.clientSecret && j.redirectUri
      ? { clientId: j.clientId, clientSecret: j.clientSecret, redirectUri: j.redirectUri }
      : null;
  } catch {
    return null;
  }
}

