// Webull OpenAPI research provider.
//
// Capabilities and entitlements (developer.webull.com, Market Data API
// overview, checked 2026-09-16):
//   - US stock/ETF snapshots, depth, bars: requires an OpenAPI market data
//     subscription (Nasdaq Basic or TotalView, non-display). Sandbox returns
//     15-minute delayed data by default.
//   - US option snapshots/bars/ticks: requires OPRA Real-Time Non-display.
//     20 symbols per call, 60 requests/minute (SDK sample comments).
//   - Option contract discovery: /trading/instruments/options/contracts/list
//     (SDK GetOptionContractsRequestV2). Response shape not yet observed.
//   - Screeners: /market-data/screeners/gainers-losers/list and
//     /market-data/screeners/top-actives/list (SDK v2 requests).
//   - Earnings calendar: /market-data/fundamentals/earnings-calendars/list.
//
// Numeric fields arrive as strings; everything is validated at the boundary.

import { createLogger } from "../../../core/logger.js";
import type { Bar } from "../../../core/types.js";
import type { OptionChainSnapshot, OptionQuote, Provenance, UnderlyingSnapshot } from "../../types.js";
import { parseOsi } from "../../osi.js";
import type { ChainRequest, MarketDataProvider, MoverKind, MoverRow } from "../provider.js";
import type { WebullClient } from "./client.js";
import type {
  WebullBarsResponseRaw,
  WebullEarningsRowRaw,
  WebullScreenerResponseRaw,
  WebullStockSnapshotRaw,
} from "./types.js";

const log = createLogger("webull-provider");

const ETF_HINT = new Set(["SPY", "QQQ", "IWM", "DIA", "XLF", "XLE", "XLK", "XLU", "XLV", "XLI", "XLP", "XLY", "XLB", "XLRE", "XLC", "KRE", "KBE", "XHB", "SMH", "SOXX", "TLT", "GLD", "SLV", "HYG", "LQD", "IYT", "XBI", "ARKK", "VXX", "UVXY", "SQQQ", "TQQQ", "SPXL", "SPXS"]);

export class WebullProvider implements MarketDataProvider {
  readonly name = "webull";
  private optionShapeLogged = false;

  constructor(private readonly client: WebullClient, private readonly delayedHint: boolean) {}

  async getSnapshots(symbols: readonly string[]): Promise<readonly UnderlyingSnapshot[]> {
    const out: UnderlyingSnapshot[] = [];
    // Category is required and ETFs must be queried as US_ETF. Split by a
    // hint list; unknown symbols default to US_STOCK and are retried as
    // US_ETF if they come back empty.
    const stocks = symbols.filter((s) => !ETF_HINT.has(s.toUpperCase()));
    const etfs = symbols.filter((s) => ETF_HINT.has(s.toUpperCase()));
    const missing: string[] = [];
    for (const [category, list] of [["US_STOCK", stocks], ["US_ETF", etfs]] as const) {
      for (let i = 0; i < list.length; i += 100) {
        const chunk = list.slice(i, i + 100);
        if (chunk.length === 0) continue;
        const rows = await this.fetchSnapshots(chunk, category);
        const got = new Set(rows.map((r) => r.symbol));
        for (const s of chunk) if (!got.has(s.toUpperCase())) missing.push(s);
        out.push(...rows);
      }
    }
    if (missing.length > 0) {
      const retryCategory = "US_ETF";
      const rows = await this.fetchSnapshots(missing, retryCategory);
      out.push(...rows);
    }
    return out;
  }

  private async fetchSnapshots(symbols: readonly string[], category: "US_STOCK" | "US_ETF"): Promise<UnderlyingSnapshot[]> {
    let raw: unknown;
    try {
      raw = await this.client.get<unknown>("/market-data/stocks/snapshots/list", {
        symbols: symbols.map((s) => s.toUpperCase()).join(","),
        category,
        extend_hour_required: "true",
      });
    } catch (err) {
      log.warn("Snapshot request failed", { category, count: symbols.length, error: errMsg(err) });
      return [];
    }
    if (!Array.isArray(raw)) {
      log.warn("Snapshot response was not an array", { category, keys: typeof raw === "object" && raw ? Object.keys(raw as object).slice(0, 10) : [] });
      return [];
    }
    const capturedAt = Date.now();
    const out: UnderlyingSnapshot[] = [];
    for (const row of raw as WebullStockSnapshotRaw[]) {
      const snap = this.toSnapshot(row, capturedAt);
      if (snap) out.push(snap);
    }
    return out;
  }

