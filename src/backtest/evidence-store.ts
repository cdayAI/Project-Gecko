import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Bar } from "../core/types.js";
import type { EvidenceRun, InputEvidence, ManualPlan, ManualResult } from "./manual-types.js";
import { validateBars, validateHypothesis } from "./manual-runner.js";

export function sha256(text: string): string { return createHash("sha256").update(text).digest("hex"); }

export function writeJson(file: string, data: unknown): string {
  const text = JSON.stringify(data, null, 2) + "\n";
  fs.writeFileSync(file, text, { flag: "wx" });
  return sha256(text);
}

export function readEvidence(directory: string): EvidenceRun {
  const planText = fs.readFileSync(path.join(directory, "plan.json"), "utf8");
  const hashes: unknown = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));
  if (!isRecord(hashes) || typeof hashes.planSha256 !== "string" || hashes.planSha256 !== sha256(planText)) throw new Error("Plan hash mismatch");
  const value: unknown = JSON.parse(planText);
  if (!isRecord(value) || value.schemaVersion !== 1 || value.label !== "UNDERLYING_ONLY_DIAGNOSTIC_NOT_OPTIONS_PNL" ||
      !Array.isArray(value.symbols) || !value.symbols.every((s) => typeof s === "string") ||
      typeof value.startDate !== "string" || typeof value.endDateExclusive !== "string" ||
      typeof value.holdoutStartDate !== "string" || !isRecord(value.hypothesis)) throw new Error("Invalid evidence plan");
  const plan = value as unknown as ManualPlan;
  validateHypothesis(plan.hypothesis);
  const inputText = fs.readFileSync(path.join(directory, "inputs.json"), "utf8");
  if (hashes.inputsSha256 !== sha256(inputText)) throw new Error("Input manifest hash mismatch");
  const inputsValue: unknown = JSON.parse(inputText);
  if (!Array.isArray(inputsValue)) throw new Error("Invalid input manifest");
  const inputs: InputEvidence[] = [];
  const bars: Bar[] = [];
  for (const row of inputsValue) {
    if (!isRecord(row) || typeof row.symbol !== "string" || typeof row.normalizedInputFile !== "string" ||
        typeof row.sha256 !== "string" || (row.error !== null && typeof row.error !== "string")) throw new Error("Invalid input evidence row");
    const input = row as unknown as InputEvidence;
    if (path.basename(input.normalizedInputFile) !== input.normalizedInputFile) throw new Error("Unsafe evidence input path");
    const text = fs.readFileSync(path.join(directory, input.normalizedInputFile), "utf8");
    if (sha256(text) !== input.sha256) throw new Error(`Input hash mismatch for ${input.symbol}`);
    const data: unknown = JSON.parse(text);
    if (!Array.isArray(data) || !data.every(isBar)) throw new Error(`Invalid input bars for ${input.symbol}`);
    validateBars(data);
    if (data.some((b) => b.symbol !== input.symbol)) throw new Error(`Input symbol mismatch for ${input.symbol}`);
    bars.push(...data);
    inputs.push(input);
  }
  return { plan, inputs, bars };
}

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function isBar(value: unknown): value is Bar {
  return isRecord(value) && typeof value.symbol === "string" &&
    ["timestamp", "open", "high", "low", "close", "volume"].every((key) => typeof value[key] === "number");
}

export function renderEvidenceReport(plan: ManualPlan, inputs: readonly InputEvidence[], discovery: ManualResult, holdout: ManualResult): string {
  const money = (value: number): string => `$${value.toFixed(2)}`;
  const pct = (value: number | null): string => value === null ? "n/a" : `${(value * 100).toFixed(2)}%`;
  const rows = [["Discovery", discovery], ["Chronological holdout", holdout]] as const;
  return [
    "# Underlying ORB diagnostic", "", "**NOT OPTIONS P&L. No executable trade recommendation or profitability qualification.**", "",
    `Fixed hypothesis: ${plan.hypothesis.version}. Plan written before data retrieval at ${plan.createdAt}.`,
    `Requested ET dates: ${plan.startDate} through ${plan.endDateExclusive} exclusive. Holdout begins ${plan.holdoutStartDate}.`,
    `Universe fixed before retrieval: ${plan.symbols.join(", ")}. Long-only; no stock borrow, margin, or options modeled.`, "",
    "| Partition | Sessions with bars | Trades | Gross before modeled costs | Modeled slippage | Fees | Net | Win rate | Profit factor | Max sampled liquidation drawdown |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...rows.map(([name, r]) => `| ${name} | ${r.sessionDates.length} | ${r.trades.length} | ${money(r.grossPnl)} | ${money(r.slippageCost)} | ${money(r.fees)} | ${money(r.netPnl)} | ${pct(r.winRate)} | ${r.profitFactor?.toFixed(2) ?? "n/a"} | ${money(r.maxFiveMinuteLiquidationDrawdown)} |`),
    "", "Each partition starts independently with $5,000. These are hypothetical share returns, not option returns. Positive results cannot qualify an options strategy.", "",
    "## Input availability", "",
    "| Symbol | Bars | First timestamp (UTC) | Last timestamp (UTC) | Retrieval |", "|---|---:|---|---|---|",
    ...inputs.map((i) => `| ${i.symbol} | ${i.barCount} | ${i.firstBar ?? "none"} | ${i.lastBar ?? "none"} | ${i.error ?? i.retrievedAt} |`), "",
    "## Unresolved or incomplete evidence", "",
    `Failed symbols: ${inputs.filter((i) => i.error).map((i) => i.symbol).join(", ") || "none"}.`,
    `Unresolved positions: discovery=${JSON.stringify(discovery.unresolvedPosition)}; holdout=${JSON.stringify(holdout.unresolvedPosition)}.`,
    "Missing intervals disable new signals when observed; held positions liquidate at the next available open with data-gap reason. They are not silently dropped using future knowledge. A terminal unresolved position invalidates portfolio completion.",
    "Entire missing market sessions cannot be distinguished from holidays without an exchange calendar. Bar source corrections, omissions and OHLC construction are unverified. Normalized downloader output is hashed; raw HTTP payloads are not retained by that existing downloader.", "",
    "## Interpretation limits", "",
    "- Hypothesis and split were fixed before retrieval; neither partition is tuned. The holdout has now been observed and cannot be reused as unseen evidence after changing rules.",
    "- Fixed present-day symbols and a short recent period do not establish robustness across universes, regimes or delisted stocks.",
    "- Costs are declared stress assumptions, not a Webull commission quote or measured execution quality: 2 bps per side, minimum $0.005/share, plus $1 per order.",
    "- Exact intrabar event ordering is unknown. A bar touching both stop and target uses stop first; stops gapping through fill at the worse open. Targets never receive favorable gap improvement.",
    "- Price extrema do not establish a fill or available liquidity. Intrabar exits become available to the shared portfolio only at the bar closing boundary.",
    "- Drawdown is sampled at five-minute liquidation marks and can understate intrabar drawdown. No annualized Sharpe, confidence percentage or forecast is emitted.",
    "- No historical option bid/ask, quoted size, IV surface, Greeks, fills, assignment or expiry events are present. Options profitability is unavailable, never synthesized from stock movement.",
    "- This deliberately simple ORB hypothesis is not the complete legacy strategy: no catalyst, gap, news, short-sale, VWAP or regime filter is claimed.",
    "", "See docs/manual-backtesting.md for event order, replay commands, data requirements and legacy audit findings.", "",
  ].join("\n");
}
