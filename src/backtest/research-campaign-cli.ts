// Historical public-data research only. This program has no broker execution path.
import * as fs from "node:fs";
import * as path from "node:path";
import { createLogger } from "../core/logger.js";
import type { Bar } from "../core/types.js";
import { YahooHistoricalBars } from "../data/yahoo-historical.js";
import { etParts } from "../utils/time.js";
import { readEvidence, sha256, writeJson } from "./evidence-store.js";
import { validateBars } from "./manual-runner.js";
import { runEdgeHypothesis } from "./edge-runner.js";
import { DOUBLE_EDGE_COSTS, FROZEN_EDGE_DEFINITION } from "./edge-definition.js";
import { sessionUncertainty } from "./research-statistics.js";
import { expectedResearchSessions, researchCoverageIssues, RESEARCH_CALENDAR_SOURCE } from "./research-coverage.js";
import type { EdgeResult } from "./edge-types.js";

const log = createLogger("edge-campaign");
const configFile = "config/edge-campaign-v1.json";
// This CLI implements exactly this registration. A different manifest needs a new version.
const FROZEN_CAMPAIGN_SHA256 = "65d3a93a8ebf3e201d4eeb089ab1f92f1f3bed8bd43756c9cdebed92acf18af7";
const priorDirectory = "data/backtests/manual-2026-09-17T17-53-41-131Z";
const sourceFiles = ["src/backtest/edge-types.ts", "src/backtest/edge-definition.ts", "src/backtest/edge-runner.ts",
  "src/backtest/manual-runner.ts", "src/backtest/evidence-store.ts", "src/backtest/research-campaign-cli.ts", "src/backtest/research-statistics.ts", "src/backtest/research-coverage.ts", "src/utils/time.ts"];

interface CampaignInput {
  readonly symbol: string;
  readonly file: string;
  readonly sha256: string;
  readonly retrievedAt: string;
  readonly source: "prior-hashed-Yahoo-evidence" | "YahooHistoricalBars-public-chart";
  readonly bars: number;
  readonly error: string | null;
}

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function parseConfig(text: string): { symbols: string[]; startDate: string; endDateExclusive: string; descriptiveSplitDate: string; prospectiveBoundary: string } {
  if (sha256(text.replace(/\r\n/g, "\n")) !== FROZEN_CAMPAIGN_SHA256) throw new Error("Frozen registration changed; create a new campaign version instead of silently changing reported rules");
  const value: unknown = JSON.parse(text);
  if (!record(value) || value.id !== "edge-screen-v1-20260917" || value.allHistoricalResultsExploratory !== true ||
    value.parameterSearch !== false || !Array.isArray(value.symbols) || value.symbols.length !== 8 ||
    !value.symbols.every(s => typeof s === "string" && /^[A-Z]+$/.test(s)) || new Set(value.symbols).size !== 8 ||
    value.startDate !== "2026-08-03" || value.endDateExclusive !== "2026-09-17" ||
    value.descriptiveSplitDate !== "2026-09-03" || value.prospectiveBoundary !== "2026-09-18") throw new Error("Invalid frozen research campaign");
  return value as unknown as ReturnType<typeof parseConfig>;
}

