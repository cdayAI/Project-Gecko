// Public historical reads only. No broker factory, credentials, LLM or live runner.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "../core/logger.js";
import type { Bar } from "../core/types.js";
import { YahooHistoricalBars } from "../data/yahoo-historical.js";
import { etParts } from "../utils/time.js";
import { DEFAULT_MANUAL_HYPOTHESIS, runManualHypothesis, validateBars } from "./manual-runner.js";
import { readEvidence, renderEvidenceReport, sha256, writeJson } from "./evidence-store.js";
import type { InputEvidence, ManualPlan } from "./manual-types.js";

const log = createLogger("manual-backtest");

function parseDate(value: string): number {
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) throw new Error(`Invalid date: ${value}`);
  return ms;
}

async function main(): Promise<void> {
  const args = new Map<string, string>();
  for (const arg of process.argv.slice(2)) {
    const match = /^--(start|end|symbols|replay)=(.+)$/.exec(arg);
    if (!match || args.has(match[1])) throw new Error(`Invalid or duplicate argument: ${arg}`);
    args.set(match[1], match[2]);
  }
  if (args.has("replay")) {
    if (args.size !== 1) throw new Error("--replay cannot be combined with parameter overrides");
    const directory = path.resolve(args.get("replay")!);
    const evidence = readEvidence(directory);
    const result = evaluate(evidence.plan, evidence.bars);
    const original = JSON.parse(fs.readFileSync(path.join(directory, "results.json"), "utf8")) as unknown;
    if (JSON.stringify(result) !== JSON.stringify(original)) throw new Error("Replay differs from recorded results; code or evidence changed");
    log.info("Evidence replay matched exactly", { directory, trades: result.discovery.trades.length + result.holdout.trades.length });
    return;
  }
  const now = Date.now();
  const today = etParts(now).date;
  const endDate = args.get("end") ?? today;
  const endMs = parseDate(endDate);
  const startDate = args.get("start") ?? new Date(endMs - 45 * 86_400_000).toISOString().slice(0, 10);
  const startMs = parseDate(startDate);
  if (endDate > today || startMs >= endMs || endMs - startMs > 59 * 86_400_000 || startMs < now - 60 * 86_400_000) throw new Error("Use a completed-session window inside the last 60 calendar days, no more than 59 days long");
  const symbols = (args.get("symbols") ?? "SPY,QQQ,TSLA").split(",").map((s) => s.trim().toUpperCase()).sort();
  if (!symbols.length || symbols.length > 12 || new Set(symbols).size !== symbols.length || symbols.some((s) => !/^[A-Z][A-Z0-9.-]{0,14}$/.test(s))) throw new Error("Choose 1-12 distinct valid symbols");
  const holdoutStartDate = new Date(startMs + Math.floor((endMs - startMs) / 86_400_000 * 0.7) * 86_400_000).toISOString().slice(0, 10);
  const sourceDir = path.dirname(fileURLToPath(import.meta.url));
  const sourceFiles = ["manual-types.ts", "manual-runner.ts", "manual-backtest-cli.ts", "evidence-store.ts"];
  const codeHashes = Object.fromEntries(sourceFiles.map((file) => [file, sha256(fs.readFileSync(path.join(sourceDir, file), "utf8"))]));
  const directory = path.resolve("data", "backtests", `manual-${new Date(now).toISOString().replace(/[:.]/g, "-")}`);
  fs.mkdirSync(directory, { recursive: true });
  const plan: ManualPlan = { schemaVersion: 1, createdAt: new Date(now).toISOString(), startDate, endDateExclusive: endDate,
    holdoutStartDate, symbols, hypothesis: DEFAULT_MANUAL_HYPOTHESIS, codeHashes, label: "UNDERLYING_ONLY_DIAGNOSTIC_NOT_OPTIONS_PNL" };
  const planSha256 = writeJson(path.join(directory, "plan.json"), plan);
  log.info("Fixed diagnostic plan persisted before retrieval", { directory, planSha256, holdoutStartDate });
  const inputs: InputEvidence[] = [];
  const bars: Bar[] = [];
  const yahoo = new YahooHistoricalBars();
  for (const symbol of symbols) {
    let rows: readonly Bar[] = [];
    let error: string | null = null;
    try {
      // UTC padding prevents clipping the requested ET start date; evaluation filters ET dates.
      rows = await yahoo.fetch({ symbol, interval: "5m", startMs, endMs: endMs + 6 * 3_600_000, includePrePost: false, cache: false });
      validateBars(rows);
      if (rows.some((b) => b.symbol !== symbol)) throw new Error("Downloader returned wrong symbol");
      if (rows.length === 0) throw new Error("Source returned no bars");
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      log.error("Historical input unavailable; no data substituted", { symbol, error });
      rows = [];
    }
    const file = `${symbol}-5m.json`;
    const hash = writeJson(path.join(directory, file), rows);
    const times = rows.map((b) => b.timestamp);
    inputs.push({ symbol, source: "YahooHistoricalBars-public-chart", retrievedAt: new Date().toISOString(), interval: "5m",
      includePrePost: false, cache: false, requestStartMs: startMs, requestEndMs: endMs + 6 * 3_600_000,
      normalizedInputFile: file, sha256: hash, barCount: rows.length,
      firstBar: times.length ? new Date(Math.min(...times)).toISOString() : null,
      lastBar: times.length ? new Date(Math.max(...times)).toISOString() : null, error });
    bars.push(...rows);
  }
  const inputsSha256 = writeJson(path.join(directory, "inputs.json"), inputs);
  const result = evaluate(plan, bars);
  const resultsSha256 = writeJson(path.join(directory, "results.json"), result);
  const report = renderEvidenceReport(plan, inputs, result.discovery, result.holdout);
  fs.writeFileSync(path.join(directory, "report.md"), report, { flag: "wx" });
  writeJson(path.join(directory, "manifest.json"), { planSha256, inputsSha256, resultsSha256, reportSha256: sha256(report) });
  const unavailable = inputs.some((i) => i.error !== null) || result.discovery.unresolvedPosition !== null || result.holdout.unresolvedPosition !== null;
  log.info("Underlying diagnostic completed; not options P&L", { directory, incomplete: unavailable,
    discoveryTrades: result.discovery.trades.length, discoveryNet: result.discovery.netPnl,
    holdoutTrades: result.holdout.trades.length, holdoutNet: result.holdout.netPnl });
  if (unavailable) process.exitCode = 2;
}

function evaluate(plan: ManualPlan, bars: readonly Bar[]): { discovery: ReturnType<typeof runManualHypothesis>; holdout: ReturnType<typeof runManualHypothesis> } {
  const bounded = bars.filter((b) => { const date = etParts(b.timestamp).date; return date >= plan.startDate && date < plan.endDateExclusive; });
  return {
    discovery: runManualHypothesis(bounded.filter((b) => etParts(b.timestamp).date < plan.holdoutStartDate), plan.hypothesis),
    holdout: runManualHypothesis(bounded.filter((b) => etParts(b.timestamp).date >= plan.holdoutStartDate), plan.hypothesis),
  };
}

main().catch((error: unknown) => {
  log.error("Manual diagnostic failed", { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
