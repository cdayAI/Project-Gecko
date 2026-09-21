// Liquid US common-stock universe for the pre-market scanner.
//
//   npm run universe:build                       # full build (~20-40 min, resumable)
//   npm run universe:build -- --limit 200        # smoke test
//   npm run universe:build -- --min-dollar-volume 50000000 --min-price 5
//   npm run universe:build -- --provider schwab   # Schwab price history (auto when tokens exist)
//
// Source: Nasdaq Trader symbol directories (nasdaqlisted.txt + otherlisted.txt),
// filtered to plain common stock and ADR symbols (no ETFs, test issues,
// warrants, rights, units, preferreds, notes), intersected with Cboe's
// directory of optionable underlyings so every name in the file has listed
// options. Each survivor is priced from
// Yahoo daily bars; names below the price or 20-day average dollar volume
// floor are dropped. Output is data/universe/universe.json with per-symbol
// structure stats the morning scan reads instead of refetching history.
//
// Re-runs on the same day are cheap: the Yahoo daily cache is keyed by day.

import * as fs from "node:fs";
import * as path from "node:path";
import { createLogger, setLogLevel } from "../core/logger.js";
import { fetchWithRetry } from "../utils/retry.js";
import { etParts } from "../utils/time.js";
import { YahooHistoricalBars } from "../data/yahoo-historical.js";
import type { Bar } from "../core/types.js";
import type { SchwabRest } from "../brokers/schwab/rest.js";
import { parseProvider, schwabSession, type ProviderChoice } from "./schwab-session.js";

const log = createLogger("universe");

export const UNIVERSE_FILE = path.join("data", "universe", "universe.json");
const NASDAQ_LISTED = "https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt";
const OTHER_LISTED = "https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt";
// Cboe's directory of every underlying with listed options (CSV, ~5,300 rows).
const CBOE_OPTIONABLE = "https://www.cboe.com/us/options/symboldir/equity-index-options/download";
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";

export interface UniverseEntry {
  readonly symbol: string;
  readonly name: string;
  readonly exchange: string;
  readonly asOf: string;              // last daily bar date used for stats
  readonly lastClose: number;
  readonly avgDollarVol20: number;
  readonly high20: number;
  readonly low20: number;
  readonly high252: number;
  readonly atr14: number;
  readonly sma20: number;
  readonly sma50: number;
}

export interface UniverseFile {
  readonly builtAt: string;
  readonly minPrice: number;
  readonly minDollarVol: number;
  readonly candidates: number;
  readonly entries: readonly UniverseEntry[];
}

export function loadUniverse(): UniverseFile | null {
  try {
    if (!fs.existsSync(UNIVERSE_FILE)) return null;
    const parsed = JSON.parse(fs.readFileSync(UNIVERSE_FILE, "utf-8")) as UniverseFile;
    return Array.isArray(parsed.entries) ? parsed : null;
  } catch (err) {
    log.warn("Universe file unreadable", { error: errMsg(err) });
    return null;
  }
}

interface Listing {
  readonly symbol: string;
  readonly name: string;
  readonly exchange: string;
}

const EXCLUDE_NAME = /preferred|warrant|\bright\b|\brights\b|\bunit\b|\bunits\b|\bnote\b|\bnotes\b|debenture|\bfund\b|\btrust\b|\betn\b|\bbond\b|closed[- ]end|capital securities|subordinated|% /i;

