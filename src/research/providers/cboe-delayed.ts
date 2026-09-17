// Cboe delayed-quote provider (no credentials).
//
// Endpoint: https://cdn.cboe.com/api/global/delayed_quotes/options/{SYMBOL}.json
// Verified live on 2026-09-16 for SPY, QQQ, LEN, GNRC, JBHT, XLE, IWM, KRE,
// TLT, XHB, VICR, FLNC, HBAN. Shape observed:
//   { timestamp: "YYYY-MM-DD HH:MM:SS", symbol, data: {
//       current_price, bid, ask, bid_size, ask_size, open, high, low, close,
//       prev_day_close, volume, iv30, last_trade_time: "YYYY-MM-DDTHH:MM:SS",
//       options: [{ option: "SPY260918P00750000", bid, ask, last_trade_price,
//                   volume, open_interest, iv, delta, gamma, theta, vega, ... }] } }
// Quotes are delayed 15 minutes and the file is a snapshot; after the close
// it reflects the last regular-session marks. Good enough for structure
// analysis and strike selection, not for entry pricing.
//
// Daily bars come from Yahoo (src/data/yahoo-historical.ts). Movers and
// earnings dates are not available from this provider.

import { createLogger } from "../../core/logger.js";
import type { Bar } from "../../core/types.js";
import { YahooHistoricalBars } from "../../data/yahoo-historical.js";
import { fetchWithRetry } from "../../utils/retry.js";
import { parseOsi } from "../osi.js";
import type { OptionChainSnapshot, OptionQuote, UnderlyingSnapshot } from "../types.js";
import type { ChainRequest, MarketDataProvider, MoverRow } from "./provider.js";

const log = createLogger("cboe-delayed");

const BASE = "https://cdn.cboe.com/api/global/delayed_quotes/options";
const CACHE_TTL_MS = 60 * 1000;

interface CboeOptionRaw {
  readonly option?: string;
  readonly bid?: number;
  readonly ask?: number;
  readonly last_trade_price?: number;
  readonly volume?: number;
  readonly open_interest?: number;
  readonly iv?: number;
  readonly delta?: number;
  readonly gamma?: number;
  readonly theta?: number;
  readonly vega?: number;
}

interface CboeFileRaw {
  readonly timestamp?: string;
  readonly symbol?: string;
  readonly data?: {
    readonly current_price?: number;
    readonly bid?: number;
    readonly ask?: number;
    readonly open?: number;
    readonly high?: number;
    readonly low?: number;
    readonly close?: number;
    readonly prev_day_close?: number;
    readonly volume?: number;
    readonly iv30?: number;
    readonly last_trade_time?: string;
    readonly options?: readonly CboeOptionRaw[];
  };
}

export class CboeDelayedProvider implements MarketDataProvider {
  readonly name = "cboe-delayed";
  private readonly cache = new Map<string, { at: number; file: CboeFileRaw }>();
  private readonly yahoo = new YahooHistoricalBars();

  async getSnapshots(symbols: readonly string[]): Promise<readonly UnderlyingSnapshot[]> {
    const out: UnderlyingSnapshot[] = [];
    for (const s of symbols) {
      const file = await this.load(s);
      if (!file?.data) continue;
      const d = file.data;
      const last = d.current_price;
      if (typeof last !== "number" || !(last > 0)) continue;
      const prevClose = d.prev_day_close ?? 0;
      out.push({
        symbol: s.toUpperCase(),
        last,
        bid: d.bid ?? 0,
        ask: d.ask ?? 0,
        open: d.open ?? 0,
        high: d.high ?? 0,
        low: d.low ?? 0,
        prevClose,
        regularClose: typeof d.close === "number" && d.close > 0 ? d.close : undefined,
        volume: d.volume ?? 0,
        changePct: prevClose > 0 ? ((last - prevClose) / prevClose) * 100 : 0,
        provenance: {
          source: "cboe-delayed",
          capturedAt: Date.now(),
          sourceTimestamp: parseCboeTs(file.timestamp),
          delayed: true,
          delayMinutes: 15,
          note: d.last_trade_time ? `last_trade_time=${d.last_trade_time}` : undefined,
        },
      });
    }
    return out;
  }

