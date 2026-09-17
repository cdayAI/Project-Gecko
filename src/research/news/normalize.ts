import { createHash } from "node:crypto";
import type { ClaimStatus, NewsItem, NewsRequest } from "./types.js";

export function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_/i.test(key) || /^(fbclid|gclid|mc_cid|mc_eid)$/i.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.toString();
  } catch { return null; }
}

export function publicationTime(value: unknown): number | null {
  if (typeof value !== "string" || !/(Z|[+-]\d{2}:?\d{2}|GMT|UTC)$/i.test(value.trim())) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function validateRequest(request: NewsRequest): void {
  if (!Number.isFinite(request.now) || request.now <= 0) throw new Error("Invalid news request time");
  if (!Number.isFinite(request.maxAgeMs) || request.maxAgeMs <= 0 || request.maxAgeMs > 31 * 86_400_000) throw new Error("News maximum age must be positive and <=31 days");
  if (!Number.isInteger(request.limitPerSymbol) || request.limitPerSymbol < 1 || request.limitPerSymbol > 100) throw new Error("News limit must be 1-100 per symbol");
  if (request.symbols.length < 1 || request.symbols.length > 20 || request.symbols.some((s) => !/^[A-Z][A-Z0-9.-]{0,9}$/.test(s))) throw new Error("Provide 1-20 explicit uppercase ticker symbols");
}

function escaped(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

export function relevantSymbols(text: string, request: NewsRequest): { symbols: string[]; alias: boolean } {
  const matches: string[] = [];
  let alias = false;
  for (const symbol of request.symbols) {
    // Plain tickers must retain uppercase to avoid treating common words as tickers.
    const explicit = new RegExp(`(^|[^A-Za-z0-9])\\$?${escaped(symbol)}(?=$|[^A-Za-z0-9])`).test(text);
    const byAlias = (request.aliases?.[symbol] ?? []).some((name) => name.length >= 3 && new RegExp(`(^|[^A-Za-z0-9])${escaped(name)}(?=$|[^A-Za-z0-9])`, "i").test(text));
    if (explicit || byAlias) { matches.push(symbol); if (!explicit && byAlias) alias = true; }
  }
  return { symbols: matches, alias };
}

export function claimStatus(text: string, social = false): ClaimStatus {
  return /\brumou?r(?:ed|s)?\b|\bunconfirmed\b|\breportedly\b/i.test(text) ? "rumor" : social ? "commentary" : "reported";
}

export function validItem(item: NewsItem, request: NewsRequest): boolean {
  return typeof item.title === "string" && item.title.trim().length > 0 && item.title.length <= 20_000
    && typeof item.sourceId === "string" && item.sourceId.length > 0 && item.sourceId.length <= 2048
    && canonicalUrl(item.url) !== null && Number.isFinite(item.publishedAt)
    && item.publishedAt <= request.now + 60_000 && item.publishedAt >= request.now - request.maxAgeMs
    && Number.isFinite(item.fetchedAt) && item.symbols.length > 0
    && item.symbols.some((symbol) => request.symbols.includes(symbol));
}

export function itemHash(item: NewsItem): string {
  return hash(JSON.stringify({ source: item.source, sourceId: item.sourceId, title: item.title, url: canonicalUrl(item.url),
    symbols: [...item.symbols].sort(), publisher: item.publisher, author: item.author,
    publishedAt: item.publishedAt, sourceUpdatedAt: item.sourceUpdatedAt, kind: item.kind,
    claimStatus: item.claimStatus, relevance: item.relevance, contentNote: item.contentNote }));
}