  private toSnapshot(r: WebullStockSnapshotRaw, capturedAt: number): UnderlyingSnapshot | null {
    const symbol = typeof r.symbol === "string" ? r.symbol.toUpperCase() : null;
    const last = num(r.price);
    if (!symbol || last === null || last <= 0) return null;
    const prevClose = num(r.pre_close) ?? 0;
    const ext = num(r.extend_hour_last_price);
    const provenance: Provenance = {
      source: "webull",
      capturedAt,
      sourceTimestamp: typeof r.quote_time === "number" ? r.quote_time : (typeof r.last_trade_time === "number" ? r.last_trade_time : undefined),
      delayed: this.delayedHint,
      note: r.trade_status ? `trade_status=${r.trade_status}` : undefined,
    };
    return {
      symbol,
      last,
      bid: num(r.bid) ?? 0,
      ask: num(r.ask) ?? 0,
      open: num(r.open) ?? 0,
      high: num(r.high) ?? 0,
      low: num(r.low) ?? 0,
      prevClose,
      regularClose: num(r.close) ?? undefined,
      volume: num(r.volume) ?? 0,
      changePct: prevClose > 0 ? ((last - prevClose) / prevClose) * 100 : 0,
      extendedLast: ext ?? undefined,
      extendedChangePct: ext !== null && prevClose > 0 ? ((ext - prevClose) / prevClose) * 100 : undefined,
      fiftyTwoWeekHigh: num(r.fifty_two_wk_high) ?? undefined,
      fiftyTwoWeekLow: num(r.fifty_two_wk_low) ?? undefined,
      provenance,
    };
  }

  async getDailyBars(symbol: string, days: number): Promise<readonly Bar[]> {
    const category = ETF_HINT.has(symbol.toUpperCase()) ? "US_ETF" : "US_STOCK";
    const count = Math.min(1200, Math.max(30, Math.ceil(days * 0.75) + 10));
    let raw: WebullBarsResponseRaw;
    try {
      raw = await this.client.post<WebullBarsResponseRaw>("/market-data/stocks/bars/list", {
        symbols: [symbol.toUpperCase()],
        category,
        timespan: "D",
        count: String(count),
        real_time_required: true,
      });
    } catch (err) {
      log.warn("Daily bars request failed", { symbol, error: errMsg(err) });
      return [];
    }
    const entry = raw.result?.find((e) => e.symbol?.toUpperCase() === symbol.toUpperCase()) ?? raw.result?.[0];
    if (!entry || !Array.isArray(entry.result)) return [];
    const bars: Bar[] = [];
    for (const b of entry.result) {
      const ts = typeof b.time === "string" ? Date.parse(b.time) : NaN;
      const o = num(b.open), h = num(b.high), l = num(b.low), c = num(b.close), v = num(b.volume);
      if (!Number.isFinite(ts) || o === null || h === null || l === null || c === null) continue;
      bars.push({ symbol: symbol.toUpperCase(), timestamp: ts, open: o, high: h, low: l, close: c, volume: v ?? 0 });
    }
    bars.sort((a, b) => a.timestamp - b.timestamp);
    return bars;
  }

