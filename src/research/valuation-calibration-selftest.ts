import assert from "node:assert/strict";
import type { Bar } from "../core/types.js";
import { empiricalCrps, evaluateHistoricalCalibration } from "./valuation-calibration.js";
import { buildHistoricalScenarios } from "./valuation-history.js";
import type { HistoricalRegimeState, HistoricalScenario, HistoricalScenarioModel } from "./valuation-history.js";

const date = (day: number): string => new Date(Date.UTC(2020, 0, 1 + day)).toISOString().slice(0, 10);
function scenario(i: number, logReturn = (i % 2 === 0 ? 0.02 : -0.02)): HistoricalScenario {
  const featureKnownDate = date(i - 1);
  return { anchorDate: date(i), featureKnownDate, endDate: date(i + 1), anchorClose: 100,
    endClose: 100 * Math.exp(logReturn), logReturn, matchesCurrentRegime: false,
    regime: { featureKnownDate, close: 100, sma50: 100, aboveSma50: i % 2 === 0,
      annualizedVolatility: 0.2, volatilityBand: "below-25pct" } };
}
function model(rows: readonly HistoricalScenario[]): HistoricalScenarioModel {
  return { label: "HISTORICAL_CLOSE_ANCHORED_SCENARIOS_NOT_FORECAST_OR_OPTIONS_BACKTEST", status: "research",
    models: ["unconditional", "lagged-trend-volatility"], horizonSessions: 1,
    asOfDate: rows.length ? date(rows.length + 2) : date(2), symbol: "TEST", lastCompletedDate: null,
    currentState: null, allScenarios: rows, matchedScenarios: [], matchedCount: 0, insufficient: true,
    adjustmentConvention: "unverified", sessionCalendarValidated: false, flags: ["SYNTHETIC_TEST_ONLY"] };
}

