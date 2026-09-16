// Schwab Trader API research provider.
//
// Wraps the existing SchwabRest client (src/brokers/schwab/rest.ts). Quotes,
// price history, and option chains are the paths Gecko already uses;
// movers is new (see rest.ts getMovers for the verification status).
// Requires a completed Schwab OAuth (npm run auth) and valid tokens.

import { createLogger } from "../../core/logger.js";
import type { Bar } from "../../core/types.js";
import type { SchwabRest } from "../../brokers/schwab/rest.js";
import type { SchwabOptionContract } from "../../brokers/schwab/types.js";
import type { OptionChainSnapshot, OptionQuote, UnderlyingSnapshot } from "../types.js";
import type { ChainRequest, MarketDataProvider, MoverKind, MoverRow } from "./provider.js";

const log = createLogger("schwab-provider");

export class SchwabProvider implements MarketDataProvider {
  readonly name = "schwab";

  constructor(private readonly rest: SchwabRest) {}

  async getSnapshots(symbols: readonly string[]): Promise<readonly UnderlyingSnapshot[]> {
    const out: UnderlyingSnapshot[] = [];
    for (let i = 0; i < symbols.length; i += 100) {
      const chunk = symbols.slice(i, i + 100).map((s) => s.toUpperCase());
      let batch: Awaited<ReturnType<SchwabRest["getQuotes"]>>;
      try {
        batch = await this.rest.getQuotes(chunk);
      } catch (err) {
        log.warn("Quote batch failed", { count: chunk.length, error: errMsg(err) });
        continue;
      }
      const capturedAt = Date.now();
      for (const [sym, q] of Object.entries(batch)) {
        const quote = q.quote as Partial<{
          bidPrice: number; askPrice: number; lastPrice: number; openPrice: number; highPrice: number; lowPrice: number;
          closePrice: number; totalVolume: number; netPercentChange: number; quoteTime: number; tradeTime: number;
          "52WeekHigh": number; "52WeekLow": number;
        }>;
        const last = quote.lastPrice;
        if (typeof last !== "number" || !Number.isFinite(last) || last <= 0) continue;
        const prevClose = typeof quote.closePrice === "number" ? quote.closePrice : 0;
        out.push({
          symbol: sym.toUpperCase(),
          last,
          bid: quote.bidPrice ?? 0,
          ask: quote.askPrice ?? 0,
          open: quote.openPrice ?? 0,
          high: quote.highPrice ?? 0,
          low: quote.lowPrice ?? 0,
          prevClose,
          volume: quote.totalVolume ?? 0,
          changePct: prevClose > 0 ? ((last - prevClose) / prevClose) * 100 : (quote.netPercentChange ?? 0),
          fiftyTwoWeekHigh: quote["52WeekHigh"],
          fiftyTwoWeekLow: quote["52WeekLow"],
          provenance: { source: "schwab", capturedAt, sourceTimestamp: quote.quoteTime ?? quote.tradeTime, delayed: false, note: "delayed flag not reported per quote; confirm entitlement" },
        });
      }
    }
    return out;
  }

  async getDailyBars(symbol: string, days: number): Promise<readonly Bar[]> {
    const end = Date.now();
    const start = end - days * 86_400_000;
    try {
      const h = await this.rest.getPriceHistory({ symbol: symbol.toUpperCase(), periodType: "month", frequencyType: "daily", frequency: 1, startDate: start, endDate: end, needExtendedHoursData: false });
      return h.candles.map((c) => ({ symbol: symbol.toUpperCase(), timestamp: c.datetime, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
    } catch (err) {
      log.warn("Price history failed", { symbol, error: errMsg(err) });
      return [];
    }
  }

  async getMovers(kind: MoverKind, limit: number): Promise<readonly MoverRow[]> {
    const sort = kind === "losers" || kind === "premarket-losers" ? "PERCENT_CHANGE_DOWN" : kind === "most-active" ? "VOLUME" : "PERCENT_CHANGE_UP";
    try {
      const rows = await this.rest.getMovers("EQUITY_ALL", sort, 0);
      return rows
        .filter((r) => typeof r.lastPrice === "number")
        .slice(0, limit)
        .map((r) => ({ symbol: r.symbol, last: r.lastPrice ?? 0, changePct: r.netPercentChange ?? 0, volume: r.totalVolume ?? r.volume ?? 0 }));
    } catch (err) {
      log.warn("Movers failed", { kind, error: errMsg(err) });
      return [];
    }
  }

  async getOptionChain(req: ChainRequest): Promise<OptionChainSnapshot | null> {
    let chain: Awaited<ReturnType<SchwabRest["getOptionChain"]>>;
    try {
      chain = await this.rest.getOptionChain({
        symbol: req.underlying.toUpperCase(),
        contractType: "ALL",
        strikeCount: (req.strikesAroundSpot ?? 12) * 2,
        includeUnderlyingQuote: true,
        strategy: "SINGLE",
        fromDate: req.fromDate,
        toDate: req.toDate,
      });
    } catch (err) {
      log.warn("Option chain failed", { underlying: req.underlying, error: errMsg(err) });
      return null;
    }
    const underlyingPrice = chain.underlying?.last ?? 0;
    const capturedAt = Date.now();
    const contracts: OptionQuote[] = [];
    const push = (map: Record<string, Record<string, readonly SchwabOptionContract[]>>, type: "CALL" | "PUT"): void => {
      for (const [expKey, strikes] of Object.entries(map)) {
        const expiration = expKey.slice(0, 10);
        for (const arr of Object.values(strikes)) {
          for (const c of arr) {
            contracts.push({
              osiSymbol: c.symbol.replace(/\s+/g, ""),
              underlying: req.underlying.toUpperCase(),
              expiration,
              strike: c.strikePrice,
              optionType: type,
              bid: c.bid,
              ask: c.ask,
              last: c.last,
              volume: c.totalVolume,
              openInterest: c.openInterest,
              iv: Number.isFinite(c.volatility) ? c.volatility / 100 : null,
              delta: Number.isFinite(c.delta) ? c.delta : null,
              gamma: Number.isFinite(c.gamma) ? c.gamma : null,
              theta: Number.isFinite(c.theta) ? c.theta : null,
              vega: Number.isFinite(c.vega) ? c.vega : null,
            });
          }
        }
      }
    };
    push(chain.callExpDateMap ?? {}, "CALL");
    push(chain.putExpDateMap ?? {}, "PUT");
    if (contracts.length === 0) return null;
    return {
      underlying: req.underlying.toUpperCase(),
      underlyingPrice,
      expirations: [...new Set(contracts.map((c) => c.expiration))].sort(),
      contracts,
      provenance: { source: "schwab", capturedAt, delayed: chain.isDelayed === true },
    };
  }

  async getNextEarningsDate(): Promise<null> {
    // Schwab's market data API does not expose an earnings calendar.
    return null;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
