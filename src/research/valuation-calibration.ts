// Retrospective return-distribution diagnostics only. This does not value an
// option, select parameters, update a model, or establish executable profit.
import type { HistoricalRegimeState, HistoricalScenario, HistoricalScenarioModel } from "./valuation-history.js";

export const VALUATION_CALIBRATION_DEFINITION = Object.freeze({
  version: "rolling-origin-return-distribution-v1",
  minimumUnconditionalSamples: 60,
  minimumConditionalSamples: 30,
  intervalLowerProbability: 0.10,
  intervalUpperProbability: 0.90,
  quantileConvention: "linear-interpolation-at-p-times-n-minus-one",
  trainingRule: "scenario.endDate < test.anchorDate",
});

export type CalibrationPrediction = {
  readonly interval80: readonly [number, number];
  readonly realizedInsideInterval80: boolean;
  readonly crps: number;
};

export type HistoricalCalibrationForecast = {
  readonly anchorDate: string;
  readonly endDate: string;
  readonly featureKnownDate: string;
  readonly regime: Pick<HistoricalRegimeState, "aboveSma50" | "volatilityBand">;
  readonly status: "TESTED" | "SKIPPED";
  readonly skipReasons: readonly ("INSUFFICIENT_UNCONDITIONAL_HISTORY" | "INSUFFICIENT_MATCHING_REGIME_HISTORY")[];
  readonly trainingCount: number;
  readonly conditionalTrainingCount: number;
  readonly trainingMaxEndDate: string | null;
  readonly conditionalTrainingMaxEndDate: string | null;
  readonly realizedLogReturn: number;
  readonly unconditional: CalibrationPrediction | null;
  readonly conditional: CalibrationPrediction | null;
};

export type HistoricalCalibrationResult = {
  readonly label: "RETROSPECTIVE_ROLLING_ORIGIN_RETURN_DISTRIBUTION_DIAGNOSTIC_NOT_OPTIONS_PROFIT";
  readonly symbol: string | null;
  readonly asOfDate: string;
  readonly horizonSessions: number;
  readonly tested: number;
  readonly skipped: number;
  readonly skippedInsufficientUnconditional: number;
  readonly skippedInsufficientConditional: number;
  readonly unconditionalCrps: number | null;
  readonly conditionalCrps: number | null;
  readonly unconditionalCoverage80: number | null;
  readonly conditionalCoverage80: number | null;
  readonly improvementFraction: number | null;
  readonly forecasts: readonly HistoricalCalibrationForecast[];
  readonly limitations: readonly string[];
};

function requireFiniteSample(sample: readonly number[], realized?: number): void {
  if (!Array.isArray(sample) || sample.length === 0 ||
      Array.from(sample).some((x) => typeof x !== "number" || !Number.isFinite(x)) ||
      (realized !== undefined && (typeof realized !== "number" || !Number.isFinite(realized)))) {
    throw new Error("CRPS requires a nonempty finite sample and finite realized value");
  }
}

/** Empirical ensemble CRPS in the sample's units, here log returns. */
export function empiricalCrps(sample: readonly number[], realized: number): number {
  requireFiniteSample(sample, realized);
  if (typeof realized !== "number" || !Number.isFinite(realized)) throw new Error("Realized value must be finite");
  const sorted = [...sample].sort((a, b) => a - b);
  const n = sorted.length;
  const absoluteError = sorted.reduce((sum, value) => sum + Math.abs(value - realized) / n, 0);
  // One half of the empirical pairwise absolute distance, in O(n log n).
  // Centering leaves this zero-sum expression unchanged while avoiding
  // cancellation for a degenerate or tightly clustered empirical ensemble.
  const ensembleDistance = sorted.reduce((sum, value, i) => sum + (2 * i - n + 1) * (value - sorted[0]) / (n * n), 0);
  const score = absoluteError - ensembleDistance;
  if (!Number.isFinite(score)) throw new Error("CRPS arithmetic exceeded finite range");
  return Math.max(0, score); // Only cancels possible negative floating-point roundoff.
}

function quantile(sorted: readonly number[], probability: number): number {
  const index = probability * (sorted.length - 1);
  const low = Math.floor(index), high = Math.ceil(index);
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}

function prediction(sample: readonly HistoricalScenario[], realized: number): CalibrationPrediction {
  const returns = sample.map((s) => s.logReturn).sort((a, b) => a - b);
  const low = quantile(returns, VALUATION_CALIBRATION_DEFINITION.intervalLowerProbability);
  const high = quantile(returns, VALUATION_CALIBRATION_DEFINITION.intervalUpperProbability);
  return { interval80: [low, high], realizedInsideInterval80: realized >= low && realized <= high,
    crps: empiricalCrps(returns, realized) };
}

function validDate(date: unknown): date is string {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const time = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === date;
}

