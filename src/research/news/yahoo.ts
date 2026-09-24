import { fetchHeadlines } from "../catalysts.js";
import type { Headline } from "../types.js";
import { canonicalUrl, claimStatus, hash, relevantSymbols, validateRequest } from "./normalize.js";
import type { NewsBatch, NewsItem, NewsProvider, NewsRequest } from "./types.js";

export type HeadlineFetcher = (symbol: string, count: number) => Promise<Headline[]>;

export class YahooNewsProvider implements NewsProvider {
  readonly source = "yahoo" as const;
  constructor(private readonly readHeadlines: HeadlineFetcher = fetchHeadlines) {}

  async poll(request: NewsRequest): Promise<NewsBatch> {
    validateRequest(request);
    const items: NewsItem[] = [];
    const notes: string[] = ["Yahoo search is a best-effort headline sample; delivery latency and complete coverage are unknown."];
    let receivedCount = 0, rejectedCount = 0, failed = 0, requests = 0;
    for (const symbol of request.symbols) {
      if (request.signal?.aborted) { failed++; notes.push("News poll interrupted before the next symbol."); break; }
      try {
        requests++;
        const headlines = await this.readHeadlines(symbol, Math.min(request.limitPerSymbol, 20));
        const fetchedAt = Date.now();
        receivedCount += headlines.length;
        for (const headline of headlines) {
          const url = headline.url ? canonicalUrl(headline.url) : null;
          const relevant = relevantSymbols(headline.title, request);
          if (!url || relevant.symbols.length === 0 || !Number.isFinite(headline.publishedAt)) { rejectedCount++; continue; }
          items.push({ source: this.source, sourceId: hash(url), symbols: relevant.symbols, title: headline.title,
            url, publisher: headline.publisher || "Unknown publisher via Yahoo Finance", publishedAt: headline.publishedAt,
            fetchedAt, kind: "headline", claimStatus: claimStatus(headline.title),
            relevance: relevant.alias ? "configured-alias" : "explicit-symbol",
            contentNote: "Headline only; article body and the claim have not been independently verified." });
        }
      } catch {
        failed++;
        notes.push(`Yahoo headline read failed for ${symbol}; the source may be unavailable or throttled.`);
      }
    }
    return { items, status: failed ? items.length ? "partial" : "unavailable" : "ok", requests, receivedCount, rejectedCount, notes };
  }
}
