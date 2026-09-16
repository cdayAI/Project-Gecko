// Catalyst gathering: headlines, earnings date, macro calendar.
//
// Headlines: Yahoo Finance search endpoint (free, no key), same source the
// news reader uses. Each headline carries publisher and publish time so
// the packet can show recency. No LLM scoring here; the packet shows the
// raw evidence and leaves judgement to the reader (or a later review step).

import { createLogger } from "../core/logger.js";
import { EconomicCalendar } from "../intelligence/economic-calendar.js";
import type { MarketDataProvider } from "./providers/provider.js";
import type { CatalystSet, Headline, Provenance } from "./types.js";

const log = createLogger("catalysts");

const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";
const HEADLINE_TIMEOUT_MS = 10_000;

interface YahooNewsItem {
  readonly title?: string;
  readonly publisher?: string;
  readonly providerPublishTime?: number;
  readonly link?: string;
}

export class CatalystGatherer {
  private readonly calendar = new EconomicCalendar();

  constructor(private readonly provider: MarketDataProvider, private readonly includeNews: boolean) {}

  async gather(symbol: string, todayIsoDate: string): Promise<CatalystSet> {
    let headlines: Headline[] = [];
    let headlinesProvenance: Provenance | null = null;
    if (this.includeNews) {
      try {
        headlines = await fetchHeadlines(symbol);
        headlinesProvenance = { source: "yahoo", capturedAt: Date.now(), delayed: false, note: "Yahoo Finance search news" };
      } catch (err) {
        log.warn("Headlines fetch failed", { symbol, error: errMsg(err) });
      }
    }
    let nextEarningsDate: string | null = null;
    let earningsProvenance: Provenance | null = null;
    try {
      const e = await this.provider.getNextEarningsDate(symbol);
      if (e) {
        nextEarningsDate = e.date;
        earningsProvenance = { source: this.provider.name as Provenance["source"], capturedAt: Date.now(), delayed: false, note: e.sourceNote };
      }
    } catch (err) {
      log.debug("Earnings date lookup failed", { symbol, error: errMsg(err) });
    }
    const today = this.calendar.eventsOn(todayIsoDate).map((e) => e.type);
    const next5: { date: string; type: string }[] = [];
    for (let i = 1; i <= 5; i++) {
      const d = new Date(Date.parse(`${todayIsoDate}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);
      for (const e of this.calendar.eventsOn(d)) next5.push({ date: d, type: e.type });
    }
    return { symbol, headlines, nextEarningsDate, earningsProvenance, macroEventsToday: today, macroEventsNext5Days: next5, headlinesProvenance };
  }
}

export async function fetchHeadlines(symbol: string, count = 10): Promise<Headline[]> {
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}&newsCount=${count}&quotesCount=0`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEADLINE_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" }, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) throw new Error(`Yahoo news HTTP ${resp.status}`);
  const data = (await resp.json()) as { news?: YahooNewsItem[] };
  const out: Headline[] = [];
  for (const n of data.news ?? []) {
    if (typeof n.title !== "string" || typeof n.providerPublishTime !== "number") continue;
    out.push({ title: n.title, publisher: typeof n.publisher === "string" ? n.publisher : "", publishedAt: n.providerPublishTime * 1000, url: typeof n.link === "string" ? n.link : undefined });
  }
  out.sort((a, b) => b.publishedAt - a.publishedAt);
  return out;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
