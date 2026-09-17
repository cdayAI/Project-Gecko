// Expiry payoff sensitivity to historical scenarios. Never an executable trade plan.
import type { OptionChainSnapshot, OptionQuote } from "./types.js";

export interface ScenarioStructure {
  readonly symbol: string;
  readonly kind: "long-call" | "long-put" | "call-debit-spread" | "put-debit-spread";
  readonly long: OptionQuote;
  readonly short: OptionQuote | null;
  readonly spot: number;
  readonly debitAsk: number | null;
  readonly packageBid: number | null;
  readonly fixedFrictionDollars: number;
  readonly frictionReserveDollars: number;
  readonly theoreticalFullDebitRiskDollars: number | null;
  readonly hypotheticalUnitsWithin250: number;
  readonly quoteProblems: readonly string[];
}

export interface PayoffSummary {
  readonly scenarios: number;
  readonly meanPayoffPerShare: number;
  readonly lowerResampledMeanPayoff: number | null;
  readonly netMeanDollars: number;
  readonly worstHistoricalNetDollars: number;
  readonly net10thPercentileDollars: number;
  readonly net90thPercentileDollars: number;
  readonly calibration: "UNVALIDATED_DESCRIPTIVE_SCENARIOS";
}

export const VALUATION_ASSUMPTIONS = Object.freeze({ expiration: "2026-09-25", asOfDate: "2026-09-17",
  horizonSessions: 6, maxFullDebit: 250, feePerLegPerSide: 0.10, extraSlippagePerLegPerSide: 0.01,
  annualFundingRateAssumption: 0.05, calendarDays: 8, minimumScenarios: 30,
  maximumStructuresPerRoot: 4, primaryStructureComparisons: 72, bootstrapReplicates: 5_000, bootstrapBlockObservations: 4 });

function valid(q: OptionQuote): boolean {
  return Number.isFinite(q.bid) && Number.isFinite(q.ask) && q.bid > 0 && q.ask >= q.bid &&
    Number.isFinite(q.strike) && q.strike > 0 && Number.isSafeInteger(q.bidSize) && Number.isSafeInteger(q.askSize) && (q.bidSize ?? 0) >= 1 && (q.askSize ?? 0) >= 1;
}
function issues(q: OptionQuote): string[] {
  const flags: string[] = [];
  if (!valid(q)) flags.push(`${q.osiSymbol}: invalid bid/ask or size`);
  if (!Number.isFinite(q.volume) || q.volume < 50) flags.push(`${q.osiSymbol}: volume below 50 or unavailable`);
  if (!Number.isFinite(q.openInterest) || q.openInterest < 100) flags.push(`${q.osiSymbol}: open interest below 100 or unavailable`);
  if (valid(q) && (q.ask - q.bid) / ((q.ask + q.bid) / 2) > 0.10) flags.push(`${q.osiSymbol}: leg spread above 10% of midpoint`);
  return flags;
}

export function enumerateScenarioStructures(chain: OptionChainSnapshot): ScenarioStructure[] {
  if (!Number.isFinite(chain.underlyingPrice) || chain.underlyingPrice <= 0) throw new Error("Invalid valuation spot");
  const out: ScenarioStructure[] = [];
  for (const right of ["CALL", "PUT"] as const) {
    const quotes = chain.contracts.filter(q => q.underlying === chain.underlying && q.expiration === VALUATION_ASSUMPTIONS.expiration && q.optionType === right)
      .sort((a, b) => Math.abs(a.strike - chain.underlyingPrice) - Math.abs(b.strike - chain.underlyingPrice) || a.strike - b.strike);
    const long = quotes[0]; // Freeze ATM selection before testing quote quality or modeled payoff.
    if (!long) continue;
    const wings = quotes.filter(q => right === "CALL" ? q.strike > long.strike : q.strike < long.strike)
      .sort((a, b) => Math.abs(a.strike - long.strike) - Math.abs(b.strike - long.strike));
    for (const short of [null, wings[0] ?? null]) {
      if (short === null && out.some(s => s.long.osiSymbol === long.osiSymbol && s.short === null)) continue;
      const legs = short ? 2 : 1;
      const debitAsk = long.ask - (short?.bid ?? 0);
      const packageBid = long.bid - (short?.ask ?? 0);
      const friction = legs * 2 * (VALUATION_ASSUMPTIONS.feePerLegPerSide + 100 * VALUATION_ASSUMPTIONS.extraSlippagePerLegPerSide);
      const funding = Math.max(0, debitAsk) * 100 * VALUATION_ASSUMPTIONS.annualFundingRateAssumption * VALUATION_ASSUMPTIONS.calendarDays / 365;
      const risk = Math.max(0, debitAsk) * 100 + friction + funding;
      const flags = [...issues(long), ...(short ? issues(short) : [])];
      if (!Number.isFinite(debitAsk) || debitAsk <= 0 || packageBid > debitAsk) flags.push("Invalid package market");
      if (short && debitAsk >= Math.abs(short.strike - long.strike)) flags.push("Debit consumes full spread width");
      const numeric = valid(long) && (!short || valid(short)) && Number.isFinite(debitAsk) && debitAsk > 0 && Number.isFinite(packageBid) && packageBid <= debitAsk && (!short || debitAsk < Math.abs(short.strike - long.strike));
      out.push({ symbol: chain.underlying, kind: short ? (right === "CALL" ? "call-debit-spread" : "put-debit-spread") : (right === "CALL" ? "long-call" : "long-put"),
        long, short, spot: chain.underlyingPrice, debitAsk: numeric ? debitAsk : null, packageBid: numeric ? packageBid : null,
        fixedFrictionDollars: friction, frictionReserveDollars: numeric ? friction + funding : friction,
        theoreticalFullDebitRiskDollars: numeric ? risk : null, hypotheticalUnitsWithin250: numeric && Number.isFinite(risk) && risk > 0 ? Math.floor(250 / risk) : 0,
        quoteProblems: flags });
    }
  }
  return out;
}

