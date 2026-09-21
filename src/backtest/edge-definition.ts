import type { EdgeCosts, EdgeFamily } from "./edge-types.js";

// Frozen before market-data execution. These are hypotheses, not established edges.
export const FROZEN_EDGE_DEFINITION = Object.freeze({
  version: "edge-four-families-v1" as const,
  families: Object.freeze(["opening-range-continuation", "failed-opening-range-breakout", "vwap-trend-pullback", "vwap-overextension-reversal"] as readonly EdgeFamily[]),
  settings: Object.freeze({
    intervalMinutes: 5, openingStart: 570, openingEnd: 585, firstSignalKnownMinute: 590,
    lastSignalKnownMinute: 655, entryCutoff: 660, exitMinute: 690,
    startingEquity: 5_000, maxNotional: 1_000, plannedRisk: 25, dailyLossLimit: 50,
    minimumStopPct: 0.10, maximumStopPct: 2.5, targetR: 2,
    continuationMaximumExtensionR: 0.25, failureStopBuffer: 0.01,
    reversalMinimumPriorDistancePct: 0.75, reversalMinimumPriceMovePct: 0.10,
  }),
  costs: Object.freeze({ slippageBpsPerSide: 2, minimumSlippagePerShare: 0.005, feePerOrder: 1 } satisfies EdgeCosts),
  descriptions: Object.freeze({
    vwap: "Cumulative regular-session typical-price (high+low+close)/3 times volume divided by cumulative volume, completed bars only; not trade-level VWAP.",
    openingRange: "High/low of exactly three contiguous 09:30,09:35,09:40 ET five-minute bars.",
    continuation: "Completed close strictly above OR high and VWAP => LONG; below OR low and VWAP => SHORT. Stop opposite OR. Immediate next open must remain outside OR, with extension <=0.25 OR widths.",
    failure: "Previous completed close strictly outside OR; signal close back inside inclusive OR bounds. Fade failed side. Stop previous bar high+0.01 for SHORT or low-0.01 for LONG.",
    pullback: "Prior two closes each strictly above their own completed VWAP and current VWAP>previous VWAP; signal low<=current VWAP and close>current VWAP => LONG. Mirror for SHORT. Stop extreme of previous two bars plus signal bar, no buffer.",
    reversal: "Previous close at least0.75% from previous VWAP. Signal close moves toward current VWAP by at least0.10% of previous close, absolute dollar distance to its own VWAP decreases versus previous close's distance to previous VWAP, and remains on previous extended side. Fade extension. Stop extreme of previous two bars plus signal bar, no buffer.",
    entry: "Signal availability09:50-10:55 ET inclusive; immediate next-bar open before11ET. Directional stop distance after entry friction must be0.10%-2.5% of raw entry. One first signal per symbol/day even if rejected. One shared position; alphabetic simultaneous tie-break.",
    sizing: "Integer diagnostic shares, $25 planned stop loss including costs, $1000 gross notional, $5000 initial equity. Each entry reserves at most min($25, max($0, $50 + realized daily P&L)), including round-trip fees and stop slippage; no entry when the remaining allowance cannot cover fees and one share. Stop gaps can still exceed the planned daily allowance. Short notional is reserved without recycling short-sale proceeds. No stock borrow or margin qualification.",
    exit: "2R target from friction-adjusted entry,11:30ET next-open time exit, adverse stop first if both extremes touched, stop gaps at worse open, no favorable target gap improvement. Intrabar outcomes recognized only at close.",
    data: "Missing intervals disable new session signals when observed. Missing held-position next bar terminates as unresolved with null total P&L; no future recovery or manufactured gap fill. Invalid/duplicate/misaligned bars rejected.",
  }),
});

export const DOUBLE_EDGE_COSTS: EdgeCosts = Object.freeze({ slippageBpsPerSide: 4, minimumSlippagePerShare: 0.01, feePerOrder: 2 });
