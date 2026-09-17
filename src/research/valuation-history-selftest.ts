import assert from "node:assert/strict";
import type { Bar } from "../core/types.js";
import { createLogger } from "../core/logger.js";
import { etParts } from "../utils/time.js";
import { buildHistoricalScenarios, VALUATION_HISTORY_DEFINITION } from "./valuation-history.js";

const log = createLogger("valuation-history-selftest");

function fixture(count: number, price: (index: number) => number = (): number => 100): Bar[] {
  const rows: Bar[] = [];
  let timestamp = Date.parse("2025-01-02T17:00:00Z");
  while (rows.length < count) {
    const dow = new Date(timestamp).getUTCDay();
    if (dow !== 0 && dow !== 6) {
      const close = price(rows.length);
      rows.push({ symbol: "SPY", timestamp, open: close, high: close, low: close, close, volume: 1_000 });
    }
    timestamp += 86_400_000;
  }
  return rows;
}

function dateOf(bar: Bar): string { return etParts(bar.timestamp).date; }
function withClose(bar: Bar, close: number): Bar { return { ...bar, open: close, high: close, low: close, close }; }
function near(actual: number, expected: number): void { assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`); }

const tests: ReadonlyArray<readonly [string, () => void]> = [
  ["fixed two-model definition and close-anchored research labels", (): void => {
    assert.ok(Object.isFrozen(VALUATION_HISTORY_DEFINITION));
    const rows = fixture(204);
    const model = buildHistoricalScenarios(rows, 5, dateOf(rows[203]));
    assert.deepEqual(model.models, ["unconditional", "lagged-trend-volatility"]);
    assert.equal(model.status, "research");
    assert.equal(model.label, "HISTORICAL_CLOSE_ANCHORED_SCENARIOS_NOT_FORECAST_OR_OPTIONS_BACKTEST");
    assert.equal(model.adjustmentConvention, "unverified");
    assert.equal(model.sessionCalendarValidated, false);
    assert.equal(model.matchedCount, 30); assert.equal(model.insufficient, false);
    assert.equal(model.currentState?.aboveSma50, true); near(model.currentState!.annualizedVolatility, 0);
  }],
  ["future and as-of-session bars cannot alter the current prefix model", (): void => {
    const rows = fixture(125, (i): number => 100 * Math.exp(i * .001));
    const cutoff = dateOf(rows[100]);
    const prefix = buildHistoricalScenarios(rows.slice(0, 100), 3, cutoff);
    const appended = rows.map((bar, i): Bar => i >= 100 ? withClose(bar, i % 2 ? 1_000_000 : .001) : bar);
    assert.deepEqual(buildHistoricalScenarios(appended, 3, cutoff), prefix);
    assert.equal(prefix.lastCompletedDate, dateOf(rows[99]));
    assert.equal(prefix.currentState?.featureKnownDate, dateOf(rows[99]));
  }],
  ["maturity requires endpoint strictly before the as-of date", (): void => {
    const rows = fixture(60);
    const beforeEnd = buildHistoricalScenarios(rows, 5, dateOf(rows[56]));
    assert.equal(beforeEnd.allScenarios.length, 0);
    const afterEnd = buildHistoricalScenarios(rows, 5, dateOf(rows[57]));
    assert.equal(afterEnd.allScenarios.length, 1);
    assert.equal(afterEnd.allScenarios[0].anchorDate, dateOf(rows[51]));
    assert.equal(afterEnd.allScenarios[0].endDate, dateOf(rows[56]));
  }],
  ["fixed chronological stride uses disjoint return intervals and lagged features", (): void => {
    const rows = fixture(180);
    const model = buildHistoricalScenarios(rows, 7, dateOf(rows[179]));
    for (let i = 0; i < model.allScenarios.length; i++) {
      const scenario = model.allScenarios[i];
      assert.equal(scenario.anchorDate, dateOf(rows[51 + i * 7]));
      assert.equal(scenario.featureKnownDate, dateOf(rows[50 + i * 7]));
      assert.equal(scenario.endDate, dateOf(rows[58 + i * 7]));
      assert.ok(scenario.featureKnownDate < scenario.anchorDate);
      if (i) assert.equal(model.allScenarios[i - 1].endDate, scenario.anchorDate);
    }
  }],
  ["extreme anchor and future outcomes do not change historical regime features", (): void => {
    const rows = fixture(90);
    const baseline = buildHistoricalScenarios(rows, 4, dateOf(rows[89]));
    const altered = rows.map((bar, i): Bar => i >= 51 && i <= 55 ? withClose(bar, i === 51 ? 2 : 50_000) : bar);
    const changed = buildHistoricalScenarios(altered, 4, dateOf(rows[89]));
    assert.deepEqual(changed.allScenarios[0].regime, baseline.allScenarios[0].regime);
    assert.notEqual(changed.allScenarios[0].logReturn, baseline.allScenarios[0].logReturn);
    near(changed.allScenarios[0].logReturn, Math.log(50_000) - Math.log(2));
  }],
  ["twenty log-return sample standard deviation and fifty-close SMA are exact", (): void => {
    const rows = fixture(62, (i): number => 100 * Math.exp(i % 2 === 0 ? 0 : .02));
    const state = buildHistoricalScenarios(rows, 1, dateOf(rows[61])).currentState!;
    near(state.annualizedVolatility, Math.sqrt(20 * .02 ** 2 / 19) * Math.sqrt(252));
    near(state.sma50, (100 + 100 * Math.exp(.02)) / 2);
    assert.equal(state.aboveSma50, false);
    assert.equal(state.volatilityBand, "25-to-60pct");
    const highVol = fixture(62, (i): number => 100 * Math.exp(i % 2 === 0 ? 0 : .05));
    assert.equal(buildHistoricalScenarios(highVol, 1, dateOf(highVol[61])).currentState?.volatilityBand, "60pct-or-above");
  }],
  ["conditional matching checks trend and volatility without fallback", (): void => {
    const rows = fixture(130, (i): number => i <= 80 ? 100 : 100 * Math.exp(-.01 * (i - 80)));
    const model = buildHistoricalScenarios(rows, 5, dateOf(rows[129]));
    assert.equal(model.currentState?.aboveSma50, false);
    assert.equal(model.allScenarios[0].matchesCurrentRegime, false);
    assert.ok(model.matchedCount < model.allScenarios.length);
    assert.deepEqual(model.matchedScenarios, model.allScenarios.filter((s) => s.matchesCurrentRegime));
    assert.equal(model.insufficient, true);
    assert.ok(model.flags.includes("INSUFFICIENT_CONDITIONAL_SAMPLES_NO_PROMOTION_OR_FALLBACK"));
  }],
  ["a constant decimal price is at its SMA rather than below by roundoff", (): void => {
    const rows = fixture(100, (): number => 100.01);
    const model = buildHistoricalScenarios(rows, 5, dateOf(rows[99]));
    assert.equal(model.currentState?.sma50, 100.01);
    assert.equal(model.currentState?.aboveSma50, true);
    assert.ok(model.allScenarios.every((scenario) => scenario.regime.aboveSma50));
  }],
  ["conditional minimum is thirty actual matched intervals", (): void => {
    const rows = fixture(203);
    const twentyNine = buildHistoricalScenarios(rows, 5, dateOf(rows[201]));
    assert.equal(twentyNine.matchedCount, 29); assert.equal(twentyNine.insufficient, true);
    const thirty = buildHistoricalScenarios(rows, 5, dateOf(rows[202]));
    assert.equal(thirty.matchedCount, 30); assert.equal(thirty.insufficient, false);
  }],
  ["different horizons change endpoint and stride without rescaling returns", (): void => {
    const rows = fixture(100, (i): number => 100 * Math.exp(i * .001));
    const one = buildHistoricalScenarios(rows, 1, dateOf(rows[99]));
    const ten = buildHistoricalScenarios(rows, 10, dateOf(rows[99]));
    near(one.allScenarios[0].logReturn, .001); near(ten.allScenarios[0].logReturn, .010);
    assert.ok(one.allScenarios.length > ten.allScenarios.length);
    assert.equal(one.allScenarios[0].anchorDate, ten.allScenarios[0].anchorDate);
  }],
  ["empty and short histories remain explicit insufficient states", (): void => {
    const empty = buildHistoricalScenarios([], 1, "2026-09-17");
    assert.equal(empty.currentState, null); assert.equal(empty.symbol, null);
    assert.equal(empty.lastCompletedDate, null); assert.equal(empty.insufficient, true);
    assert.ok(empty.flags.includes("NO_COMPLETED_HISTORY"));
    const rows = fixture(49);
    const short = buildHistoricalScenarios(rows, 1, "2026-09-17");
    assert.equal(short.currentState, null); assert.equal(short.allScenarios.length, 0);
  }],
  ["malformed bars duplicate daily sessions mixed symbols and invalid parameters fail", (): void => {
    const rows = fixture(65), cutoff = dateOf(rows[64]);
    for (const horizon of [0, -1, 1.5, 21, NaN]) assert.throws(() => buildHistoricalScenarios(rows, horizon, cutoff), /Horizon/);
    for (const date of ["2026-02-30", "2026-2-01", "invalid"]) assert.throws(() => buildHistoricalScenarios(rows, 1, date), /asOfDate/);
    assert.throws(() => buildHistoricalScenarios([...rows, rows[0]], 1, cutoff), /Duplicate/);
    assert.throws(() => buildHistoricalScenarios([...rows, { ...rows[0], timestamp: rows[0].timestamp + 3_600_000 }], 1, cutoff), /Duplicate/);
    assert.throws(() => buildHistoricalScenarios(rows.map((bar, i): Bar => i === 5 ? { ...bar, symbol: "QQQ" } : bar), 1, cutoff), /one underlying/);
    assert.throws(() => buildHistoricalScenarios(rows.map((bar, i): Bar => i === 5 ? { ...bar, close: NaN } : bar), 1, cutoff), /Malformed/);
    assert.throws(() => buildHistoricalScenarios([{ ...rows[0], timestamp: Date.parse("2025-01-04T17:00:00Z") }], 1, cutoff), /weekend/);
  }],
  ["sorting is deterministic and never mutates frozen caller input", (): void => {
    const rows = fixture(100);
    const reversed = Object.freeze([...rows].reverse().map((bar): Readonly<Bar> => Object.freeze({ ...bar })));
    const priorFirstTimestamp = reversed[0].timestamp;
    assert.deepEqual(buildHistoricalScenarios(reversed, 5, dateOf(rows[99])), buildHistoricalScenarios(rows, 5, dateOf(rows[99])));
    assert.equal(reversed[0].timestamp, priorFirstTimestamp);
  }],
];

let failures = 0;
for (const [name, run] of tests) {
  try { run(); log.info("PASS", { name }); }
  catch (error) { failures++; log.error("FAIL", { name, error: error instanceof Error ? error.stack : String(error) }); }
}
log.info("Historical scenario tests; synthetic fixtures only", { passed: tests.length - failures, total: tests.length, failures });
if (failures) process.exitCode = 1;
