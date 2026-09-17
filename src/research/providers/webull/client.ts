// Webull OpenAPI HTTP client (read-only subset for research).
//
// Endpoint paths verified against webull-openapi-python-sdk 3.0.1
// (webull/data/request/*.py, webull/trade/request/v2/*.py,
// webull/core/http/initializer/*). Hosts from webull/core/data/endpoints.json:
//   production api.webull.com, sandbox api.sandbox.webull.com (docs).
//
// Request assembly mirrors webull/core/client.py:_make_http_response:
//   - headers: signed headers + x-version (per request, "v3") +
//     x-webull-client-source + User-Agent + Accept-Encoding gzip +
//     x-access-token when a verified token exists
//   - body: compact JSON, Content-Type application/json
//
// Token flow (2FA), mirrors ClientInitializer/TokenManager:
//   GET  /openapi/config            -> { token_check_enabled: bool }
//   POST /auth/tokens/create {token?} -> { token, expires, status }
//   POST /auth/tokens/check  {token}  -> same; poll until status NORMAL
// Verified tokens persist to data/webull-token.json (mode 0600). This
// client never calls any order endpoint.

import * as fs from "node:fs";
import * as path from "node:path";
import { createLogger } from "../../../core/logger.js";
import { sleep } from "../../../utils/time.js";
import { signWebullRequest } from "./signer.js";
import type { WebullTokenRaw } from "./types.js";

const log = createLogger("webull-client");

const TOKEN_FILE = path.join("data", "webull-token.json");
const REQUEST_TIMEOUT_MS = 10_000;
const TOKEN_CHECK_INTERVAL_MS = 5_000;
const TOKEN_CHECK_DURATION_MS = 5 * 60 * 1000;
const CLIENT_SOURCE = "gecko";

export type WebullEnv = "prod" | "sandbox";

export interface WebullClientConfig {
  readonly appKey: string;
  readonly appSecret: string;
  readonly env: WebullEnv;
  readonly host?: string;              // override
}

export interface WebullHttpError extends Error {
  readonly status: number;
  readonly body: string;
}

interface PersistedToken {
  readonly token: string;
  readonly expires: number;
  readonly status: string;
}

export function webullHostFor(env: WebullEnv): string {
  return env === "sandbox" ? "api.sandbox.webull.com" : "api.webull.com";
}

export class WebullClient {
  private readonly host: string;
  private accessToken: string | null = null;
  private tokenInitialized = false;

  constructor(private readonly config: WebullClientConfig) {
    if (!config.appKey || !config.appSecret) {
      throw new Error("WebullClient: WEBULL_APP_KEY and WEBULL_APP_SECRET are required");
    }
    this.host = config.host ?? webullHostFor(config.env);
  }

  get hostName(): string {
    return this.host;
  }

  // ----- Public read-only calls -----

  async get<T>(apiPath: string, query: Readonly<Record<string, string>>, version = "v3"): Promise<T> {
    await this.ensureToken();
    return this.request<T>("GET", apiPath, query, null, version);
  }

  async post<T>(apiPath: string, body: Readonly<Record<string, unknown>>, version = "v3"): Promise<T> {
    await this.ensureToken();
    return this.request<T>("POST", apiPath, {}, body, version);
  }

  // ----- Token (2FA) flow -----

