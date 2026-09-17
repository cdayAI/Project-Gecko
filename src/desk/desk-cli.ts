// Standalone data-only entry point. Never imports the trading orchestrator/router.
import "dotenv/config";
import * as fs from "node:fs";
import * as path from "node:path";
import { createLogger } from "../core/logger.js";
import { WebullClient } from "../research/providers/webull/client.js";
import { WebullProvider } from "../research/providers/webull/provider.js";
import { isRegularSession } from "../utils/time.js";
import { NewsLedger } from "../research/news/ledger.js";
import { evaluateDesk, type NewsReadiness } from "./engine.js";
import { FillJournal, journalSummary } from "./journal.js";
import { DeskStore } from "./store.js";
import type { DeskConfig, QuoteFrame } from "./types.js";
import { parseConfig, record } from "./validation.js";

const log = createLogger("manual-desk");
export const STARTER_CONFIG: DeskConfig = {
  policy: { planningEquity: 5000, maxFullLossPerTrade: 250, maxPlannedRiskPerTrade: 50,
    maxAggregateDebit: 500, maxCorrelatedDebit: 250, dailyLossLimit: 100,
    feePerContractPerSide: 0.10, optionsPermissionVerified: false, buyingPower: null, positionsReconciledAt: null }, plans: [],
};
function arg(name: string, fallback?: string): string | undefined {
  const prefix = `--${name}=`, inline = process.argv.find(x => x.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
function load(file: string): DeskConfig { return parseConfig(JSON.parse(fs.readFileSync(file, "utf8")) as unknown); }
function lines(file: string): unknown[] { return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map(x => JSON.parse(x) as unknown); }

function newsReadiness(directory: string, config: DeskConfig, now: number): Map<string, NewsReadiness> {
  const ledger = new NewsLedger(directory);
  const events = ledger.readEvents({ now, maxAgeMs: 24 * 3600_000 });
  const health = ledger.readHealth(now);
  const result = new Map<string, NewsReadiness>();
  for (const plan of config.plans) {
    const recent = events.filter(e => e.symbols.includes(plan.symbol) && e.publishedAt <= now && e.firstSeenAt <= now
      && health.some(h => h.source === e.source && (h.status === "ok" || h.status === "partial") && h.checkedAt <= now && now - h.checkedAt < 300_000));
    result.set(plan.symbol, { available: recent.length > 0, eventIds: recent.map(e => `${e.id}@${e.revision}`),
      reasons: recent.length ? [] : ["no recent attributed evidence with a fresh source health check"] });
  }
  return result;
}

export function parseFrame(raw: unknown): QuoteFrame {
  const r = record(raw);
  if (!Number.isSafeInteger(r.capturedAt) || (r.capturedAt as number) <= 0 || !Array.isArray(r.underlying) || !Array.isArray(r.options)
    || !["webull", "recorded", "synthetic"].includes(String(r.source))) throw new Error("Malformed recorded quote frame");
  for (const q of r.underlying) { const x = record(q); if (typeof x.symbol !== "string") throw new Error("Malformed underlying"); }
  for (const q of r.options) { const x = record(q); if (typeof x.osiSymbol !== "string") throw new Error("Malformed option"); }
  if (new Set(r.options.map(q => record(q).osiSymbol)).size !== r.options.length || new Set(r.underlying.map(q => record(q).symbol)).size !== r.underlying.length) throw new Error("Duplicate quote identities");
  return r as unknown as QuoteFrame;
}

async function main(): Promise<void> {
  const dir = arg("directory", "data/desk")!, configFile = arg("config", path.join(dir, "config.json"))!;
  if (process.argv.includes("--init")) {
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify(STARTER_CONFIG, null, 2) + "\n", { flag: "wx" });
    log.info("Created research-only configuration; limits are initial engineering defaults to review", { configFile }); return;
  }
  if (process.argv.includes("--doctor")) {
    const names = ["WEBULL_APP_KEY", "WEBULL_APP_SECRET", "X_BEARER_TOKEN", "BENZINGA_API_KEY"];
    log.info("Local configuration presence only; no authentication or entitlement check", {
      configExists: fs.existsSync(configFile), credentials: Object.fromEntries(names.map(n => [n, Boolean(process.env[n])])),
      optionsHistory: "requires recorded contract bid/ask history", executionMode: "MANUAL_ONLY" }); return;
  }
  const journal = new FillJournal(dir), importFile = arg("import-fills");
  if (importFile) {
    const raw = fs.readFileSync(importFile, "utf8").trim();
    const values: unknown = raw.startsWith("[") ? JSON.parse(raw) : lines(importFile);
    if (!Array.isArray(values)) throw new Error("Expected JSON array or JSONL fills");
    log.info("Imported manual fills", journal.import(values)); return;
  }
  if (process.argv.includes("--report")) {
    const summary = journalSummary(journal.read(), Date.now());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "journal-report.json"), JSON.stringify(summary, null, 2));
    log.info("Manual fill report", summary); return;
  }
  const config = load(configFile), store = new DeskStore(dir);
  if (!config.plans.length) throw new Error("No explicit research plans. Add a versioned plan using the documented schema before monitoring.");
  const lock = path.join(dir, "monitor.lock"), fd = fs.openSync(lock, "wx");
  let stopped = false;
  const stop = (): void => { stopped = true; };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  try {
    store.register(config.plans);
    const replay = arg("replay");
    if (replay) {
      if (fs.existsSync(path.join(dir, "alerts.jsonl")) || fs.existsSync(path.join(dir, "quotes.jsonl"))) throw new Error("Replay requires a fresh isolated --directory, not an existing live/demo output folder");
      let previous: import("./types.js").PlanUpdate[] = [], timestamp = 0;
      for (const raw of lines(replay)) {
        const frame = parseFrame(raw);
        if (frame.capturedAt <= timestamp) throw new Error("Replay requires strictly increasing receipt timestamps");
        timestamp = frame.capturedAt;
        const result = evaluateDesk(config, frame, journal.read(frame.capturedAt), previous, newsReadiness(arg("news-directory", "data/news")!, config, timestamp), store.dailyHaltDate());
        store.publish(config, frame, result, previous); previous = [...result.updates];
      }
      log.info("Recorded frames replayed; alert transitions only, no assumed fills or options return claim", { directory: dir, through: timestamp }); return;
    }
    const key = process.env.WEBULL_APP_KEY, secret = process.env.WEBULL_APP_SECRET;
    if (!key || !secret) throw new Error("Set WEBULL_APP_KEY and WEBULL_APP_SECRET locally to enable read-only Webull monitoring; never paste them into chat");
    const env = process.env.WEBULL_ENV ?? "sandbox";
    if (env !== "sandbox" && env !== "prod") throw new Error("WEBULL_ENV must be sandbox or prod");
    const provider = new WebullProvider(new WebullClient({ appKey: key, appSecret: secret, env }));
    const watch = process.argv.includes("--watch"), interval = Number(arg("interval-ms", "2500")), cycles = Number(arg("cycles", watch ? "0" : "1"));
    if (!Number.isSafeInteger(interval) || interval < 2500 || !Number.isSafeInteger(cycles) || cycles < 0) throw new Error("Interval must be >=2500ms and cycles a nonnegative integer");
    let iteration = 0, verified = "", verifiedAt = 0;
    do {
      const current = load(configFile); store.register(current.plans);
      const asOf = Date.now(), state = journal.read(asOf);
      const contracts = [...new Set([...current.plans.map(p => p.contract), ...state.lots.map(l => l.contract)])];
      const roots = [...new Set([...current.plans.map(p => p.symbol), ...contracts.map(s => s.replace(/\d.*$/, ""))])];
      let frame: QuoteFrame;
      try {
        if (isRegularSession(asOf)) {
          const identity = [...contracts].sort().join(",");
          if (identity !== verified || asOf - verifiedAt > 12 * 3600_000) {
            const references = await provider.getContractReferences(contracts);
            if (references.length !== contracts.length) throw new Error("Some contract references could not be verified");
            verified = identity;
            verifiedAt = Date.now();
          }
          const [underlying, options] = await Promise.all([provider.getSnapshots(roots), provider.getOptionQuotes(contracts)]);
          frame = { capturedAt: Date.now(), underlying, options, source: "webull" };
        } else frame = { capturedAt: asOf, underlying: [], options: [], source: "webull" };
        const previous = store.previous(), result = evaluateDesk(current, frame, journal.read(frame.capturedAt), previous,
          newsReadiness(arg("news-directory", "data/news")!, current, frame.capturedAt), store.dailyHaltDate());
        const changes = store.publish(current, frame, result, previous);
        if (changes) log.info("Manual research board updated", { changes, directory: dir, states: result.updates.map(x => ({ id: x.planId, status: x.status })) });
      } catch (error) {
        frame = { capturedAt: Date.now(), underlying: [], options: [], source: "webull" };
        const previous = store.previous(), result = evaluateDesk(current, frame, journal.read(frame.capturedAt), previous, new Map(), store.dailyHaltDate());
        store.publish(current, frame, result, previous);
        store.health({ at: Date.now(), status: "ERROR", reason: "Data cycle failed; entry eligibility withdrawn" });
        log.error("Data cycle failed; inspect source health and credentials locally", { errorType: error instanceof Error ? error.name : "unknown" });
        if (!watch) throw new Error("Read-only data cycle failed");
      }
      iteration++;
      if (!watch || (cycles > 0 && iteration >= cycles)) break;
      const deadline = Date.now() + interval;
      while (!stopped && Date.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, Math.min(250, deadline - Date.now())));
    } while (!stopped);
  } finally {
    process.off("SIGINT", stop); process.off("SIGTERM", stop);
    fs.closeSync(fd); fs.unlinkSync(lock);
    store.health({ at: Date.now(), status: "STOPPED", reason: "Monitor is not running; previous alerts must not be used as current guidance" });
  }
}

// This file is a CLI only; shared validation lives in separate modules.
main().catch(error => { log.error(error instanceof Error ? error.message : "Desk failed"); process.exitCode = 1; });
