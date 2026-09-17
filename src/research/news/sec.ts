import { setTimeout as delay } from "node:timers/promises";
import { failure, getJson } from "./http.js";
import { publicationTime, record, validateRequest } from "./normalize.js";
import type { HealthStatus, NewsBatch, NewsFetch, NewsItem, NewsProvider, NewsRequest } from "./types.js";

export interface SecNewsConfig {
  readonly userAgent: string;
  readonly cikBySymbol: Readonly<Record<string, string>>;
  readonly forms?: readonly string[];
}

const DEFAULT_FORMS = ["8-K", "8-K/A", "10-Q", "10-K", "6-K", "20-F", "S-1", "S-1/A", "S-3", "S-3/A", "424B2", "424B3", "424B5"];

export function parseSecSubmissions(raw: unknown, symbol: string, cik: string, now: number, forms: readonly string[], limit: number): { items: NewsItem[]; received: number; rejected: number } {
  const data = record(raw);
  if (!data || String(data.cik).replace(/^0+/, "") !== cik.replace(/^0+/, "")) throw new Error("SEC CIK mismatch");
  if (Array.isArray(data.tickers) && !data.tickers.some((ticker) => ticker === symbol)) throw new Error("SEC ticker/CIK mapping mismatch");
  const recent = record(record(data.filings)?.recent);
  if (!recent || !Array.isArray(recent.accessionNumber) || !Array.isArray(recent.form) || !Array.isArray(recent.primaryDocument) || !Array.isArray(recent.acceptanceDateTime)) throw new Error("SEC recent submissions schema is unavailable");
  const items: NewsItem[] = [];
  let rejected = 0, received = 0;
  for (let i = 0; i < Math.min(recent.accessionNumber.length, 1000); i++) {
    const form = recent.form[i];
    if (typeof form !== "string" || !forms.includes(form)) continue;
    received++;
    const accession = recent.accessionNumber[i], document = recent.primaryDocument[i];
    const publishedAt = publicationTime(recent.acceptanceDateTime[i]);
    if (typeof accession !== "string" || !/^\d{10}-\d{2}-\d{6}$/.test(accession)
      || typeof document !== "string" || !/^[A-Za-z0-9_.-]+$/.test(document) || publishedAt === null) { rejected++; continue; }
    const entityName = typeof data.name === "string" ? data.name : symbol;
    items.push({ source: "sec", sourceId: accession, symbols: [symbol], title: `${symbol}: ${form} filed by ${entityName}`,
      url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, "")}/${document}`,
      publisher: "SEC EDGAR", publishedAt, fetchedAt: now, kind: "filing", claimStatus: "filing-notice", relevance: "issuer-mapping",
      contentNote: "SEC submission metadata establishes a filing notice, not the truth, market impact, or interpretation of its contents." });
    if (items.length >= limit) break;
  }
  return { items, received, rejected };
}

export class SecNewsProvider implements NewsProvider {
  readonly source = "sec" as const;
  constructor(private readonly config: SecNewsConfig, private readonly fetcher: NewsFetch = fetch) {}

  async poll(request: NewsRequest): Promise<NewsBatch> {
    validateRequest(request);
    const notes: string[] = ["One current submissions file per explicit CIK mapping; older archive files and filing bodies are not crawled."];
    const items: NewsItem[] = [];
    let requests = 0, receivedCount = 0, rejectedCount = 0;
    let status: HealthStatus = "ok";
    if (!/\S+@\S+\.\S+/.test(this.config.userAgent) || /[\r\n]/.test(this.config.userAgent)) {
      return { items, requests, receivedCount, rejectedCount, status: "misconfigured", notes: ["SEC_USER_AGENT must identify the operator with a contact email; no request sent."] };
    }
    for (const symbol of request.symbols) {
      if (request.signal?.aborted) { status = "unavailable"; notes.push("News poll interrupted before the next issuer."); break; }
      const cik = this.config.cikBySymbol[symbol];
      if (!cik || !/^\d{1,10}$/.test(cik) || Number(cik) === 0) { status = "misconfigured"; notes.push(`Missing or invalid explicit CIK mapping for ${symbol}.`); continue; }
      try {
        if (requests > 0) await delay(150, undefined, { signal: request.signal });
        requests++;
        const raw = await getJson(`https://data.sec.gov/submissions/CIK${cik.padStart(10, "0")}.json`, { "User-Agent": this.config.userAgent, Accept: "application/json" }, this.fetcher, 10_000, request.signal);
        const parsed = parseSecSubmissions(raw, symbol, cik, Date.now(), this.config.forms ?? DEFAULT_FORMS, request.limitPerSymbol);
        items.push(...parsed.items); receivedCount += parsed.received; rejectedCount += parsed.rejected;
        if (parsed.rejected > 0) { status = "partial"; notes.push(`${symbol}: ${parsed.rejected} filing rows had missing or invalid metadata/timestamps.`); }
      } catch (error) { const failed = failure(error); status = failed.status; notes.push(`${symbol}: ${failed.note}`); }
      if (status === "rate-limited") break;
    }
    return { items, status: status !== "ok" && items.length ? "partial" : status, requests, receivedCount, rejectedCount, notes };
  }
}
