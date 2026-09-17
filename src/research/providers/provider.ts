// Market data provider interface for the research engine.
//
// Deliberately separate from brokers/broker.ts: the research engine needs
// batch quotes, daily bars, screeners, and full option chains, while the
// trading Broker interface is built around streaming ticks and orders. A
// research provider never places orders and needs no account.
//
// Providers return null or empty when a capability is not available (for
// example no options entitlement) and log why. Callers treat missing data
// as missing, never as zero.

import type { Bar } from "../../core/types.js";
import type { OptionChainSnapshot, UnderlyingSnapshot } from "../types.js";

export interface MoverRow {
  readonly symbol: string;
  readonly last: number;
  readonly changePct: number;
  readonly volume: number;
  readonly marketCap?: number;
}

export type MoverKind = "gainers" | "losers" | "most-active" | "premarket-gainers" | "premarket-losers";

export interface ChainRequest {
  readonly underlying: string;
  readonly fromDate: string;           // YYYY-MM-DD inclusive
  readonly toDate: string;             // YYYY-MM-DD inclusive
  readonly strikesAroundSpot?: number; // keep N strikes each side of spot; provider may ignore
}

export interface MarketDataProvider {
  readonly name: string;

  // Batch snapshots. Symbols that fail validation are omitted.
  getSnapshots(symbols: readonly string[]): Promise<readonly UnderlyingSnapshot[]>;

  // Daily bars, ascending, at least `days` calendar days back.
  getDailyBars(symbol: string, days: number): Promise<readonly Bar[]>;

  // Market movers. Empty array if unsupported.
  getMovers(kind: MoverKind, limit: number): Promise<readonly MoverRow[]>;

  // Option chain for the expiration window. null if unsupported or unentitled.
  getOptionChain(req: ChainRequest): Promise<OptionChainSnapshot | null>;

  // Next earnings date, YYYY-MM-DD, or null if unknown/unsupported.
  getNextEarningsDate(symbol: string): Promise<{ date: string; sourceNote: string } | null>;
}
