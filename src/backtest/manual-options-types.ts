export interface OptionReplayConfig {
  readonly maxFrameGapMs: number;
  readonly feePerContractPerSide: number;
  readonly adverseSlippagePerShare: number;
  readonly maxFullLoss: number;
  readonly maxPlannedLoss: number;
  readonly allowSynthetic: boolean;
}

export interface OptionReplayFill {
  readonly at: number;
  readonly quoteTime: number;
  readonly price: number;
  readonly quotedPrice: number;
  readonly quantity: number;
}

export interface OptionReplayResult {
  readonly label: "HYPOTHETICAL_QUOTE_REPLAY_NOT_EXECUTED" | "SYNTHETIC_ENGINE_TEST_NOT_PERFORMANCE";
  readonly planId: string;
  readonly planVersion: number;
  readonly contract: string;
  readonly status: "NO_ENTRY" | "CLOSED" | "UNRESOLVED_DATA_GAP" | "UNRESOLVED_OPEN_POSITION" | "BLOCKED_NEWS_EVIDENCE";
  readonly entry: OptionReplayFill | null;
  readonly exit: OptionReplayFill | null;
  readonly exitReason: "premium-stop" | "underlying-invalidation" | "target" | "time" | null;
  readonly netPnl: number | null;
  readonly fullPremiumLoss: number | null;
  readonly plannedLoss: number | null;
  readonly events: readonly { readonly at: number; readonly type: string; readonly detail: string }[];
}