  private async ensureToken(): Promise<void> {
    if (this.tokenInitialized) return;
    this.tokenInitialized = true;
    let enabled = false;
    try {
      const cfg = await this.request<{ token_check_enabled?: boolean }>("GET", "/openapi/config", {}, null, "v3");
      enabled = cfg.token_check_enabled === true;
    } catch (err) {
      log.warn("Webull token config check failed; continuing without access token", { error: errMsg(err) });
      return;
    }
    if (!enabled) {
      log.info("Webull token check disabled for this app key");
      return;
    }
    const local = this.loadToken();
    const created = await this.request<WebullTokenRaw>("POST", "/auth/tokens/create", {}, local ? { token: local.token } : {}, "v3");
    let current = validateToken(created, "create");
    const start = Date.now();
    while (current.status !== "NORMAL") {
      if (current.status === "INVALID" || current.status === "EXPIRED") {
        throw new Error(`Webull token ${current.status}; re-run auth and approve the request in the Webull app`);
      }
      if (Date.now() - start > TOKEN_CHECK_DURATION_MS) {
        throw new Error("Webull token approval timed out (PENDING); approve the request in the Webull app and retry");
      }
      log.info("Webull token pending approval; waiting", { status: current.status });
      await sleep(TOKEN_CHECK_INTERVAL_MS);
      const checked = await this.request<WebullTokenRaw>("POST", "/auth/tokens/check", {}, { token: current.token }, "v3");
      current = validateToken(checked, "check");
    }
    this.accessToken = current.token;
    this.saveToken(current);
    log.info("Webull access token verified", { expires: current.expires });
  }

  private loadToken(): PersistedToken | null {
    try {
      if (!fs.existsSync(TOKEN_FILE)) return null;
      const raw = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf-8")) as Partial<PersistedToken>;
      if (typeof raw.token !== "string" || raw.token.length === 0) return null;
      return { token: raw.token, expires: Number(raw.expires ?? 0), status: String(raw.status ?? "") };
    } catch (err) {
      log.warn("Failed to read Webull token file", { error: errMsg(err) });
      return null;
    }
  }

  private saveToken(t: PersistedToken): void {
    try {
      fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
      fs.writeFileSync(TOKEN_FILE, JSON.stringify(t), { encoding: "utf-8", mode: 0o600 });
      fs.chmodSync(TOKEN_FILE, 0o600);
    } catch (err) {
      log.warn("Failed to persist Webull token", { error: errMsg(err) });
    }
  }

  // ----- Internals -----

  private async request<T>(
    method: "GET" | "POST",
    apiPath: string,
    query: Readonly<Record<string, string>>,
    body: Readonly<Record<string, unknown>> | null,
    version: string,
  ): Promise<T> {
    const bodyStr = body === null ? null : JSON.stringify(body);
    const signed = signWebullRequest({
      host: this.host,
      path: apiPath,
      query,
      body: bodyStr,
      appKey: this.config.appKey,
      appSecret: this.config.appSecret,
    });
    const headers: Record<string, string> = {
      ...signed,
      "x-version": version,
      "x-webull-client-source": CLIENT_SOURCE,
      "User-Agent": "gecko-research/0.1",
      "Accept-Encoding": "gzip",
    };
    if (this.accessToken) headers["x-access-token"] = this.accessToken;
    if (bodyStr !== null) headers["Content-Type"] = "application/json";

    const qs = new URLSearchParams(query).toString();
    const url = `https://${this.host}${apiPath}${qs ? `?${qs}` : ""}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetch(url, { method, headers, body: bodyStr ?? undefined, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    const text = await resp.text();
    if (!resp.ok) {
      const err = new Error(`Webull ${method} ${apiPath}: HTTP ${resp.status}: ${text.slice(0, 300)}`) as WebullHttpError;
      (err as { status: number }).status = resp.status;
      (err as { body: string }).body = text.slice(0, 1000);
      log.warn("Webull request failed", { method, path: apiPath, status: resp.status, requestId: resp.headers.get("x-request-id") ?? undefined });
      throw err;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`Webull ${method} ${apiPath}: non-JSON response: ${text.slice(0, 200)}`);
    }
  }
}

function validateToken(raw: WebullTokenRaw, stage: string): PersistedToken {
  if (typeof raw.token !== "string" || raw.token.length === 0 || typeof raw.status !== "string") {
    throw new Error(`Webull token ${stage}: malformed response (keys: ${Object.keys(raw).join(",")})`);
  }
  return { token: raw.token, expires: Number(raw.expires ?? 0), status: raw.status };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
