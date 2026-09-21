import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createLogger } from "../core/logger.js";
import { evaluateDesk } from "./engine.js";
import { DEMO_TIME, demoConfig, demoFrame, demoPlan } from "./fixtures.js";
import { FillJournal, reconstruct, type ManualFill } from "./journal.js";
import { DeskStore } from "./store.js";
import { parseConfig, parsePlan } from "./validation.js";
import { analyzeChain } from "../research/options-analyzer.js";

const log = createLogger("desk-selftest");
const empty = reconstruct([]), config = demoConfig(), frame = demoFrame();
const fill = (id: string, side: ManualFill["side"], quantity: number, price: number, at: number): ManualFill => ({ id, source: "manual", executedAt: at,
  multiplier: 100, standardContract: true,
  contract: config.plans[0].contract, side, quantity, price, fees: 0.20 * quantity, planId: "synthetic-demo", planVersion: 1, correlationGroup: "US-index" });
const checks: readonly [string, () => void][] = [
  ["long put maximum gain is finite and bounded by strike", () => {
    const put = { ...frame.options[0], osiSymbol: "SPY260925P00700000", optionType: "PUT" as const, delta: -0.5 };
    const structures = analyzeChain({ underlying: "SPY", underlyingPrice: 700, expirations: [put.expiration], contracts: [put], provenance: frame.underlying[0].provenance },
      { accountEquity: 5000, maxRiskPerTradePct: 5, maxRiskPerTradeUsd: 250 }, { todayIsoDate: "2026-09-17", atr: 1, minDte: 1, maxDte: 45, maxStructures: 5 });
    assert.equal(structures[0].maxGainPerContract, (700 - put.ask) * 100);
  }],
  ["crossed short legs cannot form a displayed debit spread", () => {
    const short = { ...frame.options[0], osiSymbol: "SPY260925C00701000", strike: 701, bid: 1.2, ask: 1.0 };
    const structures = analyzeChain({ underlying: "SPY", underlyingPrice: 700, expirations: [short.expiration], contracts: [...frame.options, short], provenance: frame.underlying[0].provenance },
      { accountEquity: 5000, maxRiskPerTradePct: 5, maxRiskPerTradeUsd: 250 }, { todayIsoDate: "2026-09-17", atr: 1, minDte: 1, maxDte: 45, maxStructures: 5 });
    assert.ok(structures.every(s => s.kind !== "call-debit-spread"));
  }],
  ["validated fixture can become eligible", () => { assert.equal(evaluateDesk(parseConfig(config), frame, empty).updates[0].status, "ELIGIBLE"); }],
  ["stop risk remains distinct from full premium loss", () => { const u = evaluateDesk(config, frame, empty).updates[0]; assert.ok(u.fullLoss > u.plannedRisk); assert.equal(u.probabilityOfProfit, null); }],
  ["stale quotes block entry", () => { assert.equal(evaluateDesk(config, { ...frame, capturedAt: DEMO_TIME + 6000 }, empty).updates[0].status, "DATA_BLOCKED"); }],
  ["permissions and buying power do not inherit planning capital", () => { assert.equal(evaluateDesk({ ...config, policy: { ...config.policy, optionsPermissionVerified: false, buyingPower: null } }, frame, empty).updates[0].status, "RISK_BLOCKED"); }],
  ["expired reconciliation blocks entry", () => { assert.equal(evaluateDesk({ ...config, policy: { ...config.policy, positionsReconciledAt: DEMO_TIME - 900_001 } }, frame, empty).updates[0].status, "RISK_BLOCKED"); }],
  ["last-trade freshness bounds alert lifetime", () => {
    const aged = { ...frame, underlying: frame.underlying.map(u => ({ ...u, lastTradeTime: DEMO_TIME - 4999 })) };
    assert.equal(evaluateDesk(config, aged, empty).updates[0].validUntil, DEMO_TIME + 1);
  }],
  ["account snapshot cannot be reused after a new fill", () => {
    const other = demoPlan({ id: "other", contract: "SPY260925C00701000", correlationGroup: "other" });
    const state = reconstruct([{ ...fill("a", "BUY_TO_OPEN", 1, 1.0, DEMO_TIME - 5000), planId: "other", contract: other.contract, correlationGroup: "other" }]);
    const quotes = [...frame.options, { ...frame.options[0], osiSymbol: other.contract, strike: 701 }];
    const r = evaluateDesk(demoConfig([demoPlan(), other]), { ...frame, options: quotes }, state);
    assert.equal(r.updates[0].status, "RISK_BLOCKED"); assert.ok(r.updates[0].reasons.some(x => x.includes("fills since")));
  }],
  ["actual open quantities and prices drive exposure", () => {
    const state = reconstruct([fill("a", "BUY_TO_OPEN", 3, 2, DEMO_TIME - 1000)]);
    const r = evaluateDesk(config, frame, state).updates[0];
    assert.equal(r.quantity, 3); assert.ok(Math.abs(r.fullLoss - 600.9) < 1e-8); assert.equal(r.status, "EXIT_WATCH");
  }],
  ["exit warning survives price recovery", () => {
    const state = reconstruct([fill("a", "BUY_TO_OPEN", 1, 1.5, DEMO_TIME - 1000)]);
    const a = evaluateDesk(config, demoFrame(DEMO_TIME, 700, 1.05, 1.1), state);
    assert.equal(a.updates[0].status, "EXIT_WATCH");
    assert.equal(evaluateDesk(config, demoFrame(DEMO_TIME + 1000), state, a.updates).updates[0].status, "EXIT_WATCH");
  }],
  ["future state cannot contaminate earlier replay", () => {
    const future = evaluateDesk(config, demoFrame(DEMO_TIME + 1000, 697), empty);
    assert.equal(evaluateDesk(config, frame, empty, future.updates).updates[0].status, "ELIGIBLE");
  }],
  ["daily halt survives a later recovery", () => {
    const r = evaluateDesk(config, frame, empty, [], new Map(), "2026-09-17");
    assert.equal(r.updates[0].status, "RISK_BLOCKED"); assert.equal(r.dailyHaltDate, "2026-09-17");
  }],
  ["entry cannot already be beyond the premium stop", () => { assert.equal(evaluateDesk(config, demoFrame(DEMO_TIME, 700, 1.05, 1.1), empty).updates[0].status, "WATCHING"); }],
  ["invalidation remains terminal after price recovers", () => { const a = evaluateDesk(config, demoFrame(DEMO_TIME, 697), empty); assert.equal(a.updates[0].status, "INVALIDATED"); assert.equal(evaluateDesk(config, demoFrame(DEMO_TIME + 1000), empty, a.updates).updates[0].status, "INVALIDATED"); }],
  ["maximum chase cancels late entries", () => { assert.equal(evaluateDesk(config, demoFrame(DEMO_TIME, 703), empty).updates[0].status, "INVALIDATED"); }],
  ["required news fails closed", () => { assert.equal(evaluateDesk(demoConfig([demoPlan({ requireNews: true, evidenceIds: ["missing"] })]), frame, empty).updates[0].status, "DATA_BLOCKED"); }],
  ["simultaneous alerts reserve correlated budget", () => {
    const second = demoPlan({ id: "second", contract: "SPY260925C00701000" });
    const quotes = [...frame.options, { ...frame.options[0], osiSymbol: second.contract, strike: 701 }];
    const r = evaluateDesk(demoConfig([demoPlan(), second]), { ...frame, options: quotes }, empty);
    assert.deepEqual(r.updates.map(x => x.status), ["ELIGIBLE", "RISK_BLOCKED"]);
  }],
  ["time exit still alerts when data is missing", () => {
    const state = reconstruct([fill("a", "BUY_TO_OPEN", 1, 1.5, DEMO_TIME)]);
    const r = evaluateDesk(config, { capturedAt: DEMO_TIME + 3600_000, underlying: [], options: [], source: "synthetic" }, state);
    assert.equal(r.updates[0].status, "EXIT_WATCH");
  }],
  ["unknown marks block new risk", () => {
    const held = { ...fill("a", "BUY_TO_OPEN", 1, 1.5, DEMO_TIME - 1000), planId: "other", contract: "QQQ260925C00600000" };
    assert.equal(evaluateDesk(config, frame, reconstruct([held])).updates[0].status, "RISK_BLOCKED");
  }],
  ["FIFO partial exits allocate entry and exit fees once", () => {
    const state = reconstruct([fill("a", "BUY_TO_OPEN", 2, 1.0, DEMO_TIME), fill("b", "BUY_TO_OPEN", 1, 1.2, DEMO_TIME + 1), fill("c", "SELL_TO_CLOSE", 2, 1.5, DEMO_TIME + 2)]);
    assert.equal(state.lots[0].quantity, 1); assert.equal(state.lots[0].entryPrice, 1.2);
    assert.ok(Math.abs(state.realized.reduce((s, x) => s + x.netPnl, 0) - 99.2) < 1e-8);
  }],
  ["duplicate execution IDs are idempotent, conflicting IDs rejected", () => {
    const a = fill("a", "BUY_TO_OPEN", 1, 1.0, DEMO_TIME);
    assert.equal(reconstruct([a, a]).lots[0].quantity, 1);
    assert.throws(() => reconstruct([a, { ...a, price: 1.1 }]));
  }],
  ["oversells and negative fees are rejected", () => { assert.throws(() => reconstruct([fill("bad", "SELL_TO_CLOSE", 1, 1.5, DEMO_TIME)])); assert.throws(() => reconstruct([{ ...fill("bad", "BUY_TO_OPEN", 1, 1.5, DEMO_TIME), fees: -1 }])); }],
  ["closed plans do not silently reenter", () => {
    const state = reconstruct([fill("a", "BUY_TO_OPEN", 1, 1.5, DEMO_TIME - 2000), fill("b", "SELL_TO_CLOSE", 1, 1.6, DEMO_TIME - 1000)]);
    assert.equal(evaluateDesk(config, frame, state).updates[0].status, "CLOSED");
  }],
  ["invalid direction, time, fractional size and duplicate plans rejected", () => {
    assert.throws(() => parsePlan({ ...demoPlan(), direction: "SHORT" })); assert.throws(() => parsePlan({ ...demoPlan(), quantity: 0.5 }));
    assert.throws(() => parsePlan({ ...demoPlan(), timeExit: DEMO_TIME + 86_400_000 })); assert.throws(() => parseConfig({ ...config, plans: [demoPlan(), demoPlan()] }));
  }],
  ["restart dedupe and immutable recommendation versions", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gecko-desk-test-"));
    try {
      const store = new DeskStore(dir); store.register(config.plans);
      assert.throws(() => store.register([demoPlan({ maxEntry: 1.6 })]));
      const r = evaluateDesk(config, frame, empty); assert.equal(store.publish(config, frame, r, []), 1);
      const restart = new DeskStore(dir); assert.equal(restart.publish(config, demoFrame(DEMO_TIME + 1000), evaluateDesk(config, demoFrame(DEMO_TIME + 1000), empty, restart.previous()), restart.previous()), 0);
      const journal = new FillJournal(dir), a = fill("a", "BUY_TO_OPEN", 1, 1.5, DEMO_TIME);
      assert.equal(journal.import([a]).imported, 1); assert.equal(journal.import([a]).duplicates, 1);
      assert.throws(() => journal.import([{ ...a, price: 9 }])); assert.equal(journal.read().fills.length, 1);
      assert.throws(() => journal.import([{ ...a, id: "future", executedAt: Date.now() + 86_400_000 }]));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }],
];
let passed = 0;
for (const [name, check] of checks) { check(); passed++; log.info("PASS", { name }); }
log.info("Manual desk checks complete", { passed, failed: 0, evidence: "synthetic software validation only" });
