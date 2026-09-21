import * as fs from "node:fs";
import * as path from "node:path";
import { createLogger } from "../core/logger.js";
import type { Bar } from "../core/types.js";
import type { OptionChainSnapshot } from "./types.js";
import { YahooHistoricalBars } from "../data/yahoo-historical.js";
import { etParts } from "../utils/time.js";
import { sha256, writeJson } from "../backtest/evidence-store.js";
import { validateBars } from "../backtest/manual-runner.js";
import { buildHistoricalScenarios } from "./valuation-history.js";
import { evaluateHistoricalCalibration } from "./valuation-calibration.js";
import { enumerateScenarioStructures, expiryPayoffPerShare, scenarioPriceCeiling, summarizeScenarioPayoffs, VALUATION_ASSUMPTIONS } from "./valuation-pricing.js";

const log = createLogger("option-valuation");
const inputSnapshot = "data/valuation/cboe-delayed-20260917T2000Z/snapshot.json";
const symbols = ["AMD", "HOOD", "LEN", "META", "NVDA", "QQQ", "SMCI", "SPY", "TSLA"];
const codeFiles = ["src/research/valuation-cli.ts", "src/research/valuation-pricing.ts", "src/research/valuation-history.ts", "src/research/valuation-calibration.ts", "src/utils/time.ts", "src/backtest/manual-runner.ts"];

function isRecord(v: unknown): v is Record<string, unknown> { return !!v && typeof v === "object" && !Array.isArray(v); }
function loadSnapshot(file: string): { text: string; outcomes: { symbol: string; chain: OptionChainSnapshot; receivedAt: string; underlyingLastTradeTimeRaw: string }[] } {
  const text = fs.readFileSync(file, "utf8");
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || !Array.isArray(value.outcomes)) throw new Error("Invalid frozen snapshot");
  const outcomes = value.outcomes.map((row: unknown) => {
    if (!isRecord(row) || typeof row.symbol !== "string" || !isRecord(row.chain) || row.chain.underlying !== row.symbol ||
      typeof row.chain.underlyingPrice !== "number" || row.chain.underlyingPrice <= 0 || !Array.isArray(row.chain.contracts) ||
      typeof row.receivedAt !== "string" || typeof row.underlyingLastTradeTimeRaw !== "string") throw new Error("Malformed chain input");
    for (const q of row.chain.contracts) {
      if (!isRecord(q) || q.underlying !== row.symbol || typeof q.osiSymbol !== "string" || q.expiration !== VALUATION_ASSUMPTIONS.expiration ||
        !["CALL", "PUT"].includes(String(q.optionType)) || ["strike", "bid", "ask", "volume", "openInterest"].some(k => typeof q[k] !== "number" || !Number.isFinite(q[k]))) throw new Error("Malformed option row");
    }
    return row as unknown as { symbol: string; chain: OptionChainSnapshot; receivedAt: string; underlyingLastTradeTimeRaw: string };
  });
  if (outcomes.length !== symbols.length || new Set(outcomes.map(o => o.symbol)).size !== symbols.length || symbols.some(s => !outcomes.some(o => o.symbol === s))) throw new Error("Frozen nine-symbol universe changed");
  return { text, outcomes };
}

