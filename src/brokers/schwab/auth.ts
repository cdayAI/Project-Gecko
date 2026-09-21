// Schwab OAuth 2.0 client.
//
// Operational reality of this API:
//   - Access token: 30 minutes. We refresh proactively at ~25 min.
//   - Refresh token: 7 days. HARD WALL. After 7 days the operator must run
//     the browser flow again. There is no machine-only credential.
//
// Endpoints (verified):
//   GET  https://api.schwabapi.com/v1/oauth/authorize
//   POST https://api.schwabapi.com/v1/oauth/token
//
// Auth flow:
//   1. operator runs the CLI auth helper -> getAuthorizeUrl() prints URL
//   2. operator opens URL in browser, logs in, approves app
//   3. browser redirects to the registered https redirect_uri with ?code=...
//   4. operator pastes the full callback URL back into the CLI
//   5. exchangeCode() POSTs to /v1/oauth/token, persists both tokens
//   6. ensureFreshToken() refreshes the access token automatically thereafter
//
// Tokens are persisted to data/oauth-tokens.json with 0600 permissions and
// never logged. The refresh_token MUST be treated as a 7-day credential and
// surrounded with the same secrecy as the access_token.

import * as fs from "node:fs";
import * as path from "node:path";
import { createLogger } from "../../core/logger.js";
import type { OAuthTokenResponse, PersistedTokens } from "./types.js";

const log = createLogger("schwab-auth");

const AUTHORIZE_URL = "https://api.schwabapi.com/v1/oauth/authorize";
const TOKEN_URL = "https://api.schwabapi.com/v1/oauth/token";

const TOKEN_FILE = "data/oauth-tokens.json";

// Refresh the access token this many ms before its actual expiry.
const REFRESH_LEAD_MS = 5 * 60 * 1000;        // 5 minutes
// Background refresh tick.
const REFRESH_TICK_MS = 60 * 1000;            // 1 minute
// Schwab refresh token TTL.
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Warn the operator this many ms before refresh-token death.
const REAUTH_WARNING_LEAD_MS = 24 * 60 * 60 * 1000;   // 24 hours

export interface SchwabAuthConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
}

// Research callers can keep tokens in encrypted storage. Existing broker
// callers retain the legacy file store unless they explicitly supply one.
export interface SchwabTokenStore {
  load(): Promise<PersistedTokens | null>;
  save(tokens: PersistedTokens): Promise<void>;
}

export class SchwabAuth {
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private accessTokenExpiresAt = 0;
  private refreshTokenIssuedAt = 0;

  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private reauthWarned = false;
  private refreshInFlight: Promise<void> | null = null;
  private persistenceFailed = false;

  constructor(
    private readonly config: SchwabAuthConfig,
    private readonly tokenStore?: SchwabTokenStore,
  ) {}

  // ----- Public API -----

