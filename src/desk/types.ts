import type { OptionQuote, UnderlyingSnapshot } from "../research/types.js";

export interface ManualPlan {
  readonly id: string;
  readonly version: number;
  readonly symbol: string;
  readonly contract: string;
  readonly strategy: string;
  readonly direction: "LONG" | "SHORT";
  readonly createdAt: number;
  readonly validFrom: number;
  readonly expiresAt: number;
  readonly timeExit: number;
  readonly trigger: number;
  readonly maxChase: number;
  readonly invalidation: number;
  readonly maxEntry: number;
  readonly stopBid: number;
  readonly targetBid: number;
  readonly quantity: number;
  readonly correlationGroup: string;
  readonly thesis: string;
  readonly counterevidence: string;
  readonly evidenceIds: readonly string[];
  readonly researchPacketId?: string;
  readonly confidence: "UNVALIDATED";
  readonly requireNews: boolean;
}

export interface DeskPolicy {
  readonly planningEquity: number;
  readonly maxFullLossPerTrade: number;
  readonly maxPlannedRiskPerTrade: number;
  readonly maxAggregateDebit: number;
  readonly maxCorrelatedDebit: number;
  readonly dailyLossLimit: number;
  readonly feePerContractPerSide: number;
  readonly optionsPermissionVerified: boolean;
  readonly buyingPower: number | null;
  readonly positionsReconciledAt: number | null;
}

export interface DeskConfig {
  readonly policy: DeskPolicy;
  readonly plans: readonly ManualPlan[];
}

export interface QuoteFrame {
  readonly capturedAt: number;
  readonly underlying: readonly UnderlyingSnapshot[];
  readonly options: readonly OptionQuote[];
  readonly source: "webull" | "recorded" | "synthetic";
}

export type PlanStatus = "WATCHING" | "ELIGIBLE" | "DATA_BLOCKED" | "RISK_BLOCKED" | "INVALIDATED" | "EXPIRED" | "OPEN" | "EXIT_WATCH" | "CLOSED";

export interface PlanUpdate {
  readonly planId: string;
  readonly version: number;
  readonly at: number;
  readonly status: PlanStatus;
  readonly reasons: readonly string[];
  readonly contract: string;
  readonly quoteTime: number | null;
  readonly validUntil: number;
  readonly bid: number | null;
  readonly ask: number | null;
  readonly quantity: number;
  readonly plannedRisk: number;
  readonly fullLoss: number;
  readonly targetProfitScenario: number;
  readonly probabilityOfProfit: null;
}