  async getMovers(kind: MoverKind, limit: number): Promise<readonly MoverRow[]> {
    const pageSize = String(Math.min(200, Math.max(1, limit)));
    let apiPath: string;
    let query: Record<string, string>;
    switch (kind) {
      case "gainers":
        apiPath = "/market-data/screeners/gainers-losers/list";
        query = { rank_type: "DAY_1", category: "US_STOCK", sort_by: "CHANGE_RATIO", direction: "DESC", page_size: pageSize };
        break;
      case "losers":
        apiPath = "/market-data/screeners/gainers-losers/list";
        query = { rank_type: "DAY_1", category: "US_STOCK", sort_by: "CHANGE_RATIO", direction: "ASC", page_size: pageSize };
        break;
      case "premarket-gainers":
        apiPath = "/market-data/screeners/gainers-losers/list";
        query = { rank_type: "PRE_MARKET", category: "US_STOCK", sort_by: "CHANGE_RATIO", direction: "DESC", page_size: pageSize };
        break;
      case "premarket-losers":
        apiPath = "/market-data/screeners/gainers-losers/list";
        query = { rank_type: "PRE_MARKET", category: "US_STOCK", sort_by: "CHANGE_RATIO", direction: "ASC", page_size: pageSize };
        break;
      case "most-active":
        apiPath = "/market-data/screeners/top-actives/list";
        query = { rank_type: "TURNOVER", category: "US_STOCK", sort_by: "TURNOVER", direction: "DESC", page_size: pageSize };
        break;
    }
    let raw: WebullScreenerResponseRaw;
    try {
      raw = await this.client.get<WebullScreenerResponseRaw>(apiPath, query);
    } catch (err) {
      log.warn("Screener request failed", { kind, error: errMsg(err) });
      return [];
    }
    if (!Array.isArray(raw.data)) return [];
    const out: MoverRow[] = [];
    for (const r of raw.data) {
      const symbol = typeof r.symbol === "string" ? r.symbol.toUpperCase() : null;
      const last = num(r.price) ?? num(r.close);
      const chg = num(r.change_ratio);
      if (!symbol || last === null || chg === null) continue;
      out.push({ symbol, last, changePct: chg * 100, volume: num(r.volume) ?? 0, marketCap: num(r.market_value) ?? undefined });
    }
    return out.slice(0, limit);
  }

  // Webull has no chain endpoint. Discover contracts, then quote them in
  // batches of 20. Both calls need entitlements we have not exercised yet,
  // so the response shape is validated loosely and logged once.
  async getOptionChain(req: ChainRequest): Promise<OptionChainSnapshot | null> {
    const underlying = req.underlying.toUpperCase();
    const spot = await this.getSnapshots([underlying]);
    const underlyingPrice = spot[0]?.last ?? 0;
    if (underlyingPrice <= 0) {
      log.warn("Option chain: no underlying price", { underlying });
      return null;
    }
    let contracts: unknown;
    try {
      contracts = await this.client.get<unknown>("/trading/instruments/options/contracts/list", {
        category: "US_OPTION",
        underlying_symbols: underlying,
        status: "LISTING",
        end_date: req.fromDate,
        start_date: req.toDate,
      });
    } catch (err) {
      log.warn("Option contract discovery failed (entitlement or shape)", { underlying, error: errMsg(err) });
      return null;
    }
    const osiList = extractOsiSymbols(contracts, underlying);
    if (osiList.length === 0) {
      log.warn("Option contract discovery returned no recognizable symbols", { underlying, topLevelKeys: keysOf(contracts) });
      return null;
    }
    // Keep strikes near spot to respect the 20-per-call quote limit.
    const parsed = osiList.map((osi) => ({ osi, p: parseOsi(osi) })).filter((x) => x.p !== null && x.p.expiration >= req.fromDate && x.p.expiration <= req.toDate);
    const window = req.strikesAroundSpot ?? 12;
    const byExp = new Map<string, { osi: string; strike: number }[]>();
    for (const x of parsed) {
      const arr = byExp.get(x.p!.expiration) ?? [];
      arr.push({ osi: x.osi, strike: x.p!.strike });
      byExp.set(x.p!.expiration, arr);
    }
    const toQuote: string[] = [];
    for (const arr of byExp.values()) {
      const strikes = [...new Set(arr.map((a) => a.strike))].sort((a, b) => a - b);
      const nearest = strikes.map((k) => ({ k, d: Math.abs(k - underlyingPrice) })).sort((a, b) => a.d - b.d).slice(0, window * 2).map((s) => s.k);
      const keep = new Set(nearest);
      for (const a of arr) if (keep.has(a.strike)) toQuote.push(a.osi);
    }
    const quotes: OptionQuote[] = [];
    const capturedAt = Date.now();
    for (let i = 0; i < toQuote.length; i += 20) {
      const chunk = toQuote.slice(i, i + 20);
      let raw: unknown;
      try {
        raw = await this.client.get<unknown>("/market-data/options/snapshots/list", { symbols: chunk.join(","), category: "US_OPTION" });
      } catch (err) {
        log.warn("Option snapshot request failed (OPRA entitlement?)", { underlying, error: errMsg(err) });
        return null;
      }
      if (!this.optionShapeLogged) {
        this.optionShapeLogged = true;
        log.info("Option snapshot raw shape (first call)", { topLevelKeys: keysOf(raw), sample: JSON.stringify(raw).slice(0, 600) });
      }
      for (const q of extractOptionQuotes(raw, underlying)) quotes.push(q);
    }
    if (quotes.length === 0) return null;
    const expirations = [...new Set(quotes.map((q) => q.expiration))].sort();
    return {
      underlying,
      underlyingPrice,
      expirations,
      contracts: quotes,
      provenance: { source: "webull", capturedAt, delayed: this.delayedHint, note: "option snapshot shape validated loosely; confirm on first live run" },
    };
  }

