import type { Bar } from "../core/types.js";

export interface ManualHypothesis {
  readonly version: "underlying-orb-v1";
  readonly intervalMinutes: 5;
  readonly startingCash: number;
  readonly maxNotional: number;
  readonly plannedRisk: number;
  readonly dailyLossLimit: number;
  readonly openingStart: number;
  readonly openingEnd: number;
  readonly entryCutoff: number;
  readonly exitMinute: number;
  readonly minimumRangePct: number;
  readonly maximumRangePct: number;
  readonly maximumEntryExtensionR: number;
  readonly rewardR: number;
  readonly slippageBpsPerSide: number;
  readonly minimumSlippagePerShare: number;
  readonly feePerOrder: number;
}

export interface ManualPlan {
  readonly schemaVersion: 1;
  readonly createdAt: string;
  readonly startDate: string;
  readonly endDateExclusive: string;
  readonly holdoutStartDate: string;
  readonly symbols: readonly string[];
  readonly hypothesis: ManualHypothesis;
  readonly codeHashes: Readonly<Record<string, string>>;
  readonly label: "UNDERLYING_ONLY_DIAGNOSTIC_NOT_OPTIONS_PNL";
}

export interface InputEvidence {
  readonly symbol: string;
  readonly source: "YahooHistoricalBars-public-chart";
  readonly retrievedAt: string;
  readonly interval: "5m";
  readonly includePrePost: false;
  readonly cache: false;
  readonly requestStartMs: number;
  readonly requestEndMs: number;
  readonly normalizedInputFile: string;
  readonly sha256: string;
  readonly barCount: number;
  readonly firstBar: string | null;
  readonly lastBar: string | null;
  readonly error: string | null;
}

export interface ManualTrade {
  readonly symbol: string;
  readonly session: string;
  readonly signalBarStart: number;
  readonly signalKnownAt: number;
  readonly entryTime: number;
  readonly exitTime: number;
  readonly exitIntervalStart: number;
  readonly direction: "LONG";
  readonly quantity: number;
  readonly entryRaw: number;
  readonly entryPrice: number;
  readonly stop: number;
  readonly target: number;
  readonly exitRaw: number;
  readonly exitPrice: number;
  readonly grossPnl: number;
  readonly slippageCost: number;
  readonly fees: number;
  readonly netPnl: number;
  readonly plannedLossAtStop: number;
  readonly reason: "stop" | "ambiguous-stop-first" | "gap-stop" | "target" | "time" | "data-gap";
}

export interface ManualEvent {
  readonly timestamp: number;
  readonly symbol: string;
  readonly type: string;
  readonly detail: string;
}

export interface ManualResult {
  readonly label: "UNDERLYING_ONLY_DIAGNOSTIC_NOT_OPTIONS_PNL";
  readonly bars: number;
  readonly sessionDates: readonly string[];
  readonly trades: readonly ManualTrade[];
  readonly events: readonly ManualEvent[];
  readonly unresolvedPosition: { readonly symbol: string; readonly entryTime: number } | null;
  readonly startingCash: number;
  readonly endingRealizedEquity: number;
  readonly netPnl: number;
  readonly grossPnl: number;
  readonly fees: number;
  readonly slippageCost: number;
  readonly winRate: number | null;
  readonly profitFactor: number | null;
  readonly maxFiveMinuteLiquidationDrawdown: number;
  readonly returnPct: number;
}

export interface EvidenceRun {
  readonly plan: ManualPlan;
  readonly inputs: readonly InputEvidence[];
  readonly bars: readonly Bar[];
}
