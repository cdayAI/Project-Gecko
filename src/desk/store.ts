import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { DeskEvaluation } from "./engine.js";
import type { DeskConfig, ManualPlan, PlanUpdate, QuoteFrame } from "./types.js";
import { parsePlan } from "./validation.js";

function append(file: string, value: unknown): void { fs.appendFileSync(file, JSON.stringify(value) + "\n"); }
function readLines(file: string): unknown[] { return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map(x => JSON.parse(x) as unknown) : []; }
function atomic(file: string, value: string): void { const temporary = `${file}.${process.pid}.tmp`; fs.writeFileSync(temporary, value); fs.renameSync(temporary, file); }
export class DeskStore {
  constructor(readonly directory = "data/desk") { fs.mkdirSync(directory, { recursive: true }); }
  register(plans: readonly ManualPlan[]): void {
    const existing = new Map(readLines(path.join(this.directory, "plans.jsonl")).map(x => { const p = parsePlan(x); return [`${p.id}:${p.version}`, JSON.stringify(p)]; }));
    for (const plan of plans) {
      const key = `${plan.id}:${plan.version}`, body = JSON.stringify(plan), known = existing.get(key);
      if (known && known !== body) throw new Error(`Plan ${key} changed without a new version`);
      if (!known) { append(path.join(this.directory, "plans.jsonl"), plan); existing.set(key, body); }
    }
  }
  previous(): PlanUpdate[] {
    // The append-only transition log is authoritative; recover even after a board write failed.
    const byKey = new Map<string, PlanUpdate>();
    for (const value of readLines(path.join(this.directory, "alerts.jsonl"))) {
      const update = value as PlanUpdate;
      if (!update || typeof update.planId !== "string" || !Number.isFinite(update.at) || !Number.isSafeInteger(update.version)) throw new Error("Malformed alert log");
      byKey.set(`${update.planId}:${update.version}`, update);
    }
    return [...byKey.values()];
  }
  dailyHaltDate(): string | null {
    const file = path.join(this.directory, "daily-halt.json");
    if (!fs.existsSync(file)) return null;
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || !("date" in value) || (value.date !== null && (typeof value.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.date)))) throw new Error("Invalid persisted daily halt");
    return value.date;
  }
  publish(config: DeskConfig, frame: QuoteFrame, result: DeskEvaluation, previous: readonly PlanUpdate[]): number {
    // Persist a triggered account halt before publishing any new entry status.
    atomic(path.join(this.directory, "daily-halt.json"), JSON.stringify({ date: result.dailyHaltDate }));
    append(path.join(this.directory, "quotes.jsonl"), frame);
    const byKey = new Map(previous.map(x => [`${x.planId}:${x.version}`, x]));
    let count = 0;
    for (const update of result.updates) {
      const prior = byKey.get(`${update.planId}:${update.version}`);
      if (!prior || prior.status !== update.status || JSON.stringify(prior.reasons) !== JSON.stringify(update.reasons)) {
        append(path.join(this.directory, "alerts.jsonl"), update); count++;
      }
    }
    const configHash = createHash("sha256").update(JSON.stringify(config)).digest("hex");
    atomic(path.join(this.directory, "board.json"), JSON.stringify({ generatedAt: frame.capturedAt, mode: "MANUAL_RESEARCH_ONLY", configHash, ...result }, null, 2));
    atomic(path.join(this.directory, "board.md"), renderBoard(config, frame, result));
    this.health({ at: frame.capturedAt, status: "OK", source: frame.source, changes: count, configHash });
    return count;
  }
  health(value: Record<string, unknown>): void { atomic(path.join(this.directory, "health.json"), JSON.stringify(value, null, 2)); }
}

function renderBoard(config: DeskConfig, frame: QuoteFrame, result: DeskEvaluation): string {
  const lines = ["# Gecko manual trading desk", "", `Observed ${new Date(frame.capturedAt).toISOString()}. Source: ${frame.source}.`,
    "This is a static snapshot. ELIGIBLE expires at the stated time and requires a fresh check before manual execution. No orders are submitted.",
    "Planned stops are not guaranteed fills. Full loss is the entire premium plus the fee allowance. Profit values below are scenarios, not forecasts.", "",
    "| Plan | Contract | State | Bid / ask | Qty | Maximum debit | Planned risk | Full loss | Target profit scenario | Eligible until |",
    "|---|---|---|---|---:|---:|---:|---:|---:|---|" ];
  for (const update of result.updates) {
    const p = config.plans.find(x => x.id === update.planId && x.version === update.version)!;
    const price = (v: number | null): string => v === null ? "unknown" : v.toFixed(2);
    lines.push(`| ${p.id} v${p.version} | ${p.contract} | ${update.status} | ${price(update.bid)} / ${price(update.ask)} | ${update.quantity} | $${p.maxEntry.toFixed(2)} | $${update.plannedRisk.toFixed(2)} | $${update.fullLoss.toFixed(2)} | $${update.targetProfitScenario.toFixed(2)} | ${update.status === "ELIGIBLE" ? new Date(update.validUntil).toISOString() : "not eligible"} |`);
  }
  for (const p of config.plans) {
    const u = result.updates.find(x => x.planId === p.id && x.version === p.version)!;
    lines.push("", `## ${p.id} v${p.version}`, "", `Status: ${u.status}. ${u.reasons.join("; ")}.`,
      `Setup: ${p.strategy}. ${p.thesis}`, `Counterevidence: ${p.counterevidence}`,
      `Underlying trigger ${p.trigger}; maximum chase ${p.maxChase}; invalidation ${p.invalidation}.`,
      `Option stop bid ${p.stopBid}; target bid ${p.targetBid}; time exit ${new Date(p.timeExit).toISOString()}.`,
      `Evidence IDs: ${p.evidenceIds.join(", ") || "none"}. Confidence: unvalidated; win probability unavailable.`);
  }
  if (result.unmonitoredPositions.length) lines.push("", "## Open positions needing a monitoring plan", "", ...result.unmonitoredPositions.map(x => `- ${x}`));
  return lines.join("\n") + "\n";
}
