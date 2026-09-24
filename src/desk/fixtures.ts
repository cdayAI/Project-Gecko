// Deliberately synthetic and fixed in time. These are not market recommendations.
import type { DeskConfig, ManualPlan, QuoteFrame } from "./types.js";
export const DEMO_TIME = Date.parse("2026-09-17T14:00:00Z");
export function demoPlan(overrides: Partial<ManualPlan> = {}): ManualPlan {
  return { id: "synthetic-demo", version: 1, symbol: "SPY", contract: "SPY260925C00700000", strategy: "synthetic plumbing test",
    direction: "LONG", createdAt: DEMO_TIME - 60_000, validFrom: DEMO_TIME - 30_000, expiresAt: DEMO_TIME + 600_000, timeExit: DEMO_TIME + 3600_000,
    trigger: 700, maxChase: 702, invalidation: 698, maxEntry: 1.5, stopBid: 1.1, targetBid: 2.0, quantity: 1,
    correlationGroup: "US-index", thesis: "Synthetic scenario for software checks", counterevidence: "No real market evidence or validated strategy",
    evidenceIds: [], confidence: "UNVALIDATED", requireNews: false, ...overrides };
}
export function demoConfig(plans: readonly ManualPlan[] = [demoPlan()]): DeskConfig {
  return { policy: { planningEquity: 5000, maxFullLossPerTrade: 250, maxPlannedRiskPerTrade: 50,
    maxAggregateDebit: 500, maxCorrelatedDebit: 250, dailyLossLimit: 100, feePerContractPerSide: 0.10,
    optionsPermissionVerified: true, buyingPower: 5000, positionsReconciledAt: DEMO_TIME - 10_000 }, plans };
}
export function demoFrame(at = DEMO_TIME, price = 700.5, bid = 1.45, ask = 1.5): QuoteFrame {
  const provenance = { source: "manual" as const, capturedAt: at, sourceTimestamp: at - 100, delayed: false, delayMinutes: 0, delayStatus: "real-time" as const, note: "SYNTHETIC TEST FIXTURE" };
  return { capturedAt: at, source: "synthetic", underlying: [{ symbol: "SPY", last: price, bid: price - 0.01, ask: price + 0.01,
    open: 699, high: 702, low: 697, prevClose: 698, volume: 100000, changePct: 0.35, quoteTime: at - 100, lastTradeTime: at - 100,
    bidSize: 100, askSize: 100, provenance }], options: [{ osiSymbol: "SPY260925C00700000", underlying: "SPY", expiration: "2026-09-25",
    strike: 700, optionType: "CALL", bid, ask, last: bid, volume: 100, openInterest: 500, iv: 0.25,
    delta: 0.5, gamma: 0.02, theta: -0.05, vega: 0.03, quoteTime: at - 100, lastTradeTime: at - 200,
    bidSize: 20, askSize: 20, contractVerified: true, contractStandard: true, contractMultiplier: 100, provenance }] };
}
