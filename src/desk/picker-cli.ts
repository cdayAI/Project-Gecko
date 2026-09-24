import "dotenv/config";
import * as fs from "node:fs";
import * as path from "node:path";
import { createLogger } from "../core/logger.js";
import { WebullClient } from "../research/providers/webull/client.js";
import { WebullProvider } from "../research/providers/webull/provider.js";
import type { Candidate, ResearchPacket } from "../research/types.js";
import { pickOptions, renderOptionsPickerMarkdown } from "./picker.js";
import { record } from "./validation.js";

const log = createLogger("options-picker");
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const file = args.find(x => x.startsWith("--packet="))?.slice(9);
  if (!file || args.some(x => x !== "--refresh-webull" && !x.startsWith("--packet="))) throw new Error("Use --packet=path/to/research-packet.json [--refresh-webull]");
  if (fs.statSync(file).size > 20_000_000) throw new Error("Research packet is too large");
  const raw = record(JSON.parse(fs.readFileSync(file, "utf8")) as unknown);
  if (!Array.isArray(raw.candidates) || typeof raw.generatedAt !== "string" || typeof raw.id !== "string") throw new Error("Malformed research packet");
  let packet = raw as unknown as ResearchPacket;
  if (args.includes("--refresh-webull")) {
    const age = Date.now() - Date.parse(packet.generatedAt);
    if (!Number.isFinite(age) || age < 0 || age > 15 * 60_000) throw new Error("Refresh requires a research packet from the last 15 minutes");
    const key = process.env.WEBULL_APP_KEY, secret = process.env.WEBULL_APP_SECRET, env = process.env.WEBULL_ENV ?? "sandbox";
    if (!key || !secret) throw new Error("Webull credentials are missing from the local environment");
    if (env !== "prod" && env !== "sandbox") throw new Error("Invalid WEBULL_ENV");
    const provider = new WebullProvider(new WebullClient({ appKey: key, appSecret: secret, env }));
    // Bound to five roots and four shortlisted contracts per root, one snapshot batch.
    // This is a quote refresh, not a claim to search every listed option.
    const shortlist = packet.candidates.slice(0, 5).map(candidate => {
      const contracts = (candidate.chain?.contracts ?? []).filter(q => Number.isFinite(q.ask) && q.ask > 0 && q.ask * 100 + 0.20 <= 250
        && q.delta !== null && Number.isFinite(q.delta) && Math.abs(q.delta) >= 0.35 && Math.abs(q.delta) <= 0.65)
        .sort((a, b) => (a.ask - a.bid) / a.ask - (b.ask - b.bid) / b.ask).slice(0, 4);
      return { candidate, contracts };
    });
    const symbols = [...new Set(shortlist.flatMap(x => x.contracts.map(q => q.osiSymbol)))];
    if (!symbols.length) throw new Error("No bounded affordable contracts to refresh; no trade candidate");
    await provider.getContractReferences(symbols);
    const [stocks, options] = await Promise.all([provider.getSnapshots(shortlist.map(x => x.candidate.symbol)), provider.getOptionQuotes(symbols)]);
    const asOf = Date.now();
    const candidates: Candidate[] = shortlist.map(({ candidate }) => ({ ...candidate,
      snapshot: stocks.find(q => q.symbol === candidate.symbol) ?? candidate.snapshot,
      chain: candidate.chain ? { ...candidate.chain, contracts: options.filter(q => q.underlying === candidate.symbol),
        provenance: { source: "webull", capturedAt: asOf, delayed: false, delayStatus: "unknown", note: "Per-contract metadata determines qualification; bounded exact-symbol refresh" } } : null,
      warnings: [...candidate.warnings, "Only up to four shortlisted contracts were refreshed; discovery is incomplete"] }));
    packet = { ...packet, candidates };
  }
  const report = pickOptions(packet);
  const dir = path.join("data", "desk-candidates", new Date().toISOString().replace(/[:.]/g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(dir, "report.md"), renderOptionsPickerMarkdown(report));
  log.info("Options research shortlist written; no plans activated", { directory: dir, picks: report.picks.length,
    decisions: report.decisions.map(d => ({ symbol: d.symbol, status: d.status, reasons: d.codes })) });
}
main().catch(error => { log.error(error instanceof Error ? error.message : "Picker failed"); process.exitCode = 1; });