  async getNextEarningsDate(symbol: string): Promise<{ date: string; sourceNote: string } | null> {
    let raw: unknown;
    try {
      raw = await this.client.get<unknown>("/market-data/fundamentals/earnings-calendars/list", { symbol: symbol.toUpperCase(), category: "US_STOCK" });
    } catch (err) {
      log.debug("Earnings calendar request failed", { symbol, error: errMsg(err) });
      return null;
    }
    if (!Array.isArray(raw)) return null;
    const today = new Date().toISOString().slice(0, 10);
    const future = (raw as WebullEarningsRowRaw[])
      .map((r) => (typeof r.expected_publish_date === "string" ? r.expected_publish_date : null))
      .filter((d): d is string => d !== null && d >= today)
      .sort();
    return future.length > 0 ? { date: future[0], sourceNote: "webull earnings-calendars expected_publish_date" } : null;
  }
}

// Pull OCC symbols out of an unknown-shaped contract list response. We
// look for any string field that parses as an OCC compact symbol for the
// underlying, at any depth up to 3 levels.
function extractOsiSymbols(raw: unknown, underlying: string): string[] {
  const found = new Set<string>();
  const visit = (v: unknown, depth: number): void => {
    if (depth > 3 || v === null || v === undefined) return;
    if (typeof v === "string") {
      const p = parseOsi(v);
      if (p && p.underlying === underlying) found.add(v);
      return;
    }
    if (Array.isArray(v)) { for (const x of v) visit(x, depth + 1); return; }
    if (typeof v === "object") { for (const x of Object.values(v as Record<string, unknown>)) visit(x, depth + 1); }
  };
  visit(raw, 0);
  return [...found];
}

function extractOptionQuotes(raw: unknown, underlying: string): OptionQuote[] {
  const rows: unknown[] = Array.isArray(raw) ? raw : (typeof raw === "object" && raw !== null && Array.isArray((raw as { data?: unknown }).data) ? ((raw as { data: unknown[] }).data) : []);
  const out: OptionQuote[] = [];
  for (const r of rows) {
    if (typeof r !== "object" || r === null) continue;
    const o = r as Record<string, unknown>;
    const osi = typeof o.symbol === "string" ? o.symbol : null;
    const p = osi ? parseOsi(osi) : null;
    if (!osi || !p || p.underlying !== underlying) continue;
    const bid = num(o.bid), ask = num(o.ask), last = num(o.price) ?? num(o.last) ?? num(o.close);
    out.push({
      osiSymbol: osi,
      underlying,
      expiration: p.expiration,
      strike: p.strike,
      optionType: p.optionType,
      bid: bid ?? 0,
      ask: ask ?? 0,
      last: last ?? 0,
      volume: num(o.volume) ?? 0,
      openInterest: num(o.open_interest) ?? num(o.openInterest) ?? 0,
      iv: num(o.implied_volatility) ?? num(o.iv),
      delta: num(o.delta),
      gamma: num(o.gamma),
      theta: num(o.theta),
      vega: num(o.vega),
    });
  }
  return out;
}

function keysOf(v: unknown): string[] {
  return typeof v === "object" && v !== null ? Object.keys(v as object).slice(0, 12) : [typeof v];
}

function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