// Pull both directories and keep plain common stock / ADR symbols.
export async function fetchListings(): Promise<readonly Listing[]> {
  const out: Listing[] = [];
  const seen = new Set<string>();
  const nasdaq = await getText(NASDAQ_LISTED);
  for (const line of nasdaq.split("\n").slice(1)) {
    const f = line.split("|");
    if (f.length < 8 || f[0].startsWith("File Creation")) continue;
    const [symbol, name, category, testIssue, , , etf] = f;
    if (etf === "Y" || testIssue === "Y") continue;
    if (!/^[A-Z]{1,5}$/.test(symbol) || EXCLUDE_NAME.test(name)) continue;
    if (!seen.has(symbol)) { seen.add(symbol); out.push({ symbol, name, exchange: `NASDAQ-${category}` }); }
  }
  const optionable = await fetchOptionable();
  const other = await getText(OTHER_LISTED);
  for (const line of other.split("\n").slice(1)) {
    const f = line.split("|");
    if (f.length < 8 || f[0].startsWith("File Creation")) continue;
    const [actSymbol, name, exchange, , etf, , testIssue] = f;
    if (etf === "Y" || testIssue === "Y") continue;
    if (!/^[A-Z]{1,5}$/.test(actSymbol) || EXCLUDE_NAME.test(name)) continue;
    if (!seen.has(actSymbol)) { seen.add(actSymbol); out.push({ symbol: actSymbol, name, exchange }); }
  }
  const kept = optionable.size > 0 ? out.filter((l) => optionable.has(l.symbol)) : out;
  log.info("Listings fetched", { commonStock: out.length, optionable: kept.length });
  return kept;
}

