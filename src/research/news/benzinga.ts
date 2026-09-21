import { failure, getJson } from "./http.js";
import { canonicalUrl, claimStatus, publicationTime, record, validateRequest } from "./normalize.js";
import type { NewsBatch, NewsFetch, NewsItem, NewsProvider, NewsRequest } from "./types.js";

export function parseBenzinga(raw: unknown, request: NewsRequest): { items: NewsItem[]; rejected: number } {
  if (!Array.isArray(raw)) throw new Error("Benzinga news response is not an array");
  const items: NewsItem[] = [];
  let rejected = 0;
  for (const row of raw) {
    const item = record(row);
    const publishedAt = publicationTime(item?.created);
    const url = typeof item?.url === "string" ? canonicalUrl(item.url) : null;
    const symbols = Array.isArray(item?.stocks) ? item.stocks.map((stock: unknown) => record(stock)?.name).filter((symbol: unknown): symbol is string => typeof symbol === "string" && request.symbols.includes(symbol.toUpperCase())).map((s: string) => s.toUpperCase()) : [];
    if (!item || !["string", "number"].includes(typeof item.id) || typeof item.title !== "string" || publishedAt === null || !url || !symbols.length) { rejected++; continue; }
    const sourceUpdatedAt = publicationTime(item.updated);
    items.push({ source: "benzinga", sourceId: String(item.id), symbols: [...new Set(symbols)], title: item.title,
      url, publisher: "Benzinga", ...(typeof item.author === "string" ? { author: item.author } : {}), publishedAt,
      ...(sourceUpdatedAt !== null ? { sourceUpdatedAt } : {}), fetchedAt: request.now, kind: "headline",
      claimStatus: claimStatus(item.title), relevance: "provider-ticker", contentNote: "Licensed headline metadata only; no full article body requested or independently verified." });
  }
  return { items, rejected };
}

export class BenzingaNewsProvider implements NewsProvider {
  readonly source = "benzinga" as const;
  constructor(private readonly token: string, private readonly fetcher: NewsFetch = fetch) {}

  async poll(request: NewsRequest): Promise<NewsBatch> {
    validateRequest(request);
    if (request.signal?.aborted) return { items: [], status: "unavailable", requests: 0, receivedCount: 0, rejectedCount: 0, notes: ["News poll interrupted before the request."] };
    if (!this.token.trim()) return { items: [], status: "auth-required", requests: 0, receivedCount: 0, rejectedCount: 0, notes: ["BENZINGA_API_KEY and suitable news entitlement required; no request sent."] };
    const pageSize = Math.min(100, request.limitPerSymbol * request.symbols.length);
    const url = new URL("https://api.benzinga.com/api/v2/news");
    url.searchParams.set("token", this.token);
    url.searchParams.set("tickers", request.symbols.join(","));
    url.searchParams.set("displayOutput", "headline");
    url.searchParams.set("page", "0");
    url.searchParams.set("pageSize", String(pageSize));
    url.searchParams.set("publishedSince", String(Math.floor((request.now - request.maxAgeMs) / 1000)));
    url.searchParams.set("sort", "created:desc");
    try {
      const raw = await getJson(url.toString(), { Accept: "application/json" }, this.fetcher, 10_000, request.signal);
      const parsed = parseBenzinga(raw, { ...request, now: Date.now() });
      const receivedCount = Array.isArray(raw) ? raw.length : 0;
      const partial = receivedCount >= pageSize || parsed.rejected > 0;
      return { items: parsed.items, status: partial ? "partial" : "ok", requests: 1, receivedCount, rejectedCount: parsed.rejected,
        notes: ["One bounded headline page; no full-text retrieval or redistribution rights are implied.", ...(partial ? ["Page limit or rejected rows may leave coverage incomplete."] : [])] };
    } catch (error) { const failed = failure(error); return { items: [], status: failed.status, requests: 1, receivedCount: 0, rejectedCount: 0, notes: [failed.note] }; }
  }
}
