import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Bar } from "../core/types.js";
import { createLogger } from "../core/logger.js";
import { etParts } from "../utils/time.js";
import { DEFAULT_MANUAL_HYPOTHESIS, runManualHypothesis, validateBars } from "./manual-runner.js";
import { readEvidence, sha256, writeJson } from "./evidence-store.js";
import type { InputEvidence, ManualPlan } from "./manual-types.js";

const log = createLogger("manual-backtest-selftest");
const base = Date.parse("2026-08-03T13:30:00Z");
function bar(index: number, prices: Partial<Bar> = {}, symbol = "SPY"): Bar {
  return { symbol, timestamp: base + index * 300_000, open: 100, high: 101, low: 99, close: 100, volume: 1_000, ...prices };
}
function setup(symbol = "SPY"): Bar[] {
  return [bar(0, {}, symbol), bar(1, {}, symbol), bar(2, {}, symbol),
    bar(3, { open: 100, high: 101.3, low: 100, close: 101.2 }, symbol)];
}
function near(a: number, b: number): void { assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`); }

const tests: ReadonlyArray<readonly [string, () => void]> = [
  ["signal is known at close; entry uses immediate next open", (): void => {
    const rows = [...setup(), bar(4, { open: 101.25, high: 102, low: 101.1, close: 101.4 }), bar(5, { open: 101.4, high: 106, low: 101, close: 105 })];
    const r = runManualHypothesis(rows);
    assert.equal(r.trades.length, 1);
    const t = r.trades[0];
    assert.equal(t.signalBarStart, base + 3 * 300_000);
    assert.equal(t.signalKnownAt, base + 4 * 300_000);
    assert.equal(t.entryTime, t.signalKnownAt);
    assert.equal(t.entryRaw, 101.25);
    assert.ok(t.entryPrice > t.entryRaw);
    assert.ok(t.plannedLossAtStop <= DEFAULT_MANUAL_HYPOTHESIS.plannedRisk);
    assert.ok(t.quantity * t.entryPrice <= 1_000);
    near(t.netPnl, t.grossPnl - t.slippageCost - t.fees);
    assert.equal(t.fees, 2);
  }],
  ["same bar stop and target uses stop first including entry bar", (): void => {
    const r = runManualHypothesis([...setup(), bar(4, { open: 101.2, high: 108, low: 98, close: 104 })]);
    assert.equal(r.trades[0].reason, "ambiguous-stop-first");
    assert.equal(r.trades[0].exitRaw, 99);
    assert.equal(r.trades[0].exitTime, base + 5 * 300_000);
    assert.ok(r.trades[0].netPnl < 0);
  }],
  ["stop gap fills at worse opening price", (): void => {
    const r = runManualHypothesis([...setup(), bar(4, { open: 101.2, high: 102, low: 101, close: 101.2 }), bar(5, { open: 97, high: 98, low: 96, close: 97 })]);
    assert.equal(r.trades[0].reason, "gap-stop");
    assert.equal(r.trades[0].exitRaw, 97);
    assert.ok(-r.trades[0].netPnl > r.trades[0].plannedLossAtStop);
  }],
  ["scheduled exit uses open before future intrabar extrema", (): void => {
    const rows = setup();
    for (let i = 4; i < 24; i++) rows.push(bar(i, { open: 101.2, high: 102, low: 100, close: 101.2 }));
    rows.push(bar(24, { open: 102, high: 200, low: 50, close: 70 }));
    const r = runManualHypothesis(rows);
    assert.equal(r.trades[0].reason, "time");
    assert.equal(r.trades[0].exitRaw, 102);
    assert.equal(r.trades[0].exitTime, base + 24 * 300_000);
  }],
  ["portfolio order is chronological and symbol ties deterministic", (): void => {
    const a = [...setup("AAA"), bar(4, { open: 101.2, high: 108, low: 101, close: 107 }, "AAA")];
    const z = [...setup("ZZZ"), bar(4, { open: 101.2, high: 102, low: 98, close: 99 }, "ZZZ")];
    const r = runManualHypothesis([...z, ...a]);
    const reverse = runManualHypothesis([...a, ...z].reverse());
    assert.deepEqual(r, reverse);
    assert.equal(r.trades.length, 1);
    assert.equal(r.trades[0].symbol, "AAA");
    assert.ok(r.events.some((e) => e.symbol === "ZZZ" && e.detail === "Shared portfolio already holds a position"));
    // AAA's future profit cannot free the slot for ZZZ at the same opening instant.
    assert.ok(r.trades[0].exitTime > r.trades[0].entryTime);
  }],
  ["future suffix cannot change past signals or completed trades", (): void => {
    const prefix = [...setup(), bar(4, { open: 101.2, high: 108, low: 101, close: 107 })];
    const before = runManualHypothesis(prefix);
    const after = runManualHypothesis([...prefix, bar(5, { open: 107, high: 300, low: 1, close: 2 })]);
    assert.deepEqual(before.trades, after.trades);
    assert.deepEqual(before.events, after.events.filter((e) => e.timestamp <= base + 5 * 300_000));
  }],
  ["missing next bar expires signal without a backdated fill", (): void => {
    const r = runManualHypothesis([...setup(), bar(5, { open: 101.2, high: 108, low: 101, close: 107 })]);
    assert.equal(r.trades.length, 0);
    assert.equal(r.unresolvedPosition, null);
    assert.ok(r.events.some((e) => e.type === "entry-rejected"));
  }],
  ["missing interval while held closes at first available open", (): void => {
    const r = runManualHypothesis([...setup(), bar(4, { open: 101.2, high: 102, low: 101, close: 101.2 }), bar(6, { open: 95, high: 96, low: 94, close: 95 })]);
    assert.equal(r.trades[0].reason, "data-gap");
    assert.equal(r.trades[0].exitRaw, 95);
  }],
  ["terminal missing prices remain unresolved, not fabricated", (): void => {
    const r = runManualHypothesis([...setup(), bar(4, { open: 101.2, high: 102, low: 101, close: 101.2 })]);
    assert.equal(r.trades.length, 0);
    assert.equal(r.unresolvedPosition?.symbol, "SPY");
  }],
  ["incomplete opening range and cutoff reject entries", (): void => {
    const missing = [...setup().filter((_, i) => i !== 1), bar(4, { open: 101.2, high: 108, low: 101, close: 107 })];
    assert.equal(runManualHypothesis(missing).trades.length, 0);
    const late: Bar[] = [];
    for (let i = 0; i < 17; i++) late.push(bar(i));
    late.push(bar(17, { open: 100, high: 101.3, low: 100, close: 101.2 }));
    late.push(bar(18, { open: 101.2, high: 108, low: 101, close: 107 }));
    assert.equal(runManualHypothesis(late).events.filter((e) => e.type === "entry").length, 0);
  }],
  ["input rejects duplicate/malformed bars; ET conversion respects DST", (): void => {
    assert.throws(() => validateBars([bar(0), bar(0)]), /Duplicate/);
    assert.throws(() => validateBars([bar(0, { high: 98 })]), /Invalid/);
    assert.throws(() => validateBars([bar(0, { close: NaN })]), /Invalid/);
    assert.equal(etParts(Date.parse("2026-01-05T14:30:00Z")).hour, 9);
    assert.equal(etParts(base).hour, 9);
  }],
  ["evidence replay verifies byte hashes before consuming bars", (): void => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gecko-evidence-test-"));
    try {
      const rows = setup();
      const hash = writeJson(path.join(dir, "SPY-5m.json"), rows);
      const plan: ManualPlan = { schemaVersion: 1, createdAt: new Date(base).toISOString(), startDate: "2026-08-03", endDateExclusive: "2026-08-05",
        holdoutStartDate: "2026-08-04", symbols: ["SPY"], hypothesis: DEFAULT_MANUAL_HYPOTHESIS, codeHashes: {}, label: "UNDERLYING_ONLY_DIAGNOSTIC_NOT_OPTIONS_PNL" };
      const planHash = writeJson(path.join(dir, "plan.json"), plan);
      const input: InputEvidence = { symbol: "SPY", source: "YahooHistoricalBars-public-chart", retrievedAt: new Date(base).toISOString(), interval: "5m",
        includePrePost: false, cache: false, requestStartMs: base, requestEndMs: base + 86_400_000,
        normalizedInputFile: "SPY-5m.json", sha256: hash, barCount: rows.length, firstBar: null, lastBar: null, error: null };
      const inputHash = writeJson(path.join(dir, "inputs.json"), [input]);
      writeJson(path.join(dir, "manifest.json"), { planSha256: planHash, inputsSha256: inputHash });
      assert.deepEqual(readEvidence(dir).bars, rows);
      fs.appendFileSync(path.join(dir, "SPY-5m.json"), " ");
      assert.throws(() => readEvidence(dir), /hash mismatch/);
      assert.notEqual(hash, sha256(fs.readFileSync(path.join(dir, "SPY-5m.json"), "utf8")));
    } finally {
      // Only explicit fixture files in a newly created task-owned directory are removed.
      for (const file of ["SPY-5m.json", "plan.json", "inputs.json", "manifest.json"]) fs.unlinkSync(path.join(dir, file));
      fs.rmdirSync(dir);
    }
  }],
];

let failures = 0;
for (const [name, run] of tests) {
  try { run(); log.info("PASS", { name }); }
  catch (error) { failures++; log.error("FAIL", { name, error: error instanceof Error ? error.stack : String(error) }); }
}
log.info("Manual diagnostic selftests complete", { passed: tests.length - failures, total: tests.length, failures });
if (failures) process.exitCode = 1;
