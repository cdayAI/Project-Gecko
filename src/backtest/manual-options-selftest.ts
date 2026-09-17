import assert from "node:assert/strict";
import { createLogger } from "../core/logger.js";
import type { ManualPlan, QuoteFrame } from "../desk/types.js";
import { replayManualOption } from "./manual-options-replay.js";

const log = createLogger("manual-options-selftest");
const now = Date.parse("2026-09-17T14:00:00Z");
const plan: ManualPlan = { id: "fixture", version: 1, symbol: "SPY", contract: "SPY260925C00750000", strategy: "fixture", direction: "LONG",
  createdAt: now - 1000, validFrom: now, expiresAt: now + 60_000, timeExit: now + 120_000, trigger: 750, maxChase: 752,
  invalidation: 749, maxEntry: 2.10, stopBid: 1.75, targetBid: 2.50, quantity: 1, correlationGroup: "fixture",
  thesis: "Synthetic fixture only", counterevidence: "No market evidence", evidenceIds: [], confidence: "UNVALIDATED", requireNews: false };

function frame(offset: number, bid = 1.98, ask = 2.00): QuoteFrame {
  const time = now + offset;
  const provenance = { source: "manual" as const, capturedAt: time, sourceTimestamp: time, delayed: false, delayMinutes: 0, delayStatus: "real-time" as const };
  return { source: "synthetic", capturedAt: time,
    underlying: [{ symbol: "SPY", last: 751, bid: 750.99, ask: 751.01, bidSize: 100, askSize: 100,
      quoteTime: time, lastTradeTime: time, open: 750, high: 752, low: 749, prevClose: 749, volume: 1000, changePct: 0.2, provenance }],
    options: [{ osiSymbol: plan.contract, underlying: "SPY", expiration: "2026-09-25", strike: 750, optionType: "CALL", bid, ask,
      bidSize: 10, askSize: 10, quoteTime: time, lastTradeTime: time, provenance, contractVerified: true, contractMultiplier: 100,
      contractStandard: true, last: 2, volume: 100, openInterest: 1000, iv: 0.3, delta: 0.55, gamma: 0.02, theta: -0.1, vega: 0.1 }] };
}
const synthetic = { allowSynthetic: true };
const tests: ReadonlyArray<readonly [string, () => void]> = [
  ["next-frame ask entry, bid exit, fees and adverse slippage", (): void => {
    const r = replayManualOption(plan, [frame(0), frame(1000), frame(2000, 2.6, 2.62)], synthetic);
    assert.equal(r.status, "CLOSED");
    assert.equal(r.label, "SYNTHETIC_ENGINE_TEST_NOT_PERFORMANCE");
    assert.equal(r.entry?.at, now + 1000);
    assert.equal(r.entry?.price, 2.01);
    assert.ok(Math.abs(r.exit!.price - 2.59) < 1e-8);
    assert.ok(Math.abs(r.netPnl! - 57.8) < 1e-8);
    assert.ok(Math.abs(r.fullPremiumLoss! - 201.2) < 1e-8);
    assert.ok(r.plannedLoss! < r.fullPremiumLoss!);
  }],
  ["one observation never creates an entry fill", (): void => {
    const r = replayManualOption(plan, [frame(0)], synthetic);
    assert.equal(r.status, "NO_ENTRY");
    assert.equal(r.entry, null);
    assert.equal(r.netPnl, null);
  }],
  ["missing path while held leaves profit unknown permanently", (): void => {
    const r = replayManualOption(plan, [frame(0), frame(1000), frame(20_000, 3, 3.02), frame(21_000, 4, 4.02)], synthetic);
    assert.equal(r.status, "UNRESOLVED_DATA_GAP");
    assert.equal(r.exit, null);
    assert.equal(r.netPnl, null);
  }],
  ["delayed, future, missing-size quotes cannot be entry prices", (): void => {
    const q = frame(1000);
    for (const changed of [
      { ...q.options[0], quoteTime: now + 1001 },
      { ...q.options[0], askSize: undefined },
      { ...q.options[0], provenance: { ...q.options[0].provenance!, delayed: true, delayMinutes: 15 } },
    ]) {
      const r = replayManualOption(plan, [frame(0), { ...q, options: [changed] }], synthetic);
      assert.equal(r.entry, null);
    }
  }],
  ["frozen plan and strict observation order; synthetic opt-in", (): void => {
    assert.throws(() => replayManualOption(plan, [frame(0)]), /Synthetic/);
    assert.throws(() => replayManualOption(plan, [frame(1000), frame(0)], synthetic), /strictly increasing/);
    assert.throws(() => replayManualOption({ ...plan, createdAt: now + 1, validFrom: now + 2 }, [frame(0)], synthetic), /created after/);
  }],
  ["required news cannot be bypassed by quote-only replay", (): void => {
    const r = replayManualOption({ ...plan, requireNews: true, evidenceIds: ["fixture-news@1"] }, [frame(0), frame(1000)], synthetic);
    assert.equal(r.status, "BLOCKED_NEWS_EVIDENCE");
    assert.equal(r.netPnl, null);
  }],
  ["time exit is bid priced and is not a held-to-expiry payoff", (): void => {
    const shortPlan = { ...plan, expiresAt: now + 2000, timeExit: now + 3000 };
    const r = replayManualOption(shortPlan, [frame(0), frame(1000), frame(2000), frame(3000, 2.2, 2.22)], synthetic);
    assert.equal(r.exitReason, "time");
    assert.equal(r.exit?.quotedPrice, 2.2);
    assert.equal(r.status, "CLOSED");
  }],
  ["unknown terminal price, invalid contract exit and full-loss cap", (): void => {
    const open = replayManualOption(plan, [frame(0), frame(1000)], synthetic);
    assert.equal(open.status, "UNRESOLVED_OPEN_POSITION");
    assert.equal(open.netPnl, null);
    const bad = frame(2000, 3, 3.02);
    const invalid = replayManualOption(plan, [frame(0), frame(1000), { ...bad, options: [{ ...bad.options[0], strike: 740 }] }], synthetic);
    assert.equal(invalid.status, "UNRESOLVED_DATA_GAP");
    const expensive = replayManualOption({ ...plan, quantity: 2 }, [frame(0), frame(1000)], synthetic);
    assert.equal(expensive.entry, null);
  }],
];
let failures = 0;
for (const [name, run] of tests) {
  try { run(); log.info("PASS", { name }); }
  catch (error) { failures++; log.error("FAIL", { name, error: error instanceof Error ? error.stack : String(error) }); }
}
log.info("Option replay selftests complete; synthetic fixtures only", { passed: tests.length - failures, total: tests.length, failures });
if (failures) process.exitCode = 1;