async function prepare(): Promise<void> {
  const configText = fs.readFileSync(configFile, "utf8");
  const config = parseConfig(configText);
  const preparedAt = new Date().toISOString();
  const directory = path.resolve("data/backtests", `edge-${preparedAt.replace(/[:.]/g, "-")}`);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "campaign.json"), configText, { flag: "wx" });
  writeJson(path.join(directory, "registration.json"), { preparedAt, configSha256: sha256(configText),
    status: "FROZEN_BEFORE_NEW_RETRIEVAL_AND_EVALUATION", allHistoricalResultsExploratory: true, priorObservedEvidence: priorDirectory });
  log.info("Campaign persisted before retrieving additional symbols", { directory, families: 4, symbols: config.symbols });
  const prior = fs.existsSync(priorDirectory) ? readEvidence(path.resolve(priorDirectory)) : null;
  const inputs: CampaignInput[] = [];
  const downloader = new YahooHistoricalBars();
  for (const symbol of config.symbols) {
    let rows: readonly Bar[] = [];
    let error: string | null = null;
    const old = prior?.inputs.find(i => i.symbol === symbol);
    const source = old ? "prior-hashed-Yahoo-evidence" as const : "YahooHistoricalBars-public-chart" as const;
    let retrievedAt = old?.retrievedAt ?? "";
    try {
      if (old?.error) throw new Error(`Prior input was incomplete: ${old.error}`);
      rows = old && prior ? prior.bars.filter(b => b.symbol === symbol) : await downloader.fetch({ symbol, interval: "5m",
        startMs: Date.parse(`${config.startDate}T00:00:00Z`), endMs: Date.parse(`${config.endDateExclusive}T06:00:00Z`),
        includePrePost: false, cache: false });
      if (!old) retrievedAt = new Date().toISOString();
      validateBars(rows);
      rows = rows.filter(b => { const d = etParts(b.timestamp).date; return d >= config.startDate && d < config.endDateExclusive; });
      if (!rows.length || rows.some(b => b.symbol !== symbol)) throw new Error("Empty input or wrong symbol");
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      rows = [];
      retrievedAt ||= new Date().toISOString();
      log.error("Campaign input unavailable", { symbol, error });
    }
    const file = `${symbol}-5m.json`;
    const hash = writeJson(path.join(directory, file), rows);
    inputs.push({ symbol, file, sha256: hash, retrievedAt, source, bars: rows.length, error });
  }
  const inputsSha256 = writeJson(path.join(directory, "inputs.json"), inputs);
  writeJson(path.join(directory, "prepared.json"), { completedAt: new Date().toISOString(), inputsSha256, configSha256: sha256(configText) });
  log.info("Campaign data prepared; no outcomes evaluated yet", { directory, bars: inputs.reduce((n, i) => n + i.bars, 0), failures: inputs.filter(i => i.error).length });
  if (inputs.some(i => i.error)) process.exitCode = 2;
}

function load(directory: string): { configText: string; inputs: CampaignInput[]; bars: Bar[] } {
  const configText = fs.readFileSync(path.join(directory, "campaign.json"), "utf8");
  const manifest: unknown = JSON.parse(fs.readFileSync(path.join(directory, "prepared.json"), "utf8"));
  const inputText = fs.readFileSync(path.join(directory, "inputs.json"), "utf8");
  if (!record(manifest) || manifest.configSha256 !== sha256(configText) || manifest.inputsSha256 !== sha256(inputText)) throw new Error("Campaign manifest mismatch");
  const config = parseConfig(configText);
  const value: unknown = JSON.parse(inputText);
  if (!Array.isArray(value) || value.length !== config.symbols.length) throw new Error("Invalid campaign inputs");
  const inputs: CampaignInput[] = [];
  const bars: Bar[] = [];
  for (const row of value) {
    if (!record(row) || typeof row.symbol !== "string" || !config.symbols.includes(row.symbol) ||
      typeof row.file !== "string" || row.file !== `${row.symbol}-5m.json` || typeof row.sha256 !== "string" ||
      typeof row.retrievedAt !== "string" || typeof row.bars !== "number" || (row.error !== null && typeof row.error !== "string")) throw new Error("Invalid campaign input row");
    const text = fs.readFileSync(path.join(directory, row.file), "utf8");
    if (sha256(text) !== row.sha256) throw new Error(`Input changed: ${row.symbol}`);
    const data: unknown = JSON.parse(text);
    if (!Array.isArray(data) || data.length !== row.bars || data.some(b => !record(b) || b.symbol !== row.symbol)) throw new Error("Malformed historical bars");
    validateBars(data as Bar[]);
    bars.push(...data as Bar[]);
    inputs.push(row as unknown as CampaignInput);
  }
  if (new Set(inputs.map(i => i.symbol)).size !== config.symbols.length) throw new Error("Duplicate input symbol");
  validateBars(bars);
  return { configText, inputs, bars };
}