  async getDailyBars(symbol: string, days: number): Promise<readonly Bar[]> {
    const end = Date.now();
    try {
      return await this.yahoo.fetch({ symbol: symbol.toUpperCase(), interval: "1d", startMs: end - days * 86_400_000, endMs: end, includePrePost: false, cache: false });
    } catch (err) {
      log.warn("Yahoo daily bars failed", { symbol, error: errMsg(err) });
      return [];
    }
  }

  async getMovers(): Promise<readonly MoverRow[]> {
    return [];
  }

  async getOptionChain(req: ChainRequest): Promise<OptionChainSnapshot | null> {
    const file = await this.load(req.underlying);
    if (!file?.data || !Array.isArray(file.data.options)) return null;
    const underlyingPrice = file.data.current_price ?? 0;
    const contracts: OptionQuote[] = [];
    for (const o of file.data.options) {
      if (typeof o.option !== "string") continue;
      const p = parseOsi(o.option);
      if (!p || p.expiration < req.fromDate || p.expiration > req.toDate) continue;
      contracts.push({
        osiSymbol: o.option,
        underlying: p.underlying,
        expiration: p.expiration,
        strike: p.strike,
        optionType: p.optionType,
        bid: o.bid ?? 0,
        ask: o.ask ?? 0,
        last: o.last_trade_price ?? 0,
        volume: o.volume ?? 0,
        openInterest: o.open_interest ?? 0,
        iv: typeof o.iv === "number" && o.iv > 0 ? o.iv : null,
        delta: typeof o.delta === "number" ? o.delta : null,
        gamma: typeof o.gamma === "number" ? o.gamma : null,
        theta: typeof o.theta === "number" ? o.theta : null,
        vega: typeof o.vega === "number" ? o.vega : null,
      });
    }
    if (contracts.length === 0) return null;
    if (req.strikesAroundSpot && underlyingPrice > 0) {
      const byExp = new Map<string, OptionQuote[]>();
      for (const c of contracts) { const a = byExp.get(c.expiration) ?? []; a.push(c); byExp.set(c.expiration, a); }
      const kept: OptionQuote[] = [];
      for (const arr of byExp.values()) {
        const strikes = [...new Set(arr.map((c) => c.strike))].sort((a, b) => Math.abs(a - underlyingPrice) - Math.abs(b - underlyingPrice)).slice(0, req.strikesAroundSpot * 2);
        const keep = new Set(strikes);
        for (const c of arr) if (keep.has(c.strike)) kept.push(c);
      }
      return this.snapshotOf(req.underlying, underlyingPrice, kept, file);
    }
    return this.snapshotOf(req.underlying, underlyingPrice, contracts, file);
  }

  async getNextEarningsDate(): Promise<null> {
    return null;
  }

  private snapshotOf(underlying: string, price: number, contracts: OptionQuote[], file: CboeFileRaw): OptionChainSnapshot {
    return {
      underlying: underlying.toUpperCase(),
      underlyingPrice: price,
      expirations: [...new Set(contracts.map((c) => c.expiration))].sort(),
      contracts,
      provenance: { source: "cboe-delayed", capturedAt: Date.now(), sourceTimestamp: parseCboeTs(file.timestamp), delayed: true, delayMinutes: 15, note: "snapshot file; after the close reflects last regular-session marks" },
    };
  }

  private async load(symbol: string): Promise<CboeFileRaw | null> {
    const key = symbol.toUpperCase();
    const c = this.cache.get(key);
    if (c && Date.now() - c.at < CACHE_TTL_MS) return c.file;
    try {
      const resp = await fetchWithRetry(`${BASE}/${encodeURIComponent(key)}.json`, { headers: { Accept: "application/json" } }, { timeout: 20_000 });
      const file = (await resp.json()) as CboeFileRaw;
      if (typeof file !== "object" || file === null || typeof file.data !== "object") {
        log.warn("Cboe file malformed", { symbol: key });
        return null;
      }
      this.cache.set(key, { at: Date.now(), file });
      return file;
    } catch (err) {
      log.warn("Cboe fetch failed", { symbol: key, error: errMsg(err) });
      return null;
    }
  }
}

// Cboe timestamps are "YYYY-MM-DD HH:MM:SS" with no zone; observed values
// line up with UTC (22:46 for a 6:46 pm ET capture).
function parseCboeTs(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const t = Date.parse(s.replace(" ", "T") + "Z");
  return Number.isFinite(t) ? t : undefined;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