export function runValuationCalibrationSelfTest(): { passed: number } {
  let passed = 0;
  const test = (fn: () => void): void => { fn(); passed++; };
  test(() => { assert.equal(empiricalCrps([2], 2), 0); assert.equal(empiricalCrps([2, 2, 2], 5), 3); });
  test(() => { assert.equal(empiricalCrps([0, 2], 1), 0.5); assert.equal(empiricalCrps([0, 2], 3), 1.5); });
  test(() => { assert.equal(empiricalCrps([2, 0], 0), 0.5); assert.equal(empiricalCrps([-1, 1], 0), 0.5); });
  test(() => {
    const sample = [3, -1, 0, 2], y = 0.4;
    const direct = sample.reduce((s, x) => s + Math.abs(x - y) / sample.length, 0) -
      sample.reduce((s, x) => s + sample.reduce((inner, z) => inner + Math.abs(x - z), 0), 0) / (2 * sample.length ** 2);
    assert.ok(Math.abs(empiricalCrps(sample, y) - direct) < 1e-12);
    assert.deepEqual(sample, [3, -1, 0, 2]);
  });
  test(() => {
    for (const sample of [[], [NaN], [Infinity], Array<number>(2)]) assert.throws(() => empiricalCrps(sample, 0));
    assert.throws(() => empiricalCrps([0], NaN)); assert.throws(() => empiricalCrps([0], Infinity));
  });
  const rows = Array.from({ length: 100 }, (_, i) => scenario(i));
  const result = evaluateHistoricalCalibration(model(rows));
  test(() => {
    assert.equal(result.tested, 39); assert.equal(result.skipped, 61);
    assert.equal(result.forecasts[60].trainingCount, 59);
    assert.equal(result.forecasts[61].trainingCount, 60);
    assert.equal(result.forecasts[61].conditionalTrainingCount, 30);
    for (const f of result.forecasts) {
      assert.ok(f.trainingMaxEndDate === null || f.trainingMaxEndDate < f.anchorDate);
      assert.ok(f.conditionalTrainingMaxEndDate === null || f.conditionalTrainingMaxEndDate < f.anchorDate);
    }
  });
  test(() => {
    // All matchesCurrentRegime flags are false, but test-date conditioning works.
    assert.equal(result.conditionalCrps, 0); assert.equal(result.improvementFraction, 1);
    assert.equal(result.conditionalCoverage80, 1); assert.equal(result.unconditionalCoverage80, 1);
    assert.ok(result.unconditionalCrps! > 0);
    assert.deepEqual(result.forecasts[61].conditional!.interval80, [-0.02, -0.02]);
  });
  test(() => {
    const extended = [...rows, ...Array.from({ length: 20 }, (_, j) => scenario(j + 100, 0.5))];
    const future = evaluateHistoricalCalibration(model(extended));
    assert.deepEqual(future.forecasts.slice(0, rows.length), result.forecasts);
  });
  test(() => {
    const changedFlag = rows.map((s) => ({ ...s, matchesCurrentRegime: true }));
    assert.deepEqual(evaluateHistoricalCalibration(model(changedFlag)), result);
    assert.deepEqual(evaluateHistoricalCalibration(model([...rows].reverse())), result);
  });
  test(() => {
    const bands: HistoricalRegimeState["volatilityBand"][] = ["below-25pct", "25-to-60pct", "60pct-or-above"];
    const sparse = rows.slice(0, 70).map((s, i) => ({ ...s, regime: { ...s.regime, volatilityBand: bands[i % 3] } }));
    const r = evaluateHistoricalCalibration(model(sparse));
    assert.equal(r.tested, 0); assert.equal(r.skipped, 70); assert.equal(r.unconditionalCrps, null);
    assert.equal(r.conditionalCrps, null); assert.equal(r.improvementFraction, null);
    assert.ok(r.forecasts[69].trainingCount >= 60);
    assert.ok(r.forecasts[69].skipReasons.includes("INSUFFICIENT_MATCHING_REGIME_HISTORY"));
    assert.equal(r.forecasts[69].unconditional, null); // No fallback-only score.
  });
  test(() => {
    const zero = rows.map((s) => ({ ...s, logReturn: 0, endClose: 100 }));
    const r = evaluateHistoricalCalibration(model(zero));
    assert.equal(r.unconditionalCrps, 0); assert.equal(r.conditionalCrps, 0); assert.equal(r.improvementFraction, null);
  });
  test(() => {
    const increasing = Array.from({ length: 100 }, (_, i) => scenario(i, i / 1000));
    const f = evaluateHistoricalCalibration(model(increasing)).forecasts[61];
    assert.ok(Math.abs(f.unconditional!.interval80[0] - 0.0059) < 1e-12);
    assert.ok(Math.abs(f.unconditional!.interval80[1] - 0.0531) < 1e-12);
    assert.equal(f.unconditional!.realizedInsideInterval80, false);
    assert.equal(f.conditional!.realizedInsideInterval80, false);
  });
  test(() => {
    const r = evaluateHistoricalCalibration(model([]));
    assert.equal(r.tested, 0); assert.equal(r.skipped, 0); assert.equal(r.unconditionalCoverage80, null);
  });
  test(() => {
    const invalid = [...rows]; invalid[0] = { ...invalid[0], endDate: date(3) };
    assert.throws(() => evaluateHistoricalCalibration(model(invalid)), /nonoverlapping/);
    assert.throws(() => evaluateHistoricalCalibration(model([rows[0], rows[0]])), /unique/);
  });
  test(() => {
    const invalid = [...rows]; invalid[0] = { ...invalid[0], featureKnownDate: invalid[0].anchorDate };
    assert.throws(() => evaluateHistoricalCalibration(model(invalid)), /lagged/);
    assert.throws(() => evaluateHistoricalCalibration({ ...model(rows), asOfDate: date(100) }), /matured/);
    assert.throws(() => evaluateHistoricalCalibration(model([{ ...rows[0], logReturn: NaN }])), /finite/);
  });
  test(() => {
    // Exercise the real history builder, including its nonoverlapping horizon
    // and lagged-feature definitions, without requesting any external data.
    const bars: Bar[] = [];
    for (let day = 0; bars.length < 600; day++) {
      const timestamp = Date.UTC(2020, 0, 2 + day, 21);
      const weekday = new Date(timestamp).getUTCDay();
      if (weekday === 0 || weekday === 6) continue;
      const close = 100 * Math.exp(bars.length / 1000);
      bars.push({ symbol: "TEST", timestamp, open: close, high: close, low: close, close, volume: 100 });
    }
    const history = buildHistoricalScenarios(bars, 5, "2030-01-01");
    const r = evaluateHistoricalCalibration(history);
    assert.ok(r.tested > 0); assert.equal(r.tested + r.skipped, history.allScenarios.length);
    assert.equal(r.horizonSessions, 5);
    for (const f of r.forecasts) assert.ok(f.trainingMaxEndDate === null || f.trainingMaxEndDate < f.anchorDate);
  });
  return { passed };
}

if (process.argv[1]?.endsWith("valuation-calibration-selftest.ts") || process.argv[1]?.endsWith("valuation-calibration-selftest.js")) {
  process.stdout.write(JSON.stringify({ component: "valuation-calibration-selftest", ...runValuationCalibrationSelfTest() }) + "\n");
}