  // The URL the operator opens in a browser to start the OAuth flow.
  getAuthorizeUrl(): string {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
    });
    return `${AUTHORIZE_URL}?${params.toString()}`;
  }

  // Exchange the authorization code for the initial access + refresh tokens.
  // Call this once after the operator pastes back the callback URL.
  async exchangeCode(authorizationCode: string): Promise<void> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: authorizationCode,
      redirect_uri: this.config.redirectUri,
    });

    const resp = await this.postTokenEndpoint(body);
    await this.acceptTokenResponse(resp, /* fromRefresh */ false);
    log.info("Initial OAuth exchange complete", {
      accessTokenExpiresIn: `${Math.round((this.accessTokenExpiresAt - Date.now()) / 1000)}s`,
      refreshTokenExpiresIn: `${Math.round(this.refreshTtlMs() / 1000 / 60 / 60)}h`,
    });
  }

  // Load tokens from disk (call once at startup before getAccessToken()).
  async load(): Promise<boolean> {
    try {
      if (!this.tokenStore && !fs.existsSync(TOKEN_FILE)) return false;
      const parsed: unknown = this.tokenStore
        ? await this.tokenStore.load()
        : JSON.parse(fs.readFileSync(TOKEN_FILE, "utf-8"));
      if (parsed === null) return false;
      if (
        typeof parsed !== "object" ||
        !("accessToken" in parsed) || !validToken(parsed.accessToken) ||
        !("refreshToken" in parsed) || !validToken(parsed.refreshToken) ||
        !("accessTokenExpiresAt" in parsed) || !validTimestamp(parsed.accessTokenExpiresAt) ||
        !("refreshTokenIssuedAt" in parsed) || !validTimestamp(parsed.refreshTokenIssuedAt)
      ) {
        log.error("Token file is malformed; ignoring");
        return false;
      }
      this.accessToken = parsed.accessToken;
      this.refreshToken = parsed.refreshToken;
      this.accessTokenExpiresAt = parsed.accessTokenExpiresAt;
      this.refreshTokenIssuedAt = parsed.refreshTokenIssuedAt;
      log.info("Loaded persisted tokens", {
        accessTokenExpiresIn: `${Math.round((this.accessTokenExpiresAt - Date.now()) / 1000)}s`,
        refreshTtlRemaining: `${Math.round(this.refreshTtlMs() / 1000 / 60 / 60)}h`,
      });
      return true;
    } catch {
      // JSON parsing and custom-store exceptions may contain credential text.
      log.error("Failed to load tokens; sensitive details withheld");
      return false;
    }
  }

  // Return a valid access token, refreshing if it is within REFRESH_LEAD_MS of expiry.
  async getAccessToken(): Promise<string> {
    if (this.persistenceFailed) throw new Error("Credential persistence failed; restart research after checking storage.");
    if (!this.refreshToken) {
      throw new Error("No refresh token loaded. Complete the established local authorization flow.");
    }
    if (this.refreshTtlMs() <= 0) {
      throw new Error(
        "Refresh token expired (Schwab 7-day wall). Complete the established local authorization flow again.",
      );
    }
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt - REFRESH_LEAD_MS) {
      return this.accessToken;
    }
    await this.refresh();
    if (!this.accessToken) {
      throw new Error("Refresh succeeded but access token is null. This should never happen.");
    }
    return this.accessToken;
  }

  // Start the background refresh loop. Call once at startup, after load().
  startAutoRefresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setInterval(() => {
      this.tickRefresh().catch((err) => {
        log.error("Auto-refresh tick failed", { error: errMsg(err) });
      });
    }, REFRESH_TICK_MS);
    // Allow the process to exit naturally if nothing else holds the loop.
    this.refreshTimer.unref?.();
  }

  stopAutoRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  // How long is left on the current refresh token (ms). Negative = expired.
  refreshTtlMs(): number {
    return (this.refreshTokenIssuedAt + REFRESH_TOKEN_TTL_MS) - Date.now();
  }

  // True if we have any tokens loaded (does not imply they are still valid).
  hasTokens(): boolean {
    return this.accessToken !== null && this.refreshToken !== null;
  }

  // ----- Internals -----

  private async refresh(): Promise<void> {
    if (this.persistenceFailed) throw new Error("Credential persistence failed; restart research after checking storage.");
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.refreshOnce();
    try {
      await this.refreshInFlight;
    } finally {
      this.refreshInFlight = null;
    }
  }

  private async refreshOnce(): Promise<void> {
    if (!this.refreshToken) {
      throw new Error("Cannot refresh: no refresh token.");
    }
    if (this.refreshTtlMs() <= 0) {
      throw new Error("Cannot refresh: refresh token expired.");
    }

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.refreshToken,
    });

    const resp = await this.postTokenEndpoint(body, this.refreshToken);
    await this.acceptTokenResponse(resp, /* fromRefresh */ true);
    log.info("Access token refreshed", {
      accessTokenExpiresIn: `${Math.round((this.accessTokenExpiresAt - Date.now()) / 1000)}s`,
      refreshTtlRemainingHrs: Math.round(this.refreshTtlMs() / 1000 / 60 / 60),
    });
  }

  private async tickRefresh(): Promise<void> {
    if (!this.refreshToken) return;

    // Warn 24h before the 7-day wall hits.
    const ttl = this.refreshTtlMs();
    if (ttl > 0 && ttl < REAUTH_WARNING_LEAD_MS && !this.reauthWarned) {
      log.warn("Refresh token nearing 7-day wall, browser re-auth required soon", {
        hoursUntilReauth: Math.round(ttl / 1000 / 60 / 60),
      });
      this.reauthWarned = true;
    }
    if (ttl <= 0) {
      // Stop spamming the network with refresh attempts.
      this.stopAutoRefresh();
      log.error("Refresh token EXPIRED. Bot needs manual browser re-auth.");
      return;
    }

    // Refresh if access token is within lead time of expiry.
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt - REFRESH_LEAD_MS) {
      return;
    }
    await this.refresh();
  }

  private async postTokenEndpoint(body: URLSearchParams, previousRefreshToken?: string): Promise<OAuthTokenResponse> {
    const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64");

    // Single attempt. Never expose response bodies or transport exceptions:
    // either can contain a token, submitted form, or another secret.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);

    try {
      const resp = await fetch(TOKEN_URL, {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: `Basic ${basic}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
        signal: controller.signal,
      });
      if (!resp.ok) {
        await resp.body?.cancel().catch(() => {});
        throw new TokenResponseError(`Schwab OAuth returned HTTP ${resp.status}; response body withheld.`);
      }
      const json: unknown = await resp.json();
      if (typeof json !== "object" || json === null ||
          !("access_token" in json) || !validToken(json.access_token) ||
          ("refresh_token" in json ? !validToken(json.refresh_token) : !validToken(previousRefreshToken)) ||
          !("expires_in" in json) || typeof json.expires_in !== "number" ||
          !Number.isFinite(json.expires_in) || json.expires_in <= 0 || json.expires_in > 86_400 ||
          !("token_type" in json) || typeof json.token_type !== "string" || json.token_type.toLowerCase() !== "bearer") {
        throw new TokenResponseError("Schwab OAuth returned invalid token fields; response body withheld.");
      }
      return { ...json, refresh_token: "refresh_token" in json ? json.refresh_token : previousRefreshToken } as OAuthTokenResponse;
    } catch (err) {
      if (err instanceof TokenResponseError) throw err;
      throw new Error("Schwab OAuth request or decoding failed; sensitive details withheld.");
    } finally {
      clearTimeout(timer);
    }
  }

  private async acceptTokenResponse(resp: OAuthTokenResponse, fromRefresh: boolean): Promise<void> {
    const tokens: PersistedTokens = {
      accessToken: resp.access_token,
      refreshToken: resp.refresh_token,
      accessTokenExpiresAt: Date.now() + resp.expires_in * 1000,
      refreshTokenIssuedAt: fromRefresh ? this.refreshTokenIssuedAt : Date.now(),
    };
    // Do not expose a refreshed credential until its persistence succeeds.
    try {
      await this.persist(tokens);
    } catch {
      this.persistenceFailed = true;
      throw new Error("Credential persistence failed; restart research after checking storage.");
    }
    this.accessToken = tokens.accessToken;
    this.refreshToken = tokens.refreshToken;
    this.accessTokenExpiresAt = tokens.accessTokenExpiresAt;
    // The refresh-token clock only resets on a fresh /authorize flow, NOT on refresh.
    // (Per Schwab docs and multiple SDK implementations: refresh_token stays constant
    // through the 7-day window.) So only stamp refreshTokenIssuedAt on initial exchange.
    if (!fromRefresh) {
      this.refreshTokenIssuedAt = tokens.refreshTokenIssuedAt;
      this.reauthWarned = false;
    }
  }

  private async persist(tokens: PersistedTokens): Promise<void> {
    if (this.tokenStore) {
      await this.tokenStore.save(tokens);
      return;
    }

    const dir = path.dirname(TOKEN_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2), { encoding: "utf-8", mode: 0o600 });
    // Force the mode in case the file already existed with looser perms.
    try {
      fs.chmodSync(TOKEN_FILE, 0o600);
    } catch {
      // Non-fatal: best effort on Windows.
    }
  }
}

class TokenResponseError extends Error {}

function validToken(value: unknown): value is string {
  return typeof value === "string" && /^[\x21-\x7e]{1,32768}$/.test(value);
}

function validTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 8.64e15;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
