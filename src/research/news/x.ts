import { failure, getJson } from "./http.js";
import { claimStatus, publicationTime, record, relevantSymbols, validateRequest } from "./normalize.js";
import type { NewsBatch, NewsFetch, NewsItem, NewsProvider, NewsRequest } from "./types.js";

export interface XNewsConfig {
  readonly bearerToken: string;
  readonly authors?: readonly string[];
  readonly fieldSelector?: "post.fields" | "tweet.fields";
}

export function parseXRecent(raw: unknown, request: NewsRequest): { items: NewsItem[]; received: number; rejected: number; partial: boolean } {
  const body = record(raw);
  if (!body || (!Array.isArray(body.data) && record(body.meta)?.result_count !== 0)) throw new Error("X recent-search response schema is unavailable");
  const users = new Map<string, string>();
  const included = record(body.includes)?.users;
  if (Array.isArray(included)) for (const item of included) { const user = record(item); if (typeof user?.id === "string" && typeof user.username === "string") users.set(user.id, user.username); }
  const rows: unknown[] = Array.isArray(body.data) ? body.data : [];
  const items: NewsItem[] = [];
  let rejected = 0;
  for (const row of rows) {
    const post = record(row);
    const publishedAt = publicationTime(post?.created_at);
    if (!post || typeof post.id !== "string" || !/^\d{1,25}$/.test(post.id) || typeof post.text !== "string" || publishedAt === null) { rejected++; continue; }
    const relevant = relevantSymbols(post.text, request);
    const cashtags = record(post.entities)?.cashtags;
    if (Array.isArray(cashtags)) for (const entry of cashtags) {
      const tag = record(entry)?.tag;
      if (typeof tag === "string" && request.symbols.includes(tag.toUpperCase()) && !relevant.symbols.includes(tag.toUpperCase())) relevant.symbols.push(tag.toUpperCase());
    }
    if (!relevant.symbols.length) { rejected++; continue; }
    const author = typeof post.author_id === "string" ? users.get(post.author_id) ?? `author-id:${post.author_id}` : typeof post.username === "string" ? post.username : undefined;
    items.push({ source: "x", sourceId: post.id, symbols: relevant.symbols, title: post.text,
      url: `https://x.com/i/web/status/${post.id}`, publisher: "X", ...(author ? { author } : {}), publishedAt, fetchedAt: request.now,
      kind: "social-post", claimStatus: claimStatus(post.text, true), relevance: relevant.alias ? "configured-alias" : "explicit-symbol",
      contentNote: "Public post, unverified commentary. Reposts and author badges do not establish corroboration." });
  }
  return { items, received: rows.length, rejected, partial: Boolean(record(body.meta)?.next_token) || (Array.isArray(body.errors) && body.errors.length > 0) || rejected > 0 };
}

export class XNewsProvider implements NewsProvider {
  readonly source = "x" as const;
  constructor(private readonly config: XNewsConfig, private readonly fetcher: NewsFetch = fetch) {}

  async poll(request: NewsRequest): Promise<NewsBatch> {
    validateRequest(request);
    if (request.signal?.aborted) return { items: [], status: "unavailable", requests: 0, receivedCount: 0, rejectedCount: 0, notes: ["News poll interrupted before the request."] };
    if (!this.config.bearerToken.trim()) return { items: [], status: "auth-required", requests: 0, receivedCount: 0, rejectedCount: 0, notes: ["X_BEARER_TOKEN and an entitled X developer account are required; no request sent."] };
    const authors = this.config.authors ?? [];
    if (authors.length > 20 || authors.some((author) => !/^[A-Za-z0-9_]{1,15}$/.test(author))) return { items: [], status: "misconfigured", requests: 0, receivedCount: 0, rejectedCount: 0, notes: ["X author allowlist is invalid; no request sent."] };
    const query = `(${request.symbols.map((symbol) => `$${symbol}`).join(" OR ")})${authors.length ? ` (${authors.map((author) => `from:${author}`).join(" OR ")})` : ""} -is:retweet`;
    if (query.length > 512) return { items: [], status: "misconfigured", requests: 0, receivedCount: 0, rejectedCount: 0, notes: ["X query exceeds the documented 512-character self-serve limit; reduce tickers or authors."] };
    const url = new URL("https://api.x.com/2/tweets/search/recent");
    url.searchParams.set("query", query);
    url.searchParams.set("max_results", String(Math.max(10, Math.min(100, request.limitPerSymbol * request.symbols.length))));
    url.searchParams.set("start_time", new Date(request.now - Math.min(request.maxAgeMs, 7 * 86_400_000 - 60_000)).toISOString());
    url.searchParams.set("sort_order", "recency");
    // API reference says post.fields; the integration guide still says tweet.fields.
    // An explicit selector supports that documented discrepancy without a paid retry.
    url.searchParams.set(this.config.fieldSelector ?? "post.fields", "id,text,created_at,entities,conversation_id");
    url.searchParams.set("expansions", "author_id");
    url.searchParams.set("user.fields", "id,username");
    try {
      const raw = await getJson(url.toString(), { Authorization: `Bearer ${this.config.bearerToken}`, Accept: "application/json" }, this.fetcher, 10_000, request.signal);
      const parsed = parseXRecent(raw, { ...request, now: Date.now() });
      return { items: parsed.items, status: parsed.partial ? "partial" : "ok", requests: 1, receivedCount: parsed.received, rejectedCount: parsed.rejected,
        notes: ["One bounded recent-search page; no stream, private chats, pagination backlog, or completeness guarantee.", ...(parsed.partial ? ["Pagination, row rejection or provider partial errors were reported; coverage is incomplete."] : [])] };
    } catch (error) { const failed = failure(error); return { items: [], status: failed.status, requests: 1, receivedCount: 0, rejectedCount: 0, notes: [failed.note] }; }
  }
}
