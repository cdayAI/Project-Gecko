import * as fs from "node:fs";
import * as path from "node:path";
import { createLogger } from "../core/logger.js";
import { parsePlan, record } from "../desk/validation.js";
import type { QuoteFrame } from "../desk/types.js";
import { replayManualOption } from "./manual-options-replay.js";
import { sha256, writeJson } from "./evidence-store.js";

const log = createLogger("manual-options-replay");
function main(): void {
  const args = new Map<string, string>();
  let allowSynthetic = false;
  for (const arg of process.argv.slice(2)) {
    if (arg === "--allow-synthetic") { allowSynthetic = true; continue; }
    const parsed = /^--(plan|frames)=(.+)$/.exec(arg);
    if (!parsed || args.has(parsed[1])) throw new Error(`Invalid or duplicate argument: ${arg}`);
    args.set(parsed[1], parsed[2]);
  }
  if (!args.has("plan") || !args.has("frames")) throw new Error("Supply --plan=single-plan.json and --frames=quotes.jsonl");
  const planText = fs.readFileSync(args.get("plan")!, "utf8");
  const frameText = fs.readFileSync(args.get("frames")!, "utf8");
  const plan = parsePlan(JSON.parse(planText) as unknown);
  const frames = frameText.split(/\r?\n/).filter(Boolean).map((line): QuoteFrame => {
    const r = record(JSON.parse(line) as unknown);
    if (!Number.isSafeInteger(r.capturedAt) || !Array.isArray(r.options) || !Array.isArray(r.underlying) ||
        !["webull", "recorded", "synthetic"].includes(String(r.source))) throw new Error("Malformed quote frame");
    for (const q of r.options) { const v = record(q); if (typeof v.osiSymbol !== "string") throw new Error("Invalid option identity"); }
    for (const q of r.underlying) { const v = record(q); if (typeof v.symbol !== "string") throw new Error("Invalid underlying identity"); }
    return r as unknown as QuoteFrame;
  });
  const result = replayManualOption(plan, frames, { allowSynthetic });
  const directory = path.resolve("data", "backtests", `options-replay-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  fs.mkdirSync(directory, { recursive: true });
  // Preserve exact input bytes and hashes without implying that quotes were fills.
  fs.writeFileSync(path.join(directory, "plan.json"), planText, { flag: "wx" });
  fs.writeFileSync(path.join(directory, "quotes.jsonl"), frameText, { flag: "wx" });
  const resultHash = writeJson(path.join(directory, "result.json"), result);
  writeJson(path.join(directory, "manifest.json"), { planSha256: sha256(planText), framesSha256: sha256(frameText), resultSha256: resultHash,
    options: { allowSynthetic }, fillAssumption: "next-frame ask plus $0.01/share; observed bid minus $0.01/share; $0.10/contract/side",
    limitation: "Single plan hypothetical quote replay. No fill guarantee, aggregate edge, or options profitability qualification." });
  log.info("Option quote replay completed", { directory, status: result.status, label: result.label, netPnl: result.netPnl });
  if (result.status.startsWith("UNRESOLVED") || result.status.startsWith("BLOCKED")) process.exitCode = 2;
}
try { main(); }
catch (error) { log.error("Option quote replay failed", { error: error instanceof Error ? error.message : String(error) }); process.exitCode = 1; }
