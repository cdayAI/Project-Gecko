// Bounded research transport. No accounts, orders, token mutations/files,
// arbitrary hosts, or redirects. Our authenticated proof used signed-only
// requests. If 2FA is required, supply an approved token in memory explicitly.
import { sleep } from "../../../utils/time.js";
import { signWebullRequest } from "./signer.js";

export type WebullEnv = "prod" | "sandbox";
export interface WebullClientConfig {
  readonly appKey: string;
  readonly appSecret: string;
  readonly env: WebullEnv;
  readonly host?: string; // Compatibility: only the fixed environment host.
  readonly accessToken?: string;
  readonly accessTokenExpiresAt?: number; // Explicit Unix milliseconds.
}
export interface WebullHttpError extends Error {
  readonly status: number;
  readonly body: string; // Empty: upstream errors can echo credentials.
}
export interface WebullTransportRuntime {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}
const GET_PATHS: ReadonlySet<string> = new Set([
  "/market-data/stocks/snapshots/list", "/market-data/options/snapshots/list",
  "/trading/instruments/options/contracts/list",
  "/market-data/screeners/gainers-losers/list", "/market-data/screeners/top-actives/list",
  "/market-data/fundamentals/earnings-calendars/list",
]);
const BARS_PATH = "/market-data/stocks/bars/list";
const OPTIONS_PATH = "/market-data/options/snapshots/list";

export function webullHostFor(env: WebullEnv): string {
  if (env !== "sandbox" && env !== "prod") throw new Error("Invalid Webull environment");
  return env === "sandbox" ? "api.sandbox.webull.com" : "api.webull.com";
}

export class WebullClient {
  private readonly host: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly pause: (ms: number) => Promise<void>;
  private nextRequestAt = 0;
  private readonly nextEndpointAt = new Map<string, number>();
  constructor(private readonly config: WebullClientConfig, runtime: WebullTransportRuntime = {}) {
    if (!config.appKey || !config.appSecret) throw new Error("Webull app key and secret are required");
    this.host = webullHostFor(config.env);
    if (config.host !== undefined && config.host !== this.host) throw new Error("Webull host override rejected");
    this.fetcher = runtime.fetch ?? fetch;
    this.now = runtime.now ?? Date.now;
    this.pause = runtime.sleep ?? sleep;
    if (config.accessToken !== undefined && (!config.accessToken || !Number.isSafeInteger(config.accessTokenExpiresAt)
      || (config.accessTokenExpiresAt ?? 0) <= this.now())) throw new Error("Webull access token expiry missing or expired");
  }
  get hostName(): string { return this.host; }
  async get<T>(apiPath: string, query: Readonly<Record<string, string>>, version = "v3"): Promise<T> {
    if (!GET_PATHS.has(apiPath)) throw new Error("Webull research GET path rejected");
    if (apiPath === OPTIONS_PATH && (!query.symbols || query.symbols.split(",").length > 20)) throw new Error("Webull option snapshot batch must contain 1-20 symbols");
    if (apiPath === "/market-data/stocks/snapshots/list" && (!query.symbols || query.symbols.split(",").length > 100)) throw new Error("Webull stock snapshot batch must contain 1-100 symbols");
    return this.request<T>("GET", apiPath, query, null, version);
  }
  async post<T>(apiPath: string, body: Readonly<Record<string, unknown>>, version = "v3"): Promise<T> {
    // This one POST reads historical bars. Mutation paths are never allowed.
    if (apiPath !== BARS_PATH) throw new Error("Webull research POST path rejected");
    return this.request<T>("POST", apiPath, {}, body, version);
  }
  private async reserve(apiPath: string): Promise<void> {
    const now = this.now();
    const at = Math.max(now, this.nextRequestAt, this.nextEndpointAt.get(apiPath) ?? 0);
    // Reserve before awaiting: concurrent callers cannot race this state.
    this.nextRequestAt = at + 210; // Under 300/min without a burst allowance.
    // Official per-app-key, per-endpoint quotas: sandbox30/min, production60/min.
    // Shared credentials in another process also consume these quotas.
    this.nextEndpointAt.set(apiPath, at + (this.config.env === "sandbox" ? 2010 : 1010));
    if (at > now) await this.pause(at - now);
  }
  private async request<T>(method: "GET" | "POST", apiPath: string, query: Readonly<Record<string, string>>,
    body: Readonly<Record<string, unknown>> | null, version: string): Promise<T> {
    if (version !== "v3") throw new Error("Unsupported Webull research API version");
    const bodyStr = body === null ? null : JSON.stringify(body);
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.reserve(apiPath);
      if (this.config.accessToken && (this.config.accessTokenExpiresAt ?? 0) <= this.now()) throw new Error("Webull access token expired; explicitly renew outside research transport");
      const signed = signWebullRequest({ host: this.host, path: apiPath, query, body: bodyStr,
        appKey: this.config.appKey, appSecret: this.config.appSecret });
      const headers: Record<string, string> = { ...signed, "x-version": version,
        "x-webull-client-source": "gecko", "User-Agent": "gecko-research/0.2", "Accept-Encoding": "gzip" };
      if (this.config.accessToken) headers["x-access-token"] = this.config.accessToken;
      if (bodyStr !== null) headers["Content-Type"] = "application/json";
      const queryString = new URLSearchParams(query).toString();
      const url = `https://${this.host}${apiPath}${queryString ? `?${queryString}` : ""}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      let response: Response;
      let text: string;
      try {
        response = await this.fetcher(url, { method, headers, body: bodyStr ?? undefined,
          signal: controller.signal, redirect: "error" });
        text = await response.text();
        if (text.length > 2_000_000) throw new Error("response_too_large");
      } catch {
        throw new Error(`Webull research ${method} ${apiPath}: transport/redirect/timeout/body failure`);
      } finally { clearTimeout(timer); }
      if (!response.ok) {
        if (attempt < 2 && (response.status === 429 || response.status >= 500)) {
          const raw = response.headers.get("retry-after");
          const parsed = raw === null ? NaN : /^\d+(\.\d+)?$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - this.now();
          const backoff = Number.isFinite(parsed) ? Math.max(0, parsed) : 250 * 2 ** attempt;
          if (backoff <= 10_000) { await this.pause(backoff); continue; }
        }
        const error = new Error(`Webull research ${method} ${apiPath}: HTTP ${response.status}`) as WebullHttpError;
        Object.assign(error, { status: response.status, body: "" });
        throw error;
      }
      try { return JSON.parse(text) as T; }
      catch { throw new Error(`Webull research ${method} ${apiPath}: invalid JSON`); }
    }
    throw new Error("Webull research retry budget exhausted");
  }
}
