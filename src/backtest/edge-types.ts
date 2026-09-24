export type EdgeFamily = "opening-range-continuation" | "failed-opening-range-breakout" | "vwap-trend-pullback" | "vwap-overextension-reversal";
export type EdgeDirection = "LONG" | "SHORT";

export interface EdgeCosts {
  readonly slippageBpsPerSide: number;
  readonly minimumSlippagePerShare: number;
  readonly feePerOrder: number;
}

export interface EdgeTrade {
  readonly family: EdgeFamily;
  readonly symbol: string;
  readonly session: string;
  readonly direction: EdgeDirection;
  readonly signalBarStart: number;
  readonly signalKnownAt: number;
  readonly signalClose: number;
  readonly signalVwap: number;
  readonly entryTime: number;
  readonly entryRaw: number;
  readonly entryPrice: number;
  readonly quantity: number;
  readonly stop: number;
  readonly target: number;
  readonly plannedLossAtStop: number;
  readonly exitTime: number;
  readonly exitIntervalStart: number;
  readonly exitRaw: number;
  readonly exitPrice: number;
  readonly reason: "stop" | "ambiguous-stop-first" | "gap-stop" | "target" | "time";
  readonly grossPnl: number;
  readonly slippageCost: number;
  readonly fees: number;
  readonly netPnl: number;
}

export interface EdgeEvent {
  readonly timestamp: number;
  readonly session: string;
  readonly symbol: string;
  readonly type: "signal" | "entry" | "exit" | "rejected" | "data-gap";
  readonly detail: string;
}

export interface EdgeSessionResult {
  readonly session: string;
  readonly tradeCount: number;
  readonly grossPnl: number;
  readonly slippageCost: number;
  readonly fees: number;
  readonly netPnl: number | null;
  readonly complete: boolean;
}

export interface EdgeResult {
  readonly label: "UNDERLYING_DIRECTION_DIAGNOSTIC_NOT_OPTIONS_PNL";
  readonly definitionVersion: "edge-four-families-v1";
  readonly family: EdgeFamily;
  readonly costs: EdgeCosts;
  readonly shortsAreHypothetical: true;
  readonly stockBorrowAndMarginModeled: false;
  readonly bars: number;
  readonly sessionDates: readonly string[];
  readonly sessions: readonly EdgeSessionResult[];
  readonly trades: readonly EdgeTrade[];
  readonly events: readonly EdgeEvent[];
  readonly dataQualityIssues: readonly string[];
  readonly unresolvedPosition: { readonly symbol: string; readonly session: string; readonly entryTime: number; readonly detectedAt: number; readonly reason: string } | null;
  readonly eligibleForRanking: boolean;
  readonly startingEquity: number;
  readonly endingRealizedEquity: number;
  readonly completedNetPnl: number;
  readonly netPnl: number | null;
  readonly grossPnl: number;
  readonly slippageCost: number;
  readonly fees: number;
  readonly winRate: number | null;
  readonly profitFactor: number | null;
  readonly maxFiveMinuteLiquidationDrawdown: number;
}
