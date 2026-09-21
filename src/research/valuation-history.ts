import type { Bar } from "../core/types.js";
import { etParts } from "../utils/time.js";

export type HistoricalRegimeState = {
  readonly featureKnownDate: string;
  readonly close: number;
  readonly sma50: number;
  readonly aboveSma50: boolean;
  readonly annualizedVolatility: number;
  readonly volatilityBand: "below-25pct" | "25-to-60pct" | "60pct-or-above";
};

export type HistoricalScenario = {
  readonly anchorDate: string;
  readonly featureKnownDate: string;
  readonly endDate: string;
  readonly anchorClose: number;
  readonly endClose: number;
  readonly logReturn: number;
  readonly matchesCurrentRegime: boolean;
  readonly regime: HistoricalRegimeState;
};

export type HistoricalScenarioModel = {
  readonly label: "HISTORICAL_CLOSE_ANCHORED_SCENARIOS_NOT_FORECAST_OR_OPTIONS_BACKTEST";
  readonly status: "research";
  readonly models: readonly ["unconditional", "lagged-trend-volatility"];
  readonly horizonSessions: number;
  readonly asOfDate: string;
  readonly symbol: string | null;
  readonly lastCompletedDate: string | null;
  readonly currentState: HistoricalRegimeState | null;
  readonly allScenarios: readonly HistoricalScenario[];
  readonly matchedScenarios: readonly HistoricalScenario[];
  readonly matchedCount: number;
  readonly insufficient: boolean;
  readonly adjustmentConvention: "unverified";
  readonly sessionCalendarValidated: false;
  readonly flags: readonly string[];
};

type DatedBar = { readonly bar: Bar; readonly date: string };

// Registered fixed definitions, with no outcome-driven parameter overrides.
export const VALUATION_HISTORY_DEFINITION = Object.freeze({
  version: "close-anchored-two-models-v1", firstAnchorIndex: 51,
  trendWindow: 50, volatilityReturns: 20, volatilityDenominator: 19,
  annualizationSessions: 252, lowerVolatilityBoundary: 0.25,
  upperVolatilityBoundary: 0.60, minimumConditionalSamples: 30,
});

function validDate(date: string): boolean {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const timestamp = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === date;
}

function validatedDailyBars(input: readonly Bar[]): DatedBar[] {
  const seen = new Set<string>();
  let symbol: string | null = null;
  const rows: DatedBar[] = [];
  for (const b of input) {
    if (!b || typeof b !== "object" || typeof b.symbol !== "string" || !/^[A-Z][A-Z0-9.-]{0,14}$/.test(b.symbol) ||
        ![b.timestamp, b.open, b.high, b.low, b.close, b.volume].every((v) => typeof v === "number" && Number.isFinite(v)) ||
        !Number.isInteger(b.timestamp) || b.timestamp <= 0 || b.timestamp > 8.64e15 ||
        b.open <= 0 || b.high <= 0 || b.low <= 0 || b.close <= 0 || b.volume < 0 ||
        b.high < Math.max(b.open, b.close, b.low) || b.low > Math.min(b.open, b.close)) throw new Error("Malformed daily bar");
    if (symbol !== null && symbol !== b.symbol) throw new Error("Historical scenarios require exactly one underlying symbol");
    symbol = b.symbol;
    const p = etParts(b.timestamp);
    if (!validDate(p.date) || p.dayOfWeek === 0 || p.dayOfWeek === 6) throw new Error("Daily bar has an invalid or weekend ET session date");
    if (seen.has(p.date)) throw new Error(`Duplicate daily session: ${p.date}`);
    seen.add(p.date);
    rows.push({ bar: b, date: p.date });
  }
  return rows.sort((a, b) => a.bar.timestamp - b.bar.timestamp);
}

