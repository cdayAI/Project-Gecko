import assert from "node:assert/strict";
import { enumerateScenarioStructures, expiryPayoffPerShare, scenarioPriceCeiling, summarizeScenarioPayoffs } from "./valuation-pricing.js";
import type { OptionChainSnapshot, OptionQuote } from "./types.js";
import { createLogger } from "../core/logger.js";
function quote(strike: number, right: "CALL" | "PUT", bid: number, ask: number): OptionQuote {
  return { osiSymbol: `TEST${right}${strike}`, underlying: "TEST", expiration: "2026-09-25", strike, optionType: right,
    bid, ask, bidSize: 10, askSize: 10, last: bid, volume: 100, openInterest: 100, iv: .3, delta: .5, gamma: 0, theta: 0, vega: 0 };
}
const chain: OptionChainSnapshot = { underlying: "TEST", underlyingPrice: 100, expirations: ["2026-09-25"],
  provenance: { source: "manual", capturedAt: 1, delayed: true },
  contracts: [quote(100, "CALL", 2, 2.05), quote(105, "CALL", .8, .85), quote(100, "PUT", 2, 2.05), quote(95, "PUT", .8, .85)] };
const s = enumerateScenarioStructures(chain);
assert.equal(s.length, 4);
const call = s.find(x => x.kind === "long-call")!, callSpread = s.find(x => x.kind === "call-debit-spread")!;
const put = s.find(x => x.kind === "long-put")!, putSpread = s.find(x => x.kind === "put-debit-spread")!;
assert.ok(Math.abs(callSpread.debitAsk! - 1.25) < 1e-10, "Use long ask minus short bid");
assert.equal(expiryPayoffPerShare(call, 110), 10);
assert.equal(expiryPayoffPerShare(callSpread, 110), 5);
assert.equal(expiryPayoffPerShare(put, 90), 10);
assert.equal(expiryPayoffPerShare(putSpread, 90), 5);
assert.equal(expiryPayoffPerShare(putSpread, 105), 0);
const zero = summarizeScenarioPayoffs(call, Array<number>(40).fill(0))!;
assert.equal(zero.meanPayoffPerShare, 0);
assert.ok(Math.abs(zero.netMeanDollars + call.theoreticalFullDebitRiskDollars!) < 1e-8);
assert.equal(scenarioPriceCeiling(call, zero, zero), 0);
assert.equal(scenarioPriceCeiling(call, zero, summarizeScenarioPayoffs(call, [0])), null);
assert.ok(summarizeScenarioPayoffs(callSpread, Array<number>(40).fill(Math.log(1.1)))!.meanPayoffPerShare <= 5);
const bad = enumerateScenarioStructures({ ...chain, contracts: chain.contracts.map(q => ({ ...q, askSize: 0 })) });
assert.ok(bad.every(x => x.quoteProblems.length > 0), "Do not silently replace the selected strike with a more favorable quote");
assert.throws(() => summarizeScenarioPayoffs(call, [NaN]));
assert.throws(() => expiryPayoffPerShare(call, Infinity));
const malformed = enumerateScenarioStructures({ ...chain, contracts: chain.contracts.map(q => ({ ...q, ask: NaN })) })[0];
assert.equal(malformed.debitAsk, null);
assert.equal(malformed.theoreticalFullDebitRiskDollars, null);
assert.equal(summarizeScenarioPayoffs(malformed, [0]), null);
assert.equal(enumerateScenarioStructures({ ...chain, contracts: chain.contracts.map(q => ({ ...q, askSize: Infinity })) })[0].hypotheticalUnitsWithin250, 0);
const positive = summarizeScenarioPayoffs(call, Array<number>(40).fill(Math.log(1.1)))!;
const ceiling = scenarioPriceCeiling(call, positive, positive)!;
assert.ok(Math.abs(ceiling * (1 + .05 * 8 / 365) + call.fixedFrictionDollars / 100 - positive.lowerResampledMeanPayoff!) < 1e-8);
createLogger("valuation-pricing-test").info("Terminal payoff and model-ceiling checks passed", { checks: 20, evidence: "synthetic math only" });
