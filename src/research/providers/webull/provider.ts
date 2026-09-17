// Webull OpenAPI research provider.
//
// Capabilities and entitlements (developer.webull.com, Market Data API
// overview, checked 2026-09-16):
//   - US stock/ETF snapshots, depth, bars: requires an OpenAPI market data
//     subscription (Nasdaq Basic or TotalView, non-display). Sandbox returns
//     15-minute delayed data by default.
//   - US option snapshots/bars/ticks: requires OPRA Real-Time Non-display.
//     20 symbols per call; sandbox30/min and production60/min per endpoint.
//   - Option contract discovery: /trading/instruments/options/contracts/list
//     (SDK GetOptionContractsRequestV2). Reference and option shapes observed on 2026-09-17.
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
  private readonly references = new Map<string, WebullContractReference>();

  constructor(private readonly client: WebullClient, _legacyDelayedHint?: boolean) {}

  async getSnapshots(symbols: readonly string[]): Promise<readonly UnderlyingSnapshot[]> {
    const out: UnderlyingSnapshot[] = [];
    // The observed successful non-display request used US_STOCK for both
    // equities and ETFs. Do not substitute an unqualified category on errors.
    const normalized = [...new Set(symbols.map(s => s.toUpperCase()))];
    if (normalized.some(s => !/^[A-Z][A-Z0-9.-]{0,14}$/.test(s))) throw new Error("Invalid underlying symbol");
    for (let i = 0; i < normalized.length; i += 100) {
      const chunk = normalized.slice(i, i + 100);
      const rows = await this.fetchSnapshots(chunk, "US_STOCK");
      out.push(...rows.filter(row => chunk.includes(row.symbol)));
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
      if (!record(row)) continue;
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
      sourceTimestamp: integer(r.quote_time),
      ...delayMetadata(r.delay_minutes),
      note: r.trade_status ? `trade_status=${r.trade_status}` : undefined,
    };
    return {
      symbol,
      last,
      bid: num(r.bid) ?? 0,
      ask: num(r.ask) ?? 0,
      bidSize: num(r.bid_size) ?? undefined,
      askSize: num(r.ask_size) ?? undefined,
      quoteTime: integer(r.quote_time),
      lastTradeTime: integer(r.last_trade_time),
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

  // Exact reference discovery is the preferred startup path for a manual
  // monitor. It does not rely on a complete or correctly ordered full chain.
  async getContractReferences(symbols: readonly string[]): Promise<readonly string[]> {
    const selected = validateSymbols(symbols);
    for (const symbol of selected) this.references.delete(symbol);
    const verified: string[] = [];
    for (let i = 0; i < selected.length; i += 20) {
      const chunk = selected.slice(i, i + 20);
      const raw = await this.client.get<unknown>("/trading/instruments/options/contracts/list",
        { category: "US_OPTION", option_symbols: chunk.join(",") });
      for (const ref of parseWebullContractReferences(raw, Date.now())) {
        if (chunk.includes(ref.symbol)) {
          this.references.set(ref.symbol, ref);
          if (ref.verified) verified.push(ref.symbol);
        }
      }
    }
    return verified;
  }

  async getOptionQuotes(symbols: readonly string[]): Promise<readonly OptionQuote[]> {
    const selected = validateSymbols(symbols);
    const output: OptionQuote[] = [];
    for (let i = 0; i < selected.length; i += 20) {
      const chunk = selected.slice(i, i + 20);
      const raw = await this.client.get<unknown>("/market-data/options/snapshots/list",
        { symbols: chunk.join(","), category: "US_OPTION" });
      const quotes = parseWebullOptionSnapshots(raw, Date.now(), this.references);
      const seen = new Set<string>();
      for (const quote of quotes) {
        if (!chunk.includes(quote.osiSymbol) || seen.has(quote.osiSymbol)) {
          throw new Error("Webull option response contained unexpected or duplicate symbols");
        }
        seen.add(quote.osiSymbol);
        output.push(quote);
      }
    }
    return output;
  }

  // Discovery is bounded and never represented as a complete market chain.
  // For known contracts, use getContractReferences + getOptionQuotes instead.
  async getOptionChain(req: ChainRequest): Promise<OptionChainSnapshot | null> {
    const underlying = req.underlying.toUpperCase();
    if (!/^[A-Z]{1,6}$/.test(underlying) || !validDate(req.fromDate) || !validDate(req.toDate)
      || req.fromDate > req.toDate || Date.parse(req.toDate) - Date.parse(req.fromDate) > 90 * 86_400_000) {
      throw new Error("Invalid or unbounded Webull chain request");
    }
    const window = req.strikesAroundSpot ?? 12;
    if (!Number.isSafeInteger(window) || window < 1 || window > 20) throw new Error("Invalid strike window");
    const spot = await this.getSnapshots([underlying]);
    const underlyingSnapshot = spot.find((row) => row.symbol === underlying);
    if (!underlyingSnapshot) return null;
    let raw: unknown;
    try {
      raw = await this.client.get<unknown>("/trading/instruments/options/contracts/list", {
        category: "US_OPTION", underlying_symbols: underlying, root_symbol: underlying,
        status: "LISTING", end_date: req.fromDate, start_date: req.toDate,
      });
    } catch (err) {
      log.warn("Bounded option discovery failed", { underlying, error: errMsg(err) });
      return null;
    }
    const refs = parseWebullContractReferences(raw, Date.now()).filter((ref) =>
      ref.underlying === underlying && ref.expiration >= req.fromDate && ref.expiration <= req.toDate);
    for (const ref of refs) this.references.set(ref.symbol, ref);
    const selected = refs.sort((a, b) => Math.abs(a.strike - underlyingSnapshot.last) - Math.abs(b.strike - underlyingSnapshot.last)
      || a.expiration.localeCompare(b.expiration)).slice(0, Math.min(40, window * 4)).map((ref) => ref.symbol);
    if (!selected.length) return null;
    const quotes = await this.getOptionQuotes(selected);
    return {
      underlying, underlyingPrice: underlyingSnapshot.last, underlyingSnapshot,
      expirations: [...new Set(quotes.map((q) => q.expiration))].sort(), contracts: quotes,
      provenance: { source: "webull", capturedAt: Date.now(), delayed: quotes.some((q) => q.provenance?.delayed === true),
        delayStatus: quotes.length > 0 && quotes.every((q) => q.provenance?.delayMinutes === 0) ? "real-time" : "unknown",
        note: "Bounded discovery; pagination and date-range completeness not qualified. Use per-contract timestamps." },
      completeness: { discovery: "bounded", quotesComplete: quotes.length === selected.length,
        requested: selected.length, returned: quotes.length },
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

export interface WebullContractReference {
  readonly symbol: string;
  readonly underlying: string;
  readonly expiration: string;
  readonly strike: number;
  readonly multiplier: number | null;
  readonly standard: boolean;
  readonly verified: boolean;
  readonly capturedAt: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0, 10) === value;
}
function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
function delayMetadata(value: unknown): Pick<Provenance, "delayed" | "delayStatus" | "delayMinutes"> {
  const delay = typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  return { delayMinutes: delay, delayed: delay !== undefined && delay > 0,
    delayStatus: delay === undefined ? "unknown" : delay === 0 ? "real-time" : "delayed" };
}
function validateSymbols(symbols: readonly string[]): string[] {
  if (!Array.isArray(symbols) || !symbols.length || symbols.length > 40
    || symbols.some((symbol) => typeof symbol !== "string" || !parseOsi(symbol))) throw new Error("Expected 1-40 exact OSI symbols");
  return [...new Set(symbols)];
}

export function parseWebullContractReferences(raw: unknown, capturedAt: number): WebullContractReference[] {
  if (!record(raw) || !Array.isArray(raw.data) || raw.data.length > 2000) throw new Error("Invalid Webull option reference wrapper or unbounded result");
  const seen = new Set<string>();
  const output: WebullContractReference[] = [];
  for (const row of raw.data) {
    if (!record(row) || typeof row.symbol !== "string") throw new Error("Invalid Webull option reference row");
    const parsed = parseOsi(row.symbol);
    if (!parsed || !validDate(parsed.expiration) || seen.has(row.symbol)) throw new Error("Invalid or duplicate Webull contract identity");
    seen.add(row.symbol);
    const multiplier = num(row.multiplier);
    const standard = row.def_type === "STANDARD";
    const verified = standard && multiplier === 100 && row.underlying_symbol === parsed.underlying
      && row.root_symbol === parsed.underlying && row.expiration_date === parsed.expiration
      && row.option_type === parsed.optionType && num(row.strike_price) === parsed.strike
      && row.status === "LISTING" && row.tradable_status === "OC"
      && row.currency === "USD" && row.style === "AMERICAN" && row.settlement_method === "PHYSICAL";
    output.push({ symbol: row.symbol, underlying: parsed.underlying, expiration: parsed.expiration,
      strike: parsed.strike, multiplier, standard, verified, capturedAt });
  }
  return output;
}

export function parseWebullOptionSnapshots(raw: unknown, capturedAt: number,
  references: ReadonlyMap<string, WebullContractReference> = new Map()): OptionQuote[] {
  const rows: unknown[] | null = Array.isArray(raw) ? raw : record(raw) && Array.isArray(raw.data) ? raw.data : null;
  if (!rows || rows.length > 20) throw new Error("Invalid Webull option snapshot wrapper or batch size");
  const output: OptionQuote[] = [];
  for (const row of rows) {
    if (!record(row) || typeof row.symbol !== "string") throw new Error("Invalid Webull option snapshot row");
    const parsed = parseOsi(row.symbol);
    if (!parsed || !validDate(parsed.expiration)) throw new Error("Invalid Webull option snapshot identity");
    const ref = references.get(row.symbol);
    output.push({
      osiSymbol: row.symbol, underlying: parsed.underlying, expiration: parsed.expiration,
      strike: parsed.strike, optionType: parsed.optionType,
      bid: num(row.bid) ?? NaN, ask: num(row.ask) ?? NaN, last: num(row.price) ?? NaN,
      bidSize: num(row.bid_size) ?? undefined, askSize: num(row.ask_size) ?? undefined,
      quoteTime: integer(row.quote_time), lastTradeTime: integer(row.last_trade_time),
      provenance: { source: "webull", capturedAt, sourceTimestamp: integer(row.quote_time), ...delayMetadata(row.delay_minutes) },
      contractVerified: ref?.verified === true && capturedAt >= ref.capturedAt && capturedAt - ref.capturedAt <= 86_400_000,
      contractStandard: ref?.standard, contractMultiplier: ref?.multiplier ?? undefined,
      volume: num(row.volume) ?? NaN, openInterest: num(row.open_interest) ?? NaN,
      iv: num(row.imp_vol), delta: num(row.delta), gamma: num(row.gamma),
      theta: num(row.theta), vega: num(row.vega),
    });
  }
  return output;
}

function num(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
function errMsg(error: unknown): string { return error instanceof Error ? error.message : String(error); }
