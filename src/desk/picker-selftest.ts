// Synthetic offline selection checks. No provider, network or trading imports.
import assert from "node:assert/strict";
import type { Candidate, OptionQuote, ResearchPacket } from "../research/types.js";
import { demoFrame, DEMO_TIME } from "./fixtures.js";
import { pickOptions, renderOptionsPickerMarkdown } from "./picker.js";

function candidate(symbol = "SPY", overrides: Partial<OptionQuote> = {}): Candidate {
  const frame = demoFrame();
  const option = { ...frame.options[0], osiSymbol: `${symbol}260925C00700000`, underlying: symbol, ...overrides };
  return { symbol, snapshot: { ...frame.underlying[0], symbol }, stats: null, catalysts: null,
    flags: { gapper: false, highRelativeVolume: false, nearFiftyTwoWeekHigh: false, nearFiftyTwoWeekLow: false,
      aboveSma20: false, aboveSma50: false, earningsWithin5Days: false, macroEventToday: false },
    chain: { underlying: symbol, underlyingPrice: 700.5, expirations: ["2026-09-25"], contracts: [option],
      provenance: frame.underlying[0].provenance, completeness: { discovery: "bounded", quotesComplete: true, requested: 1, returned: 1 } },
    structures: [], score: 99, scoreReasons: ["Synthetic attention score, not a strategy"], warnings: ["Synthetic counterevidence: no actual catalyst"] };
}