function regimeAt(rows: readonly DatedBar[], index: number): HistoricalRegimeState | null {
  const d = VALUATION_HISTORY_DEFINITION;
  if (index < d.trendWindow - 1) return null;
  const first = index - d.trendWindow + 1;
  let sma50 = rows[first].bar.close;
  // Incremental averaging preserves equality for constant-price histories.
  for (let i = first + 1; i <= index; i++) sma50 += (rows[i].bar.close - sma50) / (i - first + 1);
  const returns: number[] = [];
  for (let i = index - d.volatilityReturns + 1; i <= index; i++) returns.push(Math.log(rows[i].bar.close) - Math.log(rows[i - 1].bar.close));
  const mean = returns.reduce((sum, value) => sum + value, 0) / d.volatilityReturns;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / d.volatilityDenominator;
  const annualizedVolatility = Math.sqrt(variance) * Math.sqrt(d.annualizationSessions);
  const volatilityBand = annualizedVolatility < d.lowerVolatilityBoundary ? "below-25pct" :
    annualizedVolatility < d.upperVolatilityBoundary ? "25-to-60pct" : "60pct-or-above";
  return { featureKnownDate: rows[index].date, close: rows[index].bar.close, sma50,
    aboveSma50: rows[index].bar.close >= sma50, annualizedVolatility, volatilityBand };
}

/**
 * Pure close-anchored scenarios. Each bar must represent one completed daily
 * session and be timestamped on its ET session date. The caller must verify
 * exchange-calendar completeness and source adjustment conventions. Session
 * horizons count supplied daily bars; this module cannot certify missing dates.
 * Historical features stop before the anchor close. Current features use the
 * last completed close strictly before asOfDate, never the as-of session.
 */
export function buildHistoricalScenarios(bars: readonly Bar[], horizonSessions: number, asOfDate: string): HistoricalScenarioModel {
  if (!Number.isInteger(horizonSessions) || horizonSessions < 1 || horizonSessions > 20) throw new Error("Horizon sessions must be an integer from1 through20");
  if (!validDate(asOfDate)) throw new Error("asOfDate must be a valid YYYY-MM-DD date");
  // Validate all supplied bars, then cut off future data before any calculation.
  const rows = validatedDailyBars(bars).filter((row) => row.date < asOfDate);
  const currentState = regimeAt(rows, rows.length - 1);
  const allScenarios: HistoricalScenario[] = [];
  for (let i = VALUATION_HISTORY_DEFINITION.firstAnchorIndex; i + horizonSessions < rows.length; i += horizonSessions) {
    const regime = regimeAt(rows, i - 1);
    if (!regime) throw new Error("Internal history feature-window violation");
    const anchor = rows[i], end = rows[i + horizonSessions];
    allScenarios.push({ anchorDate: anchor.date, featureKnownDate: regime.featureKnownDate, endDate: end.date,
      anchorClose: anchor.bar.close, endClose: end.bar.close,
      logReturn: Math.log(end.bar.close) - Math.log(anchor.bar.close),
      matchesCurrentRegime: currentState !== null && regime.aboveSma50 === currentState.aboveSma50 && regime.volatilityBand === currentState.volatilityBand,
      regime });
  }
  const matchedScenarios = allScenarios.filter((scenario) => scenario.matchesCurrentRegime);
  const insufficient = matchedScenarios.length < VALUATION_HISTORY_DEFINITION.minimumConditionalSamples;
  const flags = ["CLOSE_ANCHORED_NOT_INTRADAY_HORIZON", "SOURCE_ADJUSTMENT_CONVENTION_UNVERIFIED", "SESSION_CALENDAR_COMPLETENESS_NOT_VERIFIED"];
  if (!rows.length) flags.push("NO_COMPLETED_HISTORY");
  if (!currentState) flags.push("CURRENT_REGIME_UNAVAILABLE");
  if (!allScenarios.length) flags.push("NO_MATURED_SCENARIOS");
  if (insufficient) flags.push("INSUFFICIENT_CONDITIONAL_SAMPLES_NO_PROMOTION_OR_FALLBACK");
  return { label: "HISTORICAL_CLOSE_ANCHORED_SCENARIOS_NOT_FORECAST_OR_OPTIONS_BACKTEST", status: "research",
    models: ["unconditional", "lagged-trend-volatility"], horizonSessions, asOfDate,
    symbol: rows[0]?.bar.symbol ?? null, lastCompletedDate: rows[rows.length - 1]?.date ?? null,
    currentState, allScenarios, matchedScenarios, matchedCount: matchedScenarios.length,
    insufficient, adjustmentConvention: "unverified", sessionCalendarValidated: false, flags };
}
