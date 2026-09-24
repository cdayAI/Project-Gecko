import assert from "node:assert/strict";
import type { Bar } from "../core/types.js";
import { createLogger } from "../core/logger.js";
import { DOUBLE_EDGE_COSTS, FROZEN_EDGE_DEFINITION } from "./edge-definition.js";
import { runEdgeHypothesis } from "./edge-runner.js";
import type { EdgeFamily, EdgeTrade } from "./edge-types.js";

const log = createLogger("edge-selftest");
const base = Date.parse("2026-08-03T13:30:00Z");
const family: EdgeFamily = "opening-range-continuation";
function bar(index: number, values: Partial<Bar> = {}, symbol = "SPY"): Bar {
  return { symbol, timestamp: base + index * 300_000, open: 100, high: 101, low: 99, close: 100, volume: 1_000, ...values };
}
function setup(short = false, symbol = "SPY"): Bar[] {
  return [bar(0, {}, symbol), bar(1, {}, symbol), bar(2, {}, symbol), short ?
    bar(3, { open: 100, high: 100, low: 98.7, close: 98.8 }, symbol) :
    bar(3, { open: 100, high: 101.3, low: 100, close: 101.2 }, symbol)];
}
function complete(prefix: readonly Bar[]): Bar[] {
  const rows = [...prefix];
  const symbols = [...new Set(rows.map((b) => b.symbol))];
  for (const symbol of symbols) {
    const last = Math.max(...rows.filter((b) => b.symbol === symbol).map((b) => (b.timestamp - base) / 300_000));
    for (let i = last + 1; i <= 24; i++) rows.push(bar(i, {}, symbol));
  }
  return rows;
}
function near(a: number, b: number): void { assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`); }

const tests: ReadonlyArray<readonly [string, () => void]> = [
  ["frozen registry has exactly four families and nested constants", (): void => {
    assert.equal(FROZEN_EDGE_DEFINITION.families.length, 4);
    assert.ok(Object.isFrozen(FROZEN_EDGE_DEFINITION));
    assert.ok(Object.isFrozen(FROZEN_EDGE_DEFINITION.settings));
    assert.ok(Object.isFrozen(FROZEN_EDGE_DEFINITION.costs));
    assert.equal(FROZEN_EDGE_DEFINITION.settings.firstSignalKnownMinute, 590);
    assert.equal(FROZEN_EDGE_DEFINITION.settings.lastSignalKnownMinute, 655);
  }],
  ["long next-open and after-cost arithmetic, integer cash and risk caps", (): void => {
    const rows = complete([...setup(), bar(4, { open: 101.2, high: 107, low: 101, close: 106 })]);
    const r = runEdgeHypothesis(rows, family), t = r.trades[0];
    assert.equal(r.trades.length, 1); assert.equal(r.eligibleForRanking, true);
    assert.equal(t.direction, "LONG"); assert.equal(t.signalKnownAt, base + 4 * 300_000);
    assert.equal(t.entryTime, t.signalKnownAt); assert.equal(t.entryRaw, 101.2);
    near(t.entryPrice, 101.2 * 1.0002); near(t.exitPrice, t.target * .9998);
    near(t.grossPnl, (t.exitRaw - t.entryRaw) * t.quantity);
    near(t.netPnl, t.grossPnl - t.slippageCost - 2);
    assert.ok(t.plannedLossAtStop <= 25 && t.quantity * t.entryPrice <= 1_000);
    assert.equal(t.exitTime, base + 5 * 300_000);
  }],
  ["short diagnostic uses adverse lower entry and higher cover", (): void => {
    const rows = complete([...setup(true), bar(4, { open: 98.8, high: 99, low: 93, close: 94 })]);
    const r = runEdgeHypothesis(rows, family), t = r.trades[0];
    assert.equal(t.direction, "SHORT"); assert.equal(t.reason, "target");
    near(t.entryPrice, 98.8 * .9998); near(t.exitPrice, t.target * 1.0002);
    near(t.grossPnl, (t.entryRaw - t.exitRaw) * t.quantity);
    near(t.netPnl, (t.entryPrice - t.exitPrice) * t.quantity - 2);
    assert.equal(r.stockBorrowAndMarginModeled, false);
    assert.ok(t.slippageCost > 0 && t.quantity * t.entryPrice <= 1_000);
  }],
  ["both target and stop touched uses adverse stop for both directions", (): void => {
    for (const short of [false, true]) {
      const rows = complete([...setup(short), bar(4, { open: short ? 98.8 : 101.2, high: 110, low: 90, close: 100 })]);
      const t: EdgeTrade = runEdgeHypothesis(rows, family).trades[0];
      assert.equal(t.reason, "ambiguous-stop-first"); assert.ok(t.netPnl < 0);
      assert.equal(t.exitRaw, short ? 101 : 99);
    }
  }],
  ["gap-through stops use worse observed open, not stop level", (): void => {
    for (const short of [false, true]) {
      const entry = short ? 98.8 : 101.2;
      const held = bar(4, { open: entry, high: entry + .1, low: entry - .1, close: entry });
      const open = short ? 104 : 96;
      const gap = bar(5, { open, high: open + .1, low: open - .1, close: open });
      const t: EdgeTrade = runEdgeHypothesis(complete([...setup(short), held, gap]), family).trades[0];
      assert.equal(t.reason, "gap-stop"); assert.equal(t.exitRaw, open);
      assert.ok(-t.netPnl > t.plannedLossAtStop);
    }
  }],
  ["time exit reads 11:30 open before that bar's extreme prices", (): void => {
    const rows = setup();
    for (let i = 4; i < 24; i++) rows.push(bar(i, { open: 101.2, high: 102, low: 100, close: 101.2 }));
    rows.push(bar(24, { open: 102, high: 200, low: 1, close: 50 }));
    const t = runEdgeHypothesis(rows, family).trades[0];
    assert.equal(t.reason, "time"); assert.equal(t.exitRaw, 102);
    assert.equal(t.exitTime, base + 24 * 300_000);
  }],
  ["future suffix cannot alter past entry and frozen signal stop", (): void => {
    const prefix = [...setup(), bar(4, { open: 101.2, high: 102, low: 101, close: 101.3 })];
    const a = runEdgeHypothesis(complete([...prefix, bar(5, { open: 101.3, high: 110, low: 101, close: 105 })]), family);
    const b = runEdgeHypothesis(complete([...prefix, bar(5, { open: 101.3, high: 102, low: 90, close: 95 })]), family);
    const cutoff = base + 4 * 300_000;
    assert.deepEqual(a.events.filter((e) => e.timestamp <= cutoff), b.events.filter((e) => e.timestamp <= cutoff));
    assert.equal(a.trades[0].entryPrice, b.trades[0].entryPrice);
    assert.equal(a.trades[0].stop, b.trades[0].stop);
  }],
  ["missing held path stays unknown despite later profitable price", (): void => {
    const rows = complete([...setup(), bar(4, { open: 101.2, high: 102, low: 101, close: 101.2 }),
      bar(6, { open: 110, high: 111, low: 109, close: 110 })]);
    const r = runEdgeHypothesis(rows, family);
    assert.equal(r.netPnl, null); assert.equal(r.eligibleForRanking, false);
    assert.ok(r.unresolvedPosition); assert.equal(r.trades.length, 0);
  }],
  ["portfolio cannot use future winner to overlap another entry", (): void => {
    const a = complete([...setup(false, "AAA"), bar(4, { open: 101.2, high: 110, low: 101, close: 105 }, "AAA")]);
    const z = complete([...setup(false, "ZZZ"), bar(4, { open: 101.2, high: 110, low: 101, close: 105 }, "ZZZ")]);
    const r = runEdgeHypothesis([...z, ...a], family);
    assert.equal(r.trades.length, 1); assert.equal(r.trades[0].symbol, "AAA");
    assert.ok(r.events.some((e) => e.symbol === "ZZZ" && e.detail === "Shared portfolio position already open"));
    assert.deepEqual(r, runEdgeHypothesis([...a, ...z].reverse(), family));
  }],
  ["sequential losses reserve the remaining daily stop allowance including fees", (): void => {
    const rows: Bar[] = [];
    for (const [offset, symbol] of ["AAA", "BBB", "CCC", "DDD"].entries()) {
      const signalIndex = 3 + 2 * offset;
      for (let i = 0; i <= 24; i++) {
        rows.push(i === signalIndex ? bar(i, { open: 100, high: 101.3, low: 100, close: 101.2 }, symbol) :
          i === signalIndex + 1 ? bar(i, { open: 101.2, high: 101.3, low: 98.5, close: 99 }, symbol) : bar(i, {}, symbol));
      }
    }
    const result = runEdgeHypothesis(rows, family);
    assert.equal(result.eligibleForRanking, true);
    assert.equal(result.events.filter((e) => e.type === "signal").length, 4);
    assert.equal(result.trades.length, 3);
    const [first, second, third] = result.trades;
    assert.equal(first.quantity, 9); assert.equal(second.quantity, 9); assert.equal(third.quantity, 1);
    const remaining = 50 + first.netPnl + second.netPnl;
    assert.ok(third.plannedLossAtStop <= remaining && third.plannedLossAtStop < 25);
    near(-third.netPnl, third.plannedLossAtStop);
    assert.ok(result.completedNetPnl >= -50);
    assert.ok(result.events.some((e) => e.symbol === "DDD" && e.type === "rejected" && e.detail.includes("Remaining daily allowance")));
  }],
  ["failed OR break uses previous bar extreme and direction mirror", (): void => {
    for (const lower of [false, true]) {
      const rows = setup(lower);
      rows.push(bar(4, { open: lower ? 98.8 : 101.2, high: 101.2, low: 98.8, close: 100 }));
      rows.push(bar(5, { open: 100, high: 101, low: 99.5, close: 100 }));
      const r = runEdgeHypothesis(complete(rows), "failed-opening-range-breakout");
      const signal = r.events.find((e) => e.type === "signal");
      assert.ok(signal); assert.equal(signal.timestamp, base + 5 * 300_000);
      const entry = r.events.find((e) => e.type === "entry"); assert.ok(entry);
      assert.ok(entry.detail.startsWith(lower ? "LONG" : "SHORT"));
      const t = r.trades[0];
      near(t.stop, lower ? 98.69 : 101.31);
    }
  }],
  ["VWAP pullback uses completed typical-price VWAP and prior two bars", (): void => {
    const rows = [bar(0, { open: 100, high: 100.3, low: 99.7, close: 100 }),
      bar(1, { open: 100, high: 100.6, low: 100, close: 100.5 }),
      bar(2, { open: 100.5, high: 100.8, low: 100.2, close: 100.7 }),
      bar(3, { open: 100.7, high: 101, low: 100.2, close: 100.8 }),
      bar(4, { open: 100.8, high: 103, low: 100.7, close: 102 })];
    const r = runEdgeHypothesis(complete(rows), "vwap-trend-pullback");
    assert.equal(r.trades[0].direction, "LONG");
    near(r.trades[0].signalVwap, (100 + 100.36666666666666 + 100.56666666666666 + 100.66666666666667) / 4);
    assert.equal(r.trades[0].stop, 100);
    assert.equal(r.trades[0].entryTime, base + 4 * 300_000);
    const mirrored = rows.map((b): Bar => ({ ...b, open: 200 - b.open, high: 200 - b.low, low: 200 - b.high, close: 200 - b.close }));
    const short = runEdgeHypothesis(complete(mirrored), "vwap-trend-pullback");
    assert.equal(short.trades[0].direction, "SHORT");
    assert.equal(short.trades[0].stop, 100);
  }],
  ["VWAP overextension reversal measures movement before filling", (): void => {
    const rows = [bar(0), bar(1), bar(2),
      bar(3, { open: 101, high: 102, low: 100.8, close: 101.8 }),
      bar(4, { open: 101.8, high: 101.9, low: 101.3, close: 101.5 }),
      bar(5, { open: 101.5, high: 101.6, low: 99, close: 100 })];
    const r = runEdgeHypothesis(complete(rows), "vwap-overextension-reversal");
    assert.equal(r.trades[0].direction, "SHORT");
    assert.equal(r.trades[0].signalKnownAt, base + 5 * 300_000);
    assert.equal(r.trades[0].stop, 102);
    const mirrored = rows.map((b): Bar => ({ ...b, open: 200 - b.open, high: 200 - b.low, low: 200 - b.high, close: 200 - b.close }));
    assert.equal(runEdgeHypothesis(complete(mirrored), "vwap-overextension-reversal").trades[0].direction, "LONG");
  }],
  ["cost stress changes costs only; unknown strategy overrides rejected", (): void => {
    const rows = complete([...setup(), bar(4, { open: 101.2, high: 107, low: 101, close: 106 })]);
    const baseResult = runEdgeHypothesis(rows, family), stress = runEdgeHypothesis(rows, family, DOUBLE_EDGE_COSTS);
    assert.equal(stress.trades[0].fees, 4); assert.equal(baseResult.trades[0].fees, 2);
    assert.ok(stress.trades[0].slippageCost > baseResult.trades[0].slippageCost);
    assert.deepEqual(stress.events.filter((e) => e.type === "signal"), baseResult.events.filter((e) => e.type === "signal"));
    assert.throws(() => runEdgeHypothesis(rows, family, { rewardR: 4 } as unknown as Partial<import("./edge-types.js").EdgeCosts>), /Only cost/);
  }],
  ["missing morning coverage invalidates ranking even if a trade won", (): void => {
    const rows = [...setup(), bar(4, { open: 101.2, high: 107, low: 101, close: 106 })];
    const r = runEdgeHypothesis(rows, family);
    assert.ok(r.completedNetPnl > 0); assert.equal(r.netPnl, null); assert.equal(r.eligibleForRanking, false);
    assert.ok(r.dataQualityIssues.some((i) => i.includes("coverage missing")));
  }],
];
let failures = 0;
for (const [name, run] of tests) {
  try { run(); log.info("PASS", { name }); }
  catch (error) { failures++; log.error("FAIL", { name, error: error instanceof Error ? error.stack : String(error) }); }
}
log.info("Frozen edge engine tests; synthetic fixtures only", { passed: tests.length - failures, total: tests.length, failures });
if (failures) process.exitCode = 1;
