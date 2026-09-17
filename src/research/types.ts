// Research engine types.
//
// The research engine is the pre-trade half of Gecko: it scans the market,
// gathers evidence, analyzes option structures, and produces a ResearchPacket
// a human (or later the agent brain) can act on. It never places orders.
//
// Every number that came from outside carries Provenance: which provider,
// when it was captured, and whether it is delayed. A packet without
// provenance is not evidence.

import type { OptionType } from "../core/types.js";

// -- Provenance --

export type DataSource = "webull" | "schwab" | "cboe-delayed" | "yahoo" | "manual";

export interface Provenance {
  readonly source: DataSource;
  readonly capturedAt: number;          // Unix ms, when Gecko received it
  readonly sourceTimestamp?: number;    // Unix ms, timestamp reported by the source
  readonly delayed: boolean;            // true if the source is known to be delayed
  readonly delayMinutes?: number;
  readonly note?: string;               // e.g. "after-close snapshot", "IEX only"
}

// -- Underlying data --

export interface UnderlyingSnapshot {
  readonly symbol: string;
  readonly last: number;
  readonly bid: number;
  readonly ask: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly prevClose: number;
  readonly regularClose?: number;       // today's regular-session close when known (after hours)
  readonly volume: number;
  readonly changePct: number;           // vs prevClose, in percent
  readonly extendedLast?: number;       // pre/post-market last if available
  readonly extendedChangePct?: number;
  readonly fiftyTwoWeekHigh?: number;
  readonly fiftyTwoWeekLow?: number;
  readonly provenance: Provenance;
}

export interface DailyStats {
  readonly symbol: string;
  readonly bars: number;                // how many daily bars were used
  readonly atr14: number;               // average true range, 14 periods
  readonly atrPct: number;              // atr14 / last * 100
  readonly avgVolume20: number;
  readonly relativeVolume: number;      // today's volume / avgVolume20
  readonly sma20: number;
  readonly sma50: number;
  readonly high20: number;
  readonly low20: number;
  readonly gapPct: number;              // today's open vs prev close, percent
  readonly rangePositionPct: number;    // where last sits in today's range, 0-100
  readonly fiftyTwoWeekPositionPct: number | null;  // 0 = at low, 100 = at high
  readonly provenance: Provenance;
}

// -- Options --

export interface OptionQuote {
  readonly osiSymbol: string;           // OCC compact symbol, e.g. SPY260918P00750000
  readonly underlying: string;
  readonly expiration: string;          // YYYY-MM-DD
  readonly strike: number;
  readonly optionType: OptionType;
  readonly bid: number;
  readonly ask: number;
  readonly last: number;
  readonly volume: number;
  readonly openInterest: number;
  readonly iv: number | null;           // as a decimal, 0.18 = 18%
  readonly delta: number | null;
  readonly gamma: number | null;
  readonly theta: number | null;        // per day, per share
  readonly vega: number | null;
}

export interface OptionChainSnapshot {
  readonly underlying: string;
  readonly underlyingPrice: number;
  readonly expirations: readonly string[];
  readonly contracts: readonly OptionQuote[];
  readonly provenance: Provenance;
}

export type StructureKind = "long-call" | "long-put" | "call-debit-spread" | "put-debit-spread";

export interface OptionStructure {
  readonly kind: StructureKind;
  readonly direction: "LONG" | "SHORT";  // directional exposure on the underlying
  readonly expiration: string;
  readonly daysToExpiration: number;
  readonly legs: readonly OptionQuote[];
  readonly debitMid: number;             // per share
  readonly debitAsk: number;             // worst-case fill, per share (buy legs at ask, sell legs at bid)
  readonly maxLossPerContract: number;   // dollars, = debitAsk * 100
  readonly maxGainPerContract: number | null;  // dollars; null for uncapped
  readonly rewardToRisk: number | null;        // maxGain / maxLoss for capped structures
  readonly breakeven: number;
  readonly spreadCostPct: number;        // (ask - bid) / mid of the package, percent
  readonly netDelta: number | null;
  readonly netTheta: number | null;      // dollars per day per contract
  readonly contractsForBudget: number;   // how many fit the risk budget at debitAsk
  readonly liquidityFlags: readonly string[];
}

// -- Catalysts / evidence --

export interface Headline {
  readonly title: string;
  readonly publisher: string;
  readonly publishedAt: number;         // Unix ms
  readonly url?: string;
}

export interface CatalystSet {
  readonly symbol: string;
  readonly headlines: readonly Headline[];
  readonly nextEarningsDate: string | null;   // YYYY-MM-DD, null if unknown
  readonly earningsProvenance: Provenance | null;
  readonly macroEventsToday: readonly string[];
  readonly macroEventsNext5Days: readonly { date: string; type: string }[];
  readonly headlinesProvenance: Provenance | null;
}

// -- Candidate and packet --

export interface CandidateFlags {
  readonly gapper: boolean;             // |gap| >= 2%
  readonly highRelativeVolume: boolean; // rvol >= 2
  readonly nearFiftyTwoWeekHigh: boolean;
  readonly nearFiftyTwoWeekLow: boolean;
  readonly aboveSma20: boolean;
  readonly aboveSma50: boolean;
  readonly earningsWithin5Days: boolean;
  readonly macroEventToday: boolean;
}

export interface Candidate {
  readonly symbol: string;
  readonly snapshot: UnderlyingSnapshot;
  readonly stats: DailyStats | null;
  readonly catalysts: CatalystSet | null;
  readonly flags: CandidateFlags;
  readonly chain: OptionChainSnapshot | null;
  readonly structures: readonly OptionStructure[];
  readonly score: number;               // 0-100, purely mechanical ranking; not a forecast
  readonly scoreReasons: readonly string[];
  readonly warnings: readonly string[];
}

export interface ResearchBudget {
  readonly accountEquity: number;
  readonly maxRiskPerTradePct: number;
  readonly maxRiskPerTradeUsd: number;
}

export interface ResearchPacket {
  readonly id: string;
  readonly generatedAt: string;         // ISO
  readonly generatedAtEt: string;       // "YYYY-MM-DD HH:MM ET"
  readonly session: "premarket" | "regular" | "afterhours" | "closed";
  readonly budget: ResearchBudget;
  readonly providers: readonly string[];
  readonly universeSource: string;
  readonly universeSize: number;
  readonly candidates: readonly Candidate[];
  readonly errors: readonly string[];
}