export function expiryPayoffPerShare(s: ScenarioStructure, terminal: number): number {
  if (!Number.isFinite(terminal) || terminal < 0) throw new Error("Invalid terminal underlying price");
  const intrinsic = (q: OptionQuote): number => q.optionType === "CALL" ? Math.max(0, terminal - q.strike) : Math.max(0, q.strike - terminal);
  return intrinsic(s.long) - (s.short ? intrinsic(s.short) : 0);
}

function percentile(sorted: readonly number[], p: number): number { return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]; }

function lowerBootstrapMean(values: readonly number[]): number | null {
  if (values.length < VALUATION_ASSUMPTIONS.minimumScenarios) return null;
  let seed = 20260917;
  const random = (): number => { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return seed / 4294967296; };
  const means: number[] = [];
  for (let r = 0; r < VALUATION_ASSUMPTIONS.bootstrapReplicates; r++) {
    let count = 0, sum = 0;
    while (count < values.length) {
      const start = Math.floor(random() * values.length);
      for (let j = 0; j < VALUATION_ASSUMPTIONS.bootstrapBlockObservations && count < values.length; j++, count++) sum += values[(start + j) % values.length];
    }
    means.push(sum / values.length);
  }
  means.sort((a, b) => a - b);
  return percentile(means, 0.05 / VALUATION_ASSUMPTIONS.primaryStructureComparisons);
}

export function summarizeScenarioPayoffs(s: ScenarioStructure, logReturns: readonly number[]): PayoffSummary | null {
  if (s.debitAsk === null || !Number.isFinite(s.debitAsk) || s.theoreticalFullDebitRiskDollars === null) return null;
  const debit = s.debitAsk;
  if (!logReturns.length) return null;
  if (logReturns.some(r => !Number.isFinite(r))) throw new Error("Invalid historical return");
  const values = logReturns.map(r => expiryPayoffPerShare(s, s.spot * Math.exp(r)));
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const net = values.map(v => (v - debit) * 100 - s.frictionReserveDollars).sort((a, b) => a - b);
  return { scenarios: values.length, meanPayoffPerShare: mean, lowerResampledMeanPayoff: lowerBootstrapMean(values),
    netMeanDollars: (mean - s.debitAsk) * 100 - s.frictionReserveDollars,
    worstHistoricalNetDollars: net[0], net10thPercentileDollars: percentile(net, 0.10), net90thPercentileDollars: percentile(net, 0.90),
    calibration: "UNVALIDATED_DESCRIPTIVE_SCENARIOS" };
}

export function scenarioPriceCeiling(s: ScenarioStructure, unconditional: PayoffSummary | null, conditional: PayoffSummary | null): number | null {
  if (unconditional?.lowerResampledMeanPayoff == null || conditional?.lowerResampledMeanPayoff == null) return null;
  if (s.debitAsk === null) return null;
  const fundingFraction = VALUATION_ASSUMPTIONS.annualFundingRateAssumption * VALUATION_ASSUMPTIONS.calendarDays / 365;
  return Math.max(0, (Math.min(unconditional.lowerResampledMeanPayoff, conditional.lowerResampledMeanPayoff) - s.fixedFrictionDollars / 100) / (1 + fundingFraction));
}
