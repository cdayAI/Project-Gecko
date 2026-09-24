// Pull intraday history into data/history/5m/ for the backtests.
//
//   npm run history:pull -- --provider schwab --days 180          # whole universe, resumable
//   npm run history:pull -- --provider schwab --days 180 --max-names 300
//   npm run history:pull -- --provider yahoo --days 59            # structural test only (Yahoo caps at ~60 days)
//   npm run history:pull -- --status                              # what the store holds
//
// Schwab: 5-minute bars with extended hours via /marketdata/v1/pricehistory.
// The maximum range per request is not documented for minute bars, so the
// puller asks for the whole range, then walks backward from the earliest
// candle returned until the requested start is covered or a request returns
// nothing new (at most 40 requests per symbol). Requests are spaced ~550 ms
// (Schwab allows about 120 per minute). A symbol whose stored history already
// reaches the requested start is skipped unless --refresh is given, so an
// interrupted run resumes. The store is gitignored.

import * as fs from "node:fs";
import { setLogLevel, createLogger } from "../core/logger.js";
import { etParts } from "../utils/time.js";
import { YahooHistoricalBars } from "./yahoo-historical.js";
import { loadStoredIntraday, mergeBars, saveStoredIntraday, STORE_DIR } from "./bar-store.js";
import { loadUniverse } from "../research/universe.js";
import { parseProvider, schwabSession, type ProviderChoice } from "../research/schwab-session.js";
import { SECTOR_ETFS } from "../research/sectors.js";
import type { SchwabRest } from "../brokers/schwab/rest.js";
import type { Bar } from "../core/types.js";

const log = createLogger("history-pull");

interface Args { provider: ProviderChoice; days: number; maxNames: number; refresh: boolean; status: boolean; symbols: string[] | null }

function parseArgs(argv: readonly string[]): Args {
  const out: Args = { provider: "auto", days: 180, maxNames: 0, refresh: false, status: false, symbols: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--provider") out.provider = parseProvider(argv[++i]);
    else if (a === "--days") out.days = Number(argv[++i]);
    else if (a === "--max-names") out.maxNames = Number(argv[++i]);
    else if (a === "--refresh") out.refresh = true;
    else if (a === "--status") out.status = true;
    else if (a === "--symbols") out.symbols = (argv[++i] ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  setLogLevel("warn");
  if (args.status) { printStatus(); return; }
  const uni = loadUniverse();
  if (!uni && !args.symbols) throw new Error("No universe file; run npm run universe:build first (or pass --symbols)");
  // Sector ETFs first so regime and sector cuts in the backtests cover the whole store.
  const names = args.symbols ?? [...SECTOR_ETFS, ...(args.maxNames > 0 ? uni!.entries.slice(0, args.maxNames) : uni!.entries).map((e) => e.symbol)];
  const now = Date.now();
  const startMs = now - args.days * 86_400_000;
  const session = await schwabSession(args.provider);
  const useSchwab = session.rest !== null && args.provider !== "yahoo";
  process.stdout.write(`history:pull ${names.length} names, ${args.days} days, source ${useSchwab ? "schwab" : "yahoo"} (${session.reason})\n`);
  const yahoo = new YahooHistoricalBars();
  const startedAt = Date.now();
  let done = 0, skipped = 0, failed = 0, requests = 0;
  for (let i = 0; i < names.length; i++) {
    const symbol = names[i];
    try {
      const existing = loadStoredIntraday(symbol);
      if (existing && !args.refresh && existing[0].timestamp <= startMs + 3 * 86_400_000) { skipped++; progress(i); continue; }
      let bars: Bar[];
      if (useSchwab) {
        const r = await pullSchwab(session.rest as SchwabRest, symbol, startMs, now);
        bars = r.bars; requests += r.requests;
      } else {
        bars = [...await yahoo.fetch({ symbol, interval: "5m", startMs: Math.max(startMs, now - 59 * 86_400_000), endMs: now, includePrePost: true, cache: false })];
        requests++;
      }
      if (bars.length === 0) { failed++; continue; }
      saveStoredIntraday(symbol, existing ? mergeBars(existing, bars) : bars);
      done++;
    } catch (err) {
      failed++;
      log.warn("pull failed", { symbol, error: err instanceof Error ? err.message : String(err) });
    }
    progress(i);
  }
  printStatus();

  function progress(i: number): void {
    if ((i + 1) % 50 === 0 || i + 1 === names.length) process.stdout.write(`  ${i + 1}/${names.length}  stored ${done}  skipped ${skipped}  failed ${failed}  requests ${requests}  ${((Date.now() - startedAt) / 60_000).toFixed(1)} min\n`);
  }
}

async function pullSchwab(rest: SchwabRest, symbol: string, startMs: number, endMs: number): Promise<{ bars: Bar[]; requests: number }> {
  let all: Bar[] = [];
  let end = endMs;
  let requests = 0;
  for (let hop = 0; hop < 40; hop++) {
    await sleep(550);
    requests++;
    const h = await rest.getPriceHistory({ symbol, periodType: "day", frequencyType: "minute", frequency: 5, startDate: startMs, endDate: end, needExtendedHoursData: true });
    const got = h.candles.map((c) => ({ symbol, timestamp: c.datetime, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
    if (got.length === 0) break;
    const before = all.length;
    all = mergeBars(all, got);
    const earliest = all[0].timestamp;
    if (all.length === before || earliest <= startMs + 86_400_000) break;
    end = earliest - 1;
  }
  return { bars: all, requests };
}

function printStatus(): void {
  if (!fs.existsSync(STORE_DIR)) { process.stdout.write(`store ${STORE_DIR}: empty\n`); return; }
  const files = fs.readdirSync(STORE_DIR).filter((f) => f.endsWith(".json"));
  let earliest = Infinity, latest = 0, sessions = new Set<string>();
  let sampled = 0;
  for (const f of files) {
    if (sampled >= 200) break;
    const rows = loadStoredIntraday(f.replace(/\.json$/, ""));
    if (!rows) continue;
    sampled++;
    earliest = Math.min(earliest, rows[0].timestamp); latest = Math.max(latest, rows[rows.length - 1].timestamp);
    if (sampled <= 20) for (const b of rows) sessions.add(etParts(b.timestamp).date);
  }
  process.stdout.write(`store ${STORE_DIR}: ${files.length} symbols; sampled ${sampled}: earliest ${Number.isFinite(earliest) ? etParts(earliest).date : "n/a"}, latest ${latest ? etParts(latest).date : "n/a"}, ~${sessions.size} sessions in the first 20 files\n`);
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

main().catch((err) => { process.stderr.write(`FATAL: ${err instanceof Error ? err.message : String(err)}\n`); process.exit(1); });