function validatedScenarios(model: HistoricalScenarioModel): HistoricalScenario[] {
  if (!model || !validDate(model.asOfDate) || !Array.isArray(model.allScenarios) ||
      !Number.isInteger(model.horizonSessions) || model.horizonSessions < 1 || model.horizonSessions > 20) {
    throw new Error("Invalid historical scenario model");
  }
  const rows = [...model.allScenarios];
  for (const row of rows) {
    if (!row || !validDate(row.anchorDate) || !validDate(row.endDate) || !validDate(row.featureKnownDate) ||
        row.featureKnownDate >= row.anchorDate || row.endDate <= row.anchorDate || row.endDate >= model.asOfDate ||
        typeof row.logReturn !== "number" || !Number.isFinite(row.logReturn) || !row.regime ||
        row.regime.featureKnownDate !== row.featureKnownDate || typeof row.regime.aboveSma50 !== "boolean" ||
        !["below-25pct", "25-to-60pct", "60pct-or-above"].includes(row.regime.volatilityBand)) {
      throw new Error("Scenario must have matured, lagged features, finite return and a recognized regime");
    }
  }
  rows.sort((a, b) => a.anchorDate.localeCompare(b.anchorDate));
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].anchorDate <= rows[i - 1].anchorDate || rows[i - 1].endDate > rows[i].anchorDate) {
      throw new Error("Historical scenario anchors must be unique with nonoverlapping return intervals");
    }
  }
  return rows;
}

/**
 * Expanding, rolling-origin comparison using the supplied fixed historical
 * scenarios. The test outcome is scored after maturity; its training set uses
 * only outcomes ending strictly before the test's anchor date. Conditioning
 * uses the test scenario's lagged regime, never matchesCurrentRegime. Both
 * models are scored on the same eligible test cases, with no sample fallback.
 */
export function evaluateHistoricalCalibration(model: HistoricalScenarioModel): HistoricalCalibrationResult {
  const scenarios = validatedScenarios(model);
  const forecasts: HistoricalCalibrationForecast[] = [];
  for (const test of scenarios) {
    const training = scenarios.filter((s) => s.endDate < test.anchorDate);
    const conditional = training.filter((s) => s.regime.aboveSma50 === test.regime.aboveSma50 &&
      s.regime.volatilityBand === test.regime.volatilityBand);
    const skipReasons: ("INSUFFICIENT_UNCONDITIONAL_HISTORY" | "INSUFFICIENT_MATCHING_REGIME_HISTORY")[] = [];
    if (training.length < VALUATION_CALIBRATION_DEFINITION.minimumUnconditionalSamples) skipReasons.push("INSUFFICIENT_UNCONDITIONAL_HISTORY");
    if (conditional.length < VALUATION_CALIBRATION_DEFINITION.minimumConditionalSamples) skipReasons.push("INSUFFICIENT_MATCHING_REGIME_HISTORY");
    forecasts.push({ anchorDate: test.anchorDate, endDate: test.endDate, featureKnownDate: test.featureKnownDate,
      regime: { aboveSma50: test.regime.aboveSma50, volatilityBand: test.regime.volatilityBand },
      status: skipReasons.length ? "SKIPPED" : "TESTED", skipReasons,
      trainingCount: training.length, conditionalTrainingCount: conditional.length,
      trainingMaxEndDate: training[training.length - 1]?.endDate ?? null,
      conditionalTrainingMaxEndDate: conditional[conditional.length - 1]?.endDate ?? null,
      realizedLogReturn: test.logReturn,
      unconditional: skipReasons.length ? null : prediction(training, test.logReturn),
      conditional: skipReasons.length ? null : prediction(conditional, test.logReturn) });
  }
  const tested = forecasts.filter((f) => f.status === "TESTED");
  const average = (values: readonly number[]): number | null => values.length ? values.reduce((sum, x) => sum + x, 0) / values.length : null;
  const unconditionalCrps = average(tested.map((f) => f.unconditional!.crps));
  const conditionalCrps = average(tested.map((f) => f.conditional!.crps));
  return {
    label: "RETROSPECTIVE_ROLLING_ORIGIN_RETURN_DISTRIBUTION_DIAGNOSTIC_NOT_OPTIONS_PROFIT",
    symbol: model.symbol, asOfDate: model.asOfDate, horizonSessions: model.horizonSessions,
    tested: tested.length, skipped: forecasts.length - tested.length,
    skippedInsufficientUnconditional: forecasts.filter((f) => f.skipReasons.includes("INSUFFICIENT_UNCONDITIONAL_HISTORY")).length,
    skippedInsufficientConditional: forecasts.filter((f) => f.skipReasons.includes("INSUFFICIENT_MATCHING_REGIME_HISTORY")).length,
    unconditionalCrps, conditionalCrps,
    unconditionalCoverage80: average(tested.map((f) => Number(f.unconditional!.realizedInsideInterval80))),
    conditionalCoverage80: average(tested.map((f) => Number(f.conditional!.realizedInsideInterval80))),
    improvementFraction: unconditionalCrps !== null && unconditionalCrps > 0 && conditionalCrps !== null ?
      (unconditionalCrps - conditionalCrps) / unconditionalCrps : null,
    forecasts,
    limitations: ["RETROSPECTIVE_RETURN_DISTRIBUTION_DIAGNOSTIC_NOT_OPTIONS_PROFIT", "CRPS_UNITS_ARE_LOG_RETURN",
      "SAME_ELIGIBLE_CASES_FOR_BOTH_MODELS_NO_FALLBACK", "SKIP_REASON_COUNTS_CAN_OVERLAP",
      "EMPIRICAL_CENTRAL_80_PERCENT_INTERVAL_NOT_A_CONFIDENCE_INTERVAL", "NO_PARAMETER_SEARCH_OR_MODEL_UPDATE",
      "EXPANDING_TRAINING_SETS_SHARE_HISTORY_NO_INDEPENDENCE_OR_SIGNIFICANCE_CLAIM", ...model.flags],
  };
}