// Symbols from Cboe's optionable directory. Empty set if the download fails,
// in which case the caller keeps the unfiltered common-stock list.
async function fetchOptionable(): Promise<Set<string>> {
  try {
    const csv = await getText(CBOE_OPTIONABLE);
    const set = new Set<string>();
    for (const line of csv.split("\n").slice(1)) {
      const cols = line.split('","');
      if (cols.length < 2) continue;
      const sym = cols[1].replace(/"/g, "").trim();
      if (/^[A-Z]{1,5}$/.test(sym)) set.add(sym);
    }
    log.info("Cboe optionable directory fetched", { symbols: set.size });
    return set;
  } catch (err) {
    log.warn("Cboe optionable directory unavailable; keeping all common stock", { error: errMsg(err) });
    return new Set();
  }
}

async function getText(url: string): Promise<string> {
  const resp = await fetchWithRetry(url, { headers: { "User-Agent": USER_AGENT } });
  return resp.text();
}

export function statsFromDaily(symbol: string, daily: readonly Bar[], today: string): Omit<UniverseEntry, "name" | "exchange"> | null {
  const prior = daily.filter((b) => etParts(b.timestamp).date < today);
  if (prior.length < 60) return null;
  const last = prior[prior.length - 1];
  const w20 = prior.slice(-20);
  const avgDollarVol20 = w20.reduce((s, b) => s + b.close * b.volume, 0) / w20.length;
  const tr: number[] = [];
  for (let i = prior.length - 14; i < prior.length; i++) {
    const pc = prior[i - 1].close;
    tr.push(Math.max(prior[i].high - prior[i].low, Math.abs(prior[i].high - pc), Math.abs(prior[i].low - pc)));
  }
  const mean = (a: readonly number[]): number => a.reduce((s, x) => s + x, 0) / a.length;
  return {
    symbol,
    asOf: etParts(last.timestamp).date,
    lastClose: last.close,
    avgDollarVol20,
    high20: Math.max(...w20.map((b) => b.high)),
    low20: Math.min(...w20.map((b) => b.low)),
    high252: Math.max(...prior.slice(-252).map((b) => b.high)),
    atr14: mean(tr),
    sma20: mean(w20.map((b) => b.close)),
    sma50: mean(prior.slice(-50).map((b) => b.close)),
  };
}

interface BuildArgs {
  minPrice: number;
  minDollarVol: number;
  limit: number;
  provider: ProviderChoice;
}

function parseArgs(argv: readonly string[]): BuildArgs {
  const out: BuildArgs = { minPrice: 5, minDollarVol: 30_000_000, limit: 0, provider: "auto" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--min-price") out.minPrice = Number(argv[++i]);
    else if (a === "--min-dollar-volume") out.minDollarVol = Number(argv[++i]);
    else if (a === "--limit") out.limit = Number(argv[++i]);
    else if (a === "--provider") out.provider = parseProvider(argv[++i]);
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  setLogLevel("warn");
  const listings = await fetchListings();
  let work = args.limit > 0 ? listings.slice(0, args.limit) : listings;
  const yahoo = new YahooHistoricalBars();
  const session = await schwabSession(args.provider);
  const schwab = session.rest;
  process.stdout.write(`history source: ${schwab ? "schwab" : "yahoo"} (${session.reason})\n`);
  if (schwab) {
    // Batch-quote pre-screen on price, 100 symbols per request, before any history call.
    const priced = await schwabPriceScreen(schwab, work.map((l) => l.symbol), args.minPrice);
    work = work.filter((l) => priced.has(l.symbol));
    process.stdout.write(`price pre-screen: ${work.length} of ${listings.length} at or above ${args.minPrice}\n`);
  }
  const now = Date.now();
  const today = etParts(now).date;
  const entries: UniverseEntry[] = [];
  let failed = 0;
  let screened = 0;
  const startedAt = Date.now();

  for (let i = 0; i < work.length; i++) {
    const l = work[i];
    try {
      const daily = schwab
        ? await schwabDaily(schwab, l.symbol)
        : await yahoo.fetch({ symbol: l.symbol, interval: "1d", startMs: now - 400 * 86_400_000, endMs: now, includePrePost: false });
      const s = statsFromDaily(l.symbol, daily, today);
      if (s && s.lastClose >= args.minPrice && s.avgDollarVol20 >= args.minDollarVol) {
        entries.push({ ...s, name: l.name, exchange: l.exchange });
      } else {
        screened++;
      }
    } catch {
      failed++;
    }
    if ((i + 1) % 250 === 0 || i + 1 === work.length) {
      const elapsedMin = (Date.now() - startedAt) / 60_000;
      process.stdout.write(`progress ${i + 1}/${work.length}  kept ${entries.length}  screened out ${screened}  failed ${failed}  ${elapsedMin.toFixed(1)} min\n`);
    }
  }

  entries.sort((a, b) => b.avgDollarVol20 - a.avgDollarVol20);
  const file: UniverseFile = { builtAt: new Date().toISOString(), minPrice: args.minPrice, minDollarVol: args.minDollarVol, candidates: work.length, entries };
  fs.mkdirSync(path.dirname(UNIVERSE_FILE), { recursive: true });
  fs.writeFileSync(UNIVERSE_FILE, JSON.stringify(file));
  process.stdout.write(`\nUniverse written: ${UNIVERSE_FILE}  entries ${entries.length} of ${work.length} candidates (price >= $${args.minPrice}, avg $ volume >= $${(args.minDollarVol / 1e6).toFixed(0)}M)\n`);
}

// Symbols whose last price clears the floor, from batch quotes.
async function schwabPriceScreen(rest: SchwabRest, symbols: readonly string[], minPrice: number): Promise<Set<string>> {
  const keep = new Set<string>();
  for (let i = 0; i < symbols.length; i += 100) {
    const chunk = symbols.slice(i, i + 100);
    try {
      const batch = await rest.getQuotes(chunk);
      for (const [sym, q] of Object.entries(batch)) {
        const last = (q as { quote?: { lastPrice?: number } }).quote?.lastPrice ?? 0;
        if (last >= minPrice) keep.add(sym.toUpperCase());
      }
    } catch (err) {
      log.warn("Schwab quote batch failed; keeping chunk unscreened", { count: chunk.length, error: errMsg(err) });
      for (const sym of chunk) keep.add(sym);
    }
    await sleep(550);   // Schwab allows ~120 requests per minute
  }
  return keep;
}

// One year of daily bars from Schwab price history, spaced for the rate limit.
async function schwabDaily(rest: SchwabRest, symbol: string): Promise<readonly Bar[]> {
  await sleep(550);
  const h = await rest.getPriceHistory({ symbol, periodType: "year", period: 1, frequencyType: "daily", frequency: 1, needExtendedHoursData: false });
  return h.candles.map((c) => ({ symbol, timestamp: c.datetime, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const isMain = process.argv[1] !== undefined && /universe\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`FATAL: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