export function runPickerSelfTest(): { passed: number } {
  let passed = 0;
  const source = candidate();
  const pick = (c: Candidate): ReturnType<typeof pickOptions> => pickOptions([c], {}, DEMO_TIME);
  const rejected = (c: Candidate, code: string): void => {
    const r = pick(c); assert.equal(r.picks.length, 0); assert.ok(r.decisions[0].codes.includes(code), JSON.stringify(r.decisions)); passed++;
  };
  const good = pick(source);
  assert.equal(good.picks.length, 1); assert.equal(good.picks[0].contract, "SPY260925C00700000"); passed++;
  assert.equal(good.picks[0].fullLossUsd, 150.2); assert.equal(good.picks[0].plannedStopRiskUsd, null);
  assert.equal(good.picks[0].probabilityOfProfit, null); assert.ok(good.picks[0].countercase.includes(source.warnings[0])); passed++;
  assert.equal(good.mode, "HISTORICAL_RESEARCH"); passed++;
  rejected({ ...source, chain: null }, "NO_OPTION_DATA");
  rejected(candidate("SPY", { ask: 1.80 }), "DATA_QUALITY_BLOCK");
  rejected(candidate("SPY", { quoteTime: DEMO_TIME - 5001 }), "DATA_QUALITY_BLOCK");
  rejected({ ...source, snapshot: { ...source.snapshot, lastTradeTime: DEMO_TIME - 5001 } }, "DATA_QUALITY_BLOCK");
  rejected(candidate("SPY", { contractVerified: false }), "DATA_QUALITY_BLOCK");
  rejected(candidate("SPY", { contractMultiplier: 10 }), "DATA_QUALITY_BLOCK");
  rejected(candidate("SPY", { contractStandard: false }), "DATA_QUALITY_BLOCK");
  rejected(candidate("SPY", { provenance: { ...source.chain!.contracts[0].provenance!, delayMinutes: 15 } }), "DATA_QUALITY_BLOCK");
  rejected(candidate("SPY", { osiSymbol: "SPY260917C00700000", expiration: "2026-09-17" }), "DTE_OUT_OF_RANGE");
  rejected(candidate("SPY", { osiSymbol: "SPY261120C00700000", expiration: "2026-11-20" }), "DTE_OUT_OF_RANGE");
  rejected(candidate("SPY", { delta: .2 }), "DELTA_OUT_OF_RANGE");
  rejected(candidate("SPY", { delta: null }), "DELTA_MISSING_OR_INVALID_SIGN");
  rejected(candidate("SPY", { delta: -.5 }), "DELTA_MISSING_OR_INVALID_SIGN");
  rejected(candidate("SPY", { volume: 99 }), "VOLUME_OR_OPEN_INTEREST_INSUFFICIENT");
  rejected(candidate("SPY", { openInterest: NaN }), "VOLUME_OR_OPEN_INTEREST_INSUFFICIENT");
  rejected(candidate("SPY", { bid: 2.98, ask: 3 }), "NO_AFFORDABLE_CONTRACT");
  rejected(candidate("SPY", { bid: 2.49, ask: 2.50 }), "NO_AFFORDABLE_CONTRACT"); // Fee allowance breaches $250.
  const put = candidate("SPY", { osiSymbol: "SPY260925P00700000", optionType: "PUT", delta: -.5 });
  assert.equal(pickOptions([put], { direction: "SHORT" }, DEMO_TIME).picks[0].direction, "SHORT"); passed++;
  assert.equal(pickOptions([put], { direction: "LONG" }, DEMO_TIME).picks.length, 0); passed++;
  assert.equal(pickOptions([source], { directions: { SPY: "NONE" } }, DEMO_TIME).picks.length, 0); passed++;
  const lowerSpread = candidate("QQQ", { bid: 1.48, ask: 1.50 });
  const ranked = pickOptions([source, lowerSpread], {}, DEMO_TIME);
  assert.equal(ranked.picks[0].symbol, "QQQ"); passed++;
  const alternatives = { ...source, chain: { ...source.chain!, contracts: [source.chain!.contracts[0], { ...source.chain!.contracts[0], osiSymbol: "SPY260925C00701000", strike: 701 }] } };
  assert.equal(pick(alternatives).picks.length, 1); assert.equal(pick(alternatives).decisions[0].qualifiedContracts, 2); passed++;
  const six = ["SPY", "QQQ", "TSLA", "AMD", "NVDA", "SMCI"].map(s => candidate(s));
  assert.equal(pickOptions(six, {}, DEMO_TIME).picks.length, 5);
  assert.equal(pickOptions(six, {}, DEMO_TIME).decisions.filter(d => d.codes.includes("RANK_CUTOFF")).length, 1); passed++;
  assert.equal(pickOptions([source, source], {}, DEMO_TIME).picks.length, 0); passed++;
  rejected({ ...source, chain: { ...source.chain!, contracts: [source.chain!.contracts[0], source.chain!.contracts[0]] } }, "DUPLICATE_CONTRACT");
  // A newly quoted chain underlying must not replace the stale source snapshot.
  rejected({ ...source, snapshot: { ...source.snapshot, quoteTime: DEMO_TIME - 6000 },
    chain: { ...source.chain!, underlyingSnapshot: source.snapshot } }, "DATA_QUALITY_BLOCK");
  const packet: ResearchPacket = { id: "offline-fixture", generatedAt: new Date(DEMO_TIME).toISOString(), generatedAtEt: "2026-09-17 10:00 ET",
    session: "regular", budget: { accountEquity: 5000, maxRiskPerTradePct: 1, maxRiskPerTradeUsd: 50 }, providers: ["manual"],
    universeSource: "synthetic", universeSize: 1, candidates: [source], errors: [] };
  assert.equal(pickOptions(packet, {}, DEMO_TIME).packetId, packet.id); passed++;
  assert.equal(pickOptions(packet).picks.length, 0); passed++; // Date.now, not packet time.
  assert.equal(pickOptions({ ...packet, generatedAt: new Date(DEMO_TIME + 1).toISOString() }, {}, DEMO_TIME).picks.length, 0); passed++;
  rejected({ ...source, snapshot: { ...source.snapshot, provenance: { ...source.snapshot.provenance, capturedAt: DEMO_TIME + 1 } } }, "RECEIPT_TIME_INVALID_OR_FUTURE");
  assert.throws(() => pickOptions([source], {}, Date.now() + 10000)); passed++;
  for (const config of [{ maxResults: 6 }, { minDte: 0 }, { maxDte: 46 }, { maxAbsDelta: .9 }, { quantity: .5 }, { planningEquity: NaN }, { feePerContractPerSide: -1 }]) {
    assert.throws(() => pickOptions([source], config, DEMO_TIME)); passed++;
  }
  const withNews: Candidate = { ...source, catalysts: { symbol: "SPY", headlines: [
    { title: "Synthetic attributed fixture", publisher: "Fixture", publishedAt: DEMO_TIME - 1000, url: "https://example.com/evidence" },
    { title: "Future fixture", publisher: "Fixture", publishedAt: DEMO_TIME + 1000, url: "https://example.com/future" }],
    nextEarningsDate: null, earningsProvenance: null, macroEventsToday: [], macroEventsNext5Days: [],
    headlinesProvenance: { ...source.snapshot.provenance, capturedAt: DEMO_TIME - 500 } } };
  assert.equal(pick(withNews).picks[0].evidence.length, 1); passed++;
  assert.equal(pick({ ...withNews, catalysts: { ...withNews.catalysts!, headlinesProvenance: { ...source.snapshot.provenance, capturedAt: DEMO_TIME + 1 } } }).picks[0].evidence.length, 0); passed++;
  const futureEarnings = pick({ ...withNews, catalysts: { ...withNews.catalysts!, nextEarningsDate: "2026-09-20",
    earningsProvenance: { ...source.snapshot.provenance, capturedAt: DEMO_TIME + 1 } } });
  assert.ok(futureEarnings.picks[0].countercase.some(s => s.includes("Next earnings date is unknown"))); passed++;
  const md = renderOptionsPickerMarkdown(good);
  assert.ok(md.includes("HISTORICAL_RESEARCH")); assert.ok(md.includes("SPY260925C00700000")); assert.ok(md.includes("Countercase")); passed++;
  assert.ok(renderOptionsPickerMarkdown(pickOptions([], {}, DEMO_TIME)).includes("No contracts pass")); passed++;
  assert.ok(renderOptionsPickerMarkdown(pick(candidate("SPY", { quoteTime: DEMO_TIME - 6000 }))).includes("option_quote:stale")); passed++;
  return { passed };
}
if (process.argv[1]?.endsWith("picker-selftest.ts") || process.argv[1]?.endsWith("picker-selftest.js")) {
  process.stdout.write(JSON.stringify({ component: "options-picker-selftest", ...runPickerSelfTest() }) + "\n");
}
