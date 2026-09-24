// Night list (plan) shapes shared by the evening builder and the morning packet.

export interface PlanCandidate {
  readonly symbol: string;
  readonly tags: readonly string[];          // AH+, AH-, ER-AMC, ER-BMO, ER?, CONT+, CONT-
  readonly side: "long" | "short" | "either";
  readonly close: number;
  readonly ahLast: number | null;
  readonly ahPct: number | null;
  readonly starLevel: number;                // close +10% (long/either) or -10% (short)
  readonly high20: number | null;
  readonly atr: number | null;
  readonly sector: string;
}

export interface PlanFile {
  readonly for: string;                      // session the plan is for, YYYY-MM-DD
  readonly builtAt: string;                  // ISO
  readonly provider: string;
  readonly candidates: readonly PlanCandidate[];
}
