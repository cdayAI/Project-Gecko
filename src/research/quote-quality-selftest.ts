import assert from "node:assert/strict";
import { evaluateQuotePair } from "./quote-quality.js";
import type { OptionQuote, UnderlyingSnapshot } from "./types.js";

export function runQuoteQualitySelfTest(): { passed: number } {
  const now = 1789661472000;
  // Synthetic paired fixture exercises gates, not trading performance.
  const stock: UnderlyingSnapshot = { symbol: "SMCI", last: 40, bid: 39.99, ask: 40.01,
    bidSize: 100, askSize: 100, quoteTime: now - 500, lastTradeTime: now - 200,
    open: 39, high: 41, low: 38, prevClose: 39, volume: 1000, changePct: 1,
    provenance: { source: "webull", capturedAt: now, delayed: false, delayStatus: "unknown" } };
  const option: OptionQuote = { osiSymbol: "SMCI260925C00040000", underlying: "SMCI",
    expiration: "2026-09-25", strike: 40, optionType: "CALL", bid: 1.70, ask: 1.72,
    last: 1.71, volume: 3000, openInterest: 3269, iv: .6917, delta: .5339, gamma: .0954,
    theta: -.1036, vega: .0239, bidSize: 12, askSize: 34, quoteTime: now - 300,
    contractVerified: true, contractMultiplier: 100, contractStandard: true,
    provenance: { source: "webull", capturedAt: now, delayed: false, delayMinutes: 0, delayStatus: "real-time" } };
  let passed = 0;
  const block = (u: UnderlyingSnapshot, o: OptionQuote, reason: string): void => {
    const result = evaluateQuotePair(u, o, now);
    assert.equal(result.status, "DATA_BLOCK"); assert.ok(result.reasons.includes(reason), result.reasons.join(",")); passed++;
  };
  assert.equal(evaluateQuotePair(stock, option, now).status, "DATA_PASS"); passed++;
  block(stock, { ...option, quoteTime: now - 5001 }, "option_quote:stale");
  block(stock, { ...option, provenance: { ...option.provenance!, delayMinutes: 15 } }, "option:delay_unknown_or_nonzero");
  block(stock, { ...option, provenance: undefined }, "option:delay_unknown_or_nonzero");
  block(stock, { ...option, quoteTime: undefined }, "option_quote:missing_or_invalid_timestamp");
  block(stock, { ...option, bidSize: undefined }, "option:missing_or_invalid_size");
  block(stock, { ...option, bid: 1.73 }, "option:crossed");
  block(stock, { ...option, bid: NaN }, "option:invalid_bid_ask");
  block(stock, { ...option, ask: Infinity }, "option:invalid_bid_ask");
  block(stock, { ...option, quoteTime: now + 501 }, "option_quote:future_timestamp");
  assert.equal(evaluateQuotePair(stock, { ...option, quoteTime: now + 279 }, now).status, "DATA_PASS"); passed++;
  block({ ...stock, quoteTime: now - 4000 }, option, "pair:quote_time_skew");
  block({ ...stock, lastTradeTime: now - 5001 }, option, "underlying_last_trade:stale");
  block(stock, { ...option, osiSymbol: "HOOD260925C00040000" }, "contract:identity_mismatch");
  block(stock, { ...option, contractVerified: undefined }, "contract:standard_100_not_verified");
  block(stock, { ...option, contractMultiplier: 10 }, "contract:standard_100_not_verified");
  block(stock, { ...option, contractStandard: false }, "contract:standard_100_not_verified");
  block(stock, { ...option, ask: 1.85 }, "option:spread_absolute");
  block(stock, { ...option, bid: .50, ask: .55 }, "option:spread_fraction");
  block(stock, { ...option, quoteTime: now - .5 }, "option_quote:missing_or_invalid_timestamp");
  block({ ...stock, bidSize: 0 }, option, "underlying:missing_or_invalid_size");
  assert.equal(evaluateQuotePair(stock, option, now, { maxAgeMs: NaN }).status, "DATA_BLOCK"); passed++;
  assert.equal(evaluateQuotePair(stock, option, now, { maxSkewMs: 0 }).status, "DATA_BLOCK"); passed++;
  assert.equal(evaluateQuotePair(stock, option, 0).status, "DATA_BLOCK"); passed++;
  assert.equal(evaluateQuotePair(stock, option, now + 6000).status, "DATA_BLOCK"); passed++;
  block({ ...stock, provenance: { ...stock.provenance, delayed: true } }, option, "underlying:delayed");
  return { passed };
}
if (process.argv[1]?.endsWith("quote-quality-selftest.ts") || process.argv[1]?.endsWith("quote-quality-selftest.js")) {
  process.stdout.write(JSON.stringify({ component: "quote-quality-selftest", ...runQuoteQualitySelfTest() }) + "\n");
}