function evaluate(directory: string, replay: boolean): void {
  const loaded = load(directory);
  const config = parseConfig(loaded.configText);
  const hashes = Object.fromEntries(sourceFiles.map(file => [file, sha256(fs.readFileSync(file, "utf8"))]));
  if (replay) {
    const execution = JSON.parse(fs.readFileSync(path.join(directory, "execution.json"), "utf8")) as { codeHashes?: unknown };
    if (JSON.stringify(execution.codeHashes) !== JSON.stringify(hashes)) throw new Error("Source code changed since recorded execution");
  } else {
    writeJson(path.join(directory, "execution.json"), { evaluatedAt: new Date().toISOString(),
      codeHashes: hashes, definition: FROZEN_EDGE_DEFINITION, configSha256: sha256(loaded.configText) });
  }
  const coverage = researchCoverageIssues(loaded.bars, config.symbols);
  const inputsComplete = loaded.inputs.every(i => i.error === null) && coverage.length === 0;
  const families = FROZEN_EDGE_DEFINITION.families.map(family => {
    const base = runEdgeHypothesis(loaded.bars, family);
    const stress = runEdgeHypothesis(loaded.bars, family, DOUBLE_EDGE_COSTS);
    const sessions = base.sessions.map(s => s.netPnl);
    const uncertainty = inputsComplete && sessions.length >= 15 && sessions.every((n): n is number => n !== null) ? sessionUncertainty(sessions) : null;
    const earlyNet = base.trades.filter(t => t.session < config.descriptiveSplitDate).reduce((n, t) => n + t.netPnl, 0);
    const lateNet = base.trades.filter(t => t.session >= config.descriptiveSplitDate).reduce((n, t) => n + t.netPnl, 0);
    const activeSessions = base.sessions.filter(s => s.tradeCount > 0).length;
    const bestSession = Math.max(0, ...base.sessions.map(s => s.netPnl ?? 0));
    const netWithoutBestSession = base.netPnl === null ? null : base.netPnl - bestSession;
    const failures: string[] = [];
    if (!inputsComplete || !base.eligibleForRanking || !stress.eligibleForRanking) failures.push("incomplete data");
    if (base.trades.length < 30) failures.push("fewer than 30 closed trades");
    if (activeSessions < 15) failures.push("fewer than 15 active sessions");
    if (!(earlyNet > 0 && lateNet > 0)) failures.push("not positive in both descriptive halves");
    if (stress.netPnl === null || stress.netPnl <= 0) failures.push("not positive after doubled costs");
    if (netWithoutBestSession === null || netWithoutBestSession <= 0) failures.push("not positive without best session");
    if (!uncertainty || uncertainty.lowerBoundNetPerSession <= 0) failures.push("session uncertainty lower bound not positive");
    return { family, status: failures.length ? "REJECT_FOR_NOW" : "PRIORITIZE_FOR_OPTIONS_VALIDATION", failures,
      earlyNet, lateNet, activeSessions, netWithoutBestSession, uncertainty, base, stress };
  });
  const result = { label: "EXPLORATORY_UNDERLYING_ONLY_NOT_OPTIONS_PNL", primaryFamilyComparisons: 4,
    allHistoricalResultsExploratory: true, prospectiveBoundary: config.prospectiveBoundary,
    prospectiveCollectionRunning: false, inputsComplete, expectedSessionDates: expectedResearchSessions(),
    calendarSource: RESEARCH_CALENDAR_SOURCE, coverageIssues: coverage, families };
  const serialized = JSON.stringify(result, null, 2) + "\n";
  if (replay) {
    if (serialized !== fs.readFileSync(path.join(directory, "results.json"), "utf8")) throw new Error("Research replay did not match recorded results");
    log.info("Research campaign replay matched exactly", { directory, families: families.length });
    return;
  }
  const resultsSha256 = writeJson(path.join(directory, "results.json"), result);
  const money = (n: number | null): string => n === null ? "unavailable" : `$${n.toFixed(2)}`;
  const subset = (r: EdgeResult, direction: "LONG" | "SHORT"): string => {
    const t = r.trades.filter(t => t.direction === direction);
    return `${t.length} / ${money(t.reduce((n, t) => n + t.netPnl, 0))}`;
  };
  const report = ["# Frozen four-family exploration", "",
    "Underlying direction diagnostic only. These are not option returns, executed trades or proof of a profitable strategy.", "",
    `Eight-symbol universe: ${config.symbols.join(", ")}. ET dates ${config.startDate} through ${config.endDateExclusive} exclusive.`,
    "The entire historical sample is exploratory. Early/late columns describe observed periods; neither is a fresh holdout. All four candidates and both cost scenarios are retained.", "",
    "| Hypothesis | Trades | Long count / net | Short count / net | Net after base costs | Early net | Late net | Net after double costs | Net without best session | Session lower bound | Decision |",
    "|---|---:|---|---|---:|---:|---:|---:|---:|---:|---|",
    ...families.map(f => `| ${f.family} | ${f.base.trades.length} | ${subset(f.base, "LONG")} | ${subset(f.base, "SHORT")} | ${money(f.base.netPnl)} | ${money(f.earlyNet)} | ${money(f.lateNet)} | ${money(f.stress.netPnl)} | ${money(f.netWithoutBestSession)} | ${money(f.uncertainty?.lowerBoundNetPerSession ?? null)} | ${f.status} |`), "",
    ...families.flatMap(f => [`## ${f.family}`, "", `Failed continuation gates: ${f.failures.join("; ") || "none"}.`,
      `Gross ${money(f.base.grossPnl)}; fees ${money(f.base.fees)}; slippage ${money(f.base.slippageCost)}; active sessions ${f.activeSessions}.`, ""]),
    "## Interpretation and next evaluation", "",
    "The gate chooses research priorities, never live trades. Short results are hypothetical directional diagnostics and exclude borrow. $5,000 initial equity, $1,000 notional cap and $25 planned stop risk are assumptions. Base friction is 2 bps per side, minimum $0.005 per share, plus $1 per order; stress doubles each and may change allowed quantities. Neither is a broker fee quotation.",
    "The uncertainty calculation resamples whole five-session circular blocks, including sessions with no trades. The lower percentile is 1.25% (0.05 divided by four families), with 10,000 seeded replicates. This descriptive adjustment does not remove retrospective universe selection, regime dependence, small sample limits or intrabar fill uncertainty. It is not a forecast or win probability.",
    "Five-minute OHLC extrema do not prove available liquidity. Inputs are normalized Yahoo public chart responses, not raw audited exchange data. Required morning observations are checked for all eight symbols against the 32 expected sessions in this fixed window, excluding September 7 per the [NYSE calendar](https://www.nyse.com/trade/hours-calendars). This narrow calendar is not a live holiday/early-close service. No point-in-time news, historical option chain, bid/ask, IV or Greeks are modeled.",
    `Prospective boundary registered for ${config.prospectiveBoundary}. No prospective collector is running and no unseen options results exist. A changed strategy requires a new registration.`, "",
    `Input coverage complete: ${inputsComplete}. Coverage issues: ${coverage.length}.`,
    ...coverage.map(c => `- ${c}`), "",
    "Run manifest, source hashes, normalized inputs, every trade, rejected signal and data-quality issue are retained alongside this report.", ""].join("\n");
  fs.writeFileSync(path.join(directory, "report.md"), report, { flag: "wx" });
  writeJson(path.join(directory, "result-manifest.json"), { resultsSha256, reportSha256: sha256(report) });
  log.info("All frozen candidates evaluated; options profitability not established", { directory,
    families: families.map(f => ({ family: f.family, trades: f.base.trades.length, net: f.base.netPnl, stressNet: f.stress.netPnl, status: f.status })) });
  if (!inputsComplete) process.exitCode = 2;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 1) throw new Error("Use exactly --prepare, --run=directory or --replay=directory");
  if (args[0] === "--prepare") { await prepare(); return; }
  const match = /^--(run|replay)=(.+)$/.exec(args[0]);
  if (!match) throw new Error("Unknown campaign command");
  evaluate(path.resolve(match[2]), match[1] === "replay");
}
main().catch((error: unknown) => { log.error("Research campaign failed", { error: error instanceof Error ? error.message : String(error) }); process.exitCode = 1; });
