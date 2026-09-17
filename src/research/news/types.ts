// Source text is untrusted evidence. No event in this module authorizes a trade.
export type NewsSource = "yahoo" | "sec" | "x" | "benzinga";
export type ClaimStatus = "reported" | "commentary" | "rumor" | "filing-notice";
export type HealthStatus = "ok" | "partial" | "auth-required" | "rate-limited" | "unavailable" | "misconfigured" | "error";

export interface NewsItem {
  readonly source: NewsSource;
  readonly sourceId: string;
  readonly symbols: readonly string[];
  readonly title: string;
  readonly url: string;
  readonly publisher: string;
  readonly author?: string;
  readonly publishedAt: number;
  readonly fetchedAt: number;
  readonly kind: "headline" | "social-post" | "filing";
  readonly claimStatus: ClaimStatus;
  readonly relevance: "explicit-symbol" | "configured-alias" | "issuer-mapping" | "provider-ticker";
  readonly sourceUpdatedAt?: number;
  readonly contentNote?: string;
}

export interface NewsEvent extends NewsItem {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly revision: number;
  readonly firstSeenAt: number;
  readonly contentHash: string;
  readonly duplicateOf?: string;
}

export interface NewsRequest {
  readonly symbols: readonly string[];
  readonly now: number;
  readonly maxAgeMs: number;
  readonly limitPerSymbol: number;
  readonly aliases?: Readonly<Record<string, readonly string[]>>;
  readonly signal?: AbortSignal;
}

export interface NewsBatch {
  readonly items: readonly NewsItem[];
  readonly status: HealthStatus;
  readonly requests: number;
  readonly receivedCount: number;
  readonly rejectedCount: number;
  readonly notes: readonly string[];
}

export interface NewsProvider {
  readonly source: NewsSource;
  poll(request: NewsRequest): Promise<NewsBatch>;
}

export interface SourceHealth {
  readonly source: NewsSource;
  readonly checkedAt: number;
  readonly status: HealthStatus;
  readonly requests: number;
  readonly receivedCount: number;
  readonly acceptedCount: number;
  readonly appendedCount: number;
  readonly duplicateCount: number;
  readonly rejectedCount: number;
  readonly notes: readonly string[];
  readonly coverage: "bounded-poll";
  readonly latency: "unknown";
}

export type NewsFetch = (url: string, init: RequestInit) => Promise<Response>;