async function prepare(): Promise<void> {
  const snapshot = loadSnapshot(inputSnapshot);
  const directory = path.resolve("data/valuation", `study-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "snapshot.json"), snapshot.text, { flag: "wx" });
  const plan = { version: "expiry-scenario-v1", createdAt: new Date().toISOString(), symbols, assumptions: VALUATION_ASSUMPTIONS,
    historicalStart: "2016-09-17", historicalEndExclusive: "2026-09-17", parameterSearch: false,
    models: ["unconditional", "lagged-SMA50-direction-and-fixed-volatility-band"],
    selection: "Nearest listed ATM strike per right, nearest outward wing, one expiry; four structures/root. Choose before inspecting payoff. Retain invalid/unaffordable structures. No search for a favorable strike.",
    objective: "Compare current quoted debit with historical-return terminal payoff scenarios; evaluate rolling return forecasts separately.",
    executionStatus: "BLOCKED_RESEARCH_ONLY", horizon: "Six close-to-close sessions approximate Sep17 delayed snapshot to Sep25 close; exact same-clock horizon is unavailable.",
    knownLimits: ["Delayed quotes and missing per-leg event timestamps", "Corporate-action adjustment convention not independently verified", "Current event evidence is not historical event-conditioned training", "Physically settled expiry payoffs are not executable liquidation; assignment/stock obligations are not simulated", "No planned intraday stop or early-exit profit is inferred", "Retrospective forecast scores and bootstrap percentiles are not calibrated trade confidence"] };
  const planSha256 = writeJson(path.join(directory, "plan.json"), plan);
  log.info("Option scenario experiment registered before return outcomes", { directory, symbols: symbols.length, maximumStructures: 36 });
  const downloader = new YahooHistoricalBars();
  const inputs: { symbol: string; file: string; hash: string; count: number; receivedAt: string; error: string | null }[] = [];
  for (const symbol of symbols) {
    let bars: readonly Bar[] = [], error: string | null = null;
    try {
      bars = await downloader.fetch({ symbol, interval: "1d", startMs: Date.parse("2016-09-17T00:00:00Z"), endMs: Date.parse("2026-09-17T00:00:00Z"), includePrePost: false, cache: false });
      validateBars(bars);
      if (!bars.length || bars.some(b => b.symbol !== symbol || etParts(b.timestamp).date >= "2026-09-17")) throw new Error("Unexpected empty, future or mixed daily input");
    } catch (err) { error = err instanceof Error ? err.message : String(err); bars = []; log.error("Historical valuation input failed", { symbol, error }); }
    const file = `${symbol}-daily.json`;
    inputs.push({ symbol, file, hash: writeJson(path.join(directory, file), bars), count: bars.length, receivedAt: new Date().toISOString(), error });
  }
  writeJson(path.join(directory, "input-manifest.json"), { planSha256, snapshotSha256: sha256(snapshot.text), inputs });
  log.info("Frozen scenario inputs prepared, no payoff rankings calculated", { directory, bars: inputs.reduce((n, i) => n + i.count, 0), failures: inputs.filter(i => i.error).length });
}

function run(directory: string, replay: boolean): void {
  const manifest: unknown = JSON.parse(fs.readFileSync(path.join(directory, "input-manifest.json"), "utf8"));
  const planText = fs.readFileSync(path.join(directory, "plan.json"), "utf8");
  const snapshot = loadSnapshot(path.join(directory, "snapshot.json"));
  if (!isRecord(manifest) || manifest.planSha256 !== sha256(planText) || manifest.snapshotSha256 !== sha256(snapshot.text) || !Array.isArray(manifest.inputs)) throw new Error("Experiment evidence hash mismatch");
  const inputs = manifest.inputs;
  const plan: unknown = JSON.parse(planText);
  if (!isRecord(plan) || plan.version !== "expiry-scenario-v1" || JSON.stringify(plan.assumptions) !== JSON.stringify(VALUATION_ASSUMPTIONS)) throw new Error("Registered valuation assumptions changed");
  const codeHashes = Object.fromEntries(codeFiles.map(f => [f, sha256(fs.readFileSync(f, "utf8"))]));
  if (replay) {
    const execution = JSON.parse(fs.readFileSync(path.join(directory, "execution.json"), "utf8")) as { codeHashes?: unknown };
    if (JSON.stringify(execution.codeHashes) !== JSON.stringify(codeHashes)) throw new Error("Valuation source changed since execution");
  } else writeJson(path.join(directory, "execution.json"), { at: new Date().toISOString(), codeHashes });
  const output = snapshot.outcomes.map(o => {
    const input = inputs.find((i: unknown) => isRecord(i) && i.symbol === o.symbol) as Record<string, unknown> | undefined;
    if (!input || input.file !== `${o.symbol}-daily.json`) throw new Error("Missing or unsafe input manifest row");
    const barsText = fs.readFileSync(path.join(directory, String(input.file)), "utf8");
    if (sha256(barsText) !== input.hash) throw new Error("Historical input changed");
    const bars: unknown = JSON.parse(barsText);
    if (!Array.isArray(bars)) throw new Error("Invalid historical input array");
    const model = buildHistoricalScenarios(bars as Bar[], VALUATION_ASSUMPTIONS.horizonSessions, VALUATION_ASSUMPTIONS.asOfDate);
    const calibration = evaluateHistoricalCalibration(model);
    const structures = enumerateScenarioStructures(o.chain).map(s => {
      const unconditional = summarizeScenarioPayoffs(s, model.allScenarios.map(r => r.logReturn));
      const conditional = summarizeScenarioPayoffs(s, model.matchedScenarios.map(r => r.logReturn));
      const ceiling = scenarioPriceCeiling(s, unconditional, conditional);
      const remaining = ceiling === null || s.debitAsk === null ? null : (ceiling - s.debitAsk) * 100;
      return { structure: s, unconditional, conditional, scenarioPriceCeilingPerShare: ceiling,
        modelCushionPerUnitDollars: remaining, hypotheticalUnits: s.hypotheticalUnitsWithin250,
        status: s.quoteProblems.length ? "REJECT_QUOTE_QUALITY" : s.hypotheticalUnitsWithin250 < 1 ? "REJECT_BUDGET" : ceiling === null ? "INSUFFICIENT_SCENARIOS" : remaining! > 0 ? "MODEL_POSITIVE_UNVALIDATED" : "PRICE_ABOVE_SCENARIO_CEILING",
        executionStatus: "BLOCKED_RESEARCH_ONLY", probabilityOfProfit: null,
        terminalSensitivity: [-.05, -.02, 0, .02, .05].map(change => ({ underlyingChangePct: change * 100,
          terminal: s.spot * (1 + change), theoreticalNetDollars: s.debitAsk === null ? null : (expiryPayoffPerShare(s, s.spot * (1 + change)) - s.debitAsk) * 100 - s.frictionReserveDollars })) };
    });
    return { symbol: o.symbol, underlying: o.chain.underlyingPrice, snapshotReceivedAt: o.receivedAt,
      sourceUnderlyingTradeTimeRaw: o.underlyingLastTradeTimeRaw,
      staleEventSnapshot: o.symbol === "LEN", historicalError: input.error, model, calibration, structures };
  });
  const result = { label: "CURRENT_OPTION_EXPIRY_SCENARIOS_NOT_HISTORICAL_OPTIONS_PNL", assumptions: VALUATION_ASSUMPTIONS,
    executionStatus: "BLOCKED_RESEARCH_ONLY", qualifiedTradeCount: 0, results: output };
  const text = JSON.stringify(result, null, 2) + "\n";
  if (replay) {
    if (text !== fs.readFileSync(path.join(directory, "results.json"), "utf8")) throw new Error("Scenario replay mismatch");
    log.info("Frozen option scenario replay matched", { directory, symbols: output.length }); return;
  }
  const resultHash = writeJson(path.join(directory, "results.json"), result);
  const money = (v: number | null): string => v === null ? "unavailable" : `$${v.toFixed(2)}`;
  const report = ["# Current option price versus historical payoff scenarios", "",
    "Research only. No executable entry, calibrated win probability or historical options profit is claimed. All 36 fixed structures are retained, including unaffordable and invalid quotes.", "",
    "The key question is whether the quoted premium is supported by plausible future payoffs. Direction alone does not answer it. This first prototype applies observed historical close-to-close returns to current option strikes; a positive number remains a model hypothesis.", "",
    "| Symbol | Structure | Long strike / short strike | Expiry | Quoted debit/share | Full debit + reserve/unit | Scenario ceiling/share | Matched windows | Status |",
    "|---|---|---|---|---:|---:|---:|---:|---|",
    ...output.flatMap(o => o.structures.map(r => `| ${o.symbol}${o.staleEventSnapshot ? " (STALE)" : ""} | ${r.structure.kind} | ${r.structure.long.strike} / ${r.structure.short?.strike ?? "none"} | ${VALUATION_ASSUMPTIONS.expiration} | ${money(r.structure.debitAsk)} | ${money(r.structure.theoreticalFullDebitRiskDollars)} | ${money(r.scenarioPriceCeilingPerShare)} | ${o.model.matchedCount} | ${r.status} |`)), "",
    "## Model and execution limits", "",
    "The ceiling is the smaller of unconditional and regime-matched lower bootstrap payoff means, minus cost reserve. Neither distribution is a verified probability forecast. The percentile is 0.05/72 for 36 structures and two models; 5,000 resamples use four adjacent nonoverlapping-return observations per block. It is a descriptive sensitivity bound, not a calibrated confidence interval. Conditional filtering changes calendar spacing, corporate-action handling is unverified, and rare unobserved tails cannot be recreated by resampling.",
    "Six complete trading sessions approximate the remaining horizon to September 25. Delayed intraday marks are not the September 17 closing price, so timing does not exactly match the historical close-anchored samples. LEN's quote is substantially stale. Missing individual quote event times prevent synchronized executable pricing.",
    "Each price uses the observed ask or long ask minus short bid, plus a reserve of $0.10 fee and $0.01/share slippage per leg per side, and 5% annual funding for eight calendar days. Costs are assumptions. The $250 cap covers modeled debit economics; it is not assurance against physical settlement, early assignment or stock obligations. No hold-through-expiry instruction is issued. Intraday stops and early exit values require other data.",
    "Model selection uses lagged SMA50 direction and fixed realized-volatility bands only. It does not contain a historical earnings or news predictor. The separate rolling-origin diagnostic compares conditional and unconditional return forecasts using only outcomes matured before each historical anchor; it does not establish mispriced historical premiums.", "",
    "## Quote provenance", "",
    ...output.map(o => `- ${o.symbol}: received ${o.snapshotReceivedAt}; source underlying last-trade string ${o.sourceUnderlyingTradeTimeRaw}; source timezone not independently verified. ${o.staleEventSnapshot ? "LEN is several hours old and is not a current entry quote." : "Cboe delayed snapshot; per-contract quote timestamp unavailable."}`), "",
    "Exact contracts, all scenario returns, source/config hashes, payoff sensitivities, forecast calibration and every rejection are in results.json and the input manifest. No orders or live collector were started.", ""].join("\n");
  fs.writeFileSync(path.join(directory, "report.md"), report, { flag: "wx" });
  writeJson(path.join(directory, "result-manifest.json"), { resultHash, reportHash: sha256(report) });
  log.info("Current option scenario study completed, no trades qualified", { directory, structures: output.reduce((n, o) => n + o.structures.length, 0),
    modelPositive: output.flatMap(o => o.structures).filter(s => s.status === "MODEL_POSITIVE_UNVALIDATED").length,
    matchedSamples: output.map(o => ({ symbol: o.symbol, count: o.model.matchedCount })) });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 1) throw new Error("Use --prepare, --run=directory or --replay=directory");
  if (args[0] === "--prepare") { await prepare(); return; }
  const match = /^--(run|replay)=(.+)$/.exec(args[0]);
  if (!match) throw new Error("Invalid valuation command");
  run(path.resolve(match[2]), match[1] === "replay");
}
main().catch((error: unknown) => { log.error("Option valuation failed", { error: error instanceof Error ? error.message : String(error) }); process.exitCode = 1; });
