// Catalyst gap-and-go diagnostic over the liquid optionable universe.
//
//   npm run backtest:gapgo                       # top 1,500 names, 59 days
//   npm run backtest:gapgo -- --max-names 300 --min-gap 3 --slippage-bps 10
//   npm run backtest:gapgo -- --out data/bt/gapgo.jsonl
//   npm run backtest:gapgo -- --source store --grid      # Schwab store (npm run history:pull)
//
// --source auto|yahoo|store: the store (data/history/5m) is used when a symbol
// is present, else Yahoo's 60-day window. With the store the grid splits
// selection/validation at the median session instead of the fixed dates.
//
// Rule (frozen in docs/gap-and-go-registration-2026-09-21.md): pre-market
// last at least --min-gap percent from the prior close and beyond the prior
// 20-session high (long) or low (short); skip if the 09:30 open is more than
// 1.5% beyond the pre-market extreme; enter at the next bar's open after the
// first 5-minute candle from 09:30 that closes beyond the pre-market extreme
// (latest signal 11:30); stop on a 5-minute close back through the 09:30
// candle's opposite extreme; half at +1 ATR(14), rest at +1.5 ATR; remainder
// out at 15:45. Underlying shares only; costs as slippage per side.

import * as fs from "node:fs";
import * as path from "node:path";
import { createLogger, setLogLevel } from "../core/logger.js";
import { etParts } from "../utils/time.js";
import { YahooHistoricalBars } from "../data/yahoo-historical.js";
import { loadUniverse } from "../research/universe.js";
import { loadStoredIntraday } from "../data/bar-store.js";
import { SECTOR_ETFS, sectorFor } from "../research/sectors.js";
import type { Bar } from "../core/types.js";

const log = createLogger("gap-and-go");

interface Args {
  maxNames: number;
  minGapPct: number;
  slippageBps: number;
  out: string;
  lookbackDays: number;
  grid: boolean;
  gridOut: string;
  source: "auto" | "yahoo" | "store";
  split: "date" | "half";
}

function parseArgs(argv: readonly string[]): Args {
  const out: Args = { maxNames: 1500, minGapPct: 3, slippageBps: 5, out: "", lookbackDays: 59, grid: false, gridOut: "", source: "auto", split: "date" };
  let splitGiven = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--max-names") out.maxNames = Number(argv[++i]);
    else if (a === "--min-gap") out.minGapPct = Number(argv[++i]);
    else if (a === "--slippage-bps") out.slippageBps = Number(argv[++i]);
    else if (a === "--out") out.out = argv[++i] ?? "";
    else if (a === "--lookback") out.lookbackDays = Number(argv[++i]);
    else if (a === "--grid") out.grid = true;
    else if (a === "--grid-out") out.gridOut = argv[++i] ?? "";
    else if (a === "--source") { const v = (argv[++i] ?? "").toLowerCase(); if (v === "yahoo" || v === "store" || v === "auto") out.source = v; }
    else if (a === "--split") { const v = (argv[++i] ?? "").toLowerCase(); if (v === "date" || v === "half") { out.split = v; splitGiven = true; } }
  }
  if (!splitGiven && out.source === "store") out.split = "half";
  return out;
}

// Intraday bars for a symbol: the store when present (and allowed), else Yahoo.
async function loadIntraday(yahoo: YahooHistoricalBars, symbol: string, now: number, args: Args): Promise<readonly Bar[] | null> {
  if (args.source !== "yahoo") {
    const stored = loadStoredIntraday(symbol);
    if (stored) return stored;
    if (args.source === "store") return null;
  }
  return yahoo.fetch({ symbol, interval: "5m", startMs: now - args.lookbackDays * 86_400_000, endMs: now, includePrePost: true });
}

export interface GapGoTrade {
  readonly symbol: string;
  readonly date: string;
  readonly direction: "LONG" | "SHORT";
  readonly gapPct: number;
  readonly above52w: boolean;
  readonly entry: number;
  readonly entryTime: string;
  readonly stop: number;
  readonly atr: number;
  readonly exits: readonly { readonly price: number; readonly fraction: number; readonly reason: string; readonly time: string }[];
  readonly returnPct: number;          // net of slippage, weighted across the two halves
  readonly rMultiple: number;          // returnPct relative to initial stop distance
  readonly pnlPer1000: number;
}

const OPEN_MIN = 9 * 60 + 30;
const LAST_SIGNAL_MIN = 11 * 60 + 30;
const TIME_EXIT_MIN = 15 * 60 + 45;
const OPEN_CHASE_PCT = 1.5;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  setLogLevel("error");
  const uni = loadUniverse();
  if (!uni) throw new Error("No universe file; run npm run universe:build first");
  const names = uni.entries.slice(0, args.maxNames).map((e) => e.symbol);
  const yahoo = new YahooHistoricalBars();
  const now = Date.now();
  const slip = args.slippageBps / 10_000;
  if (args.grid) { await runGrid(names, yahoo, now, args); return; }

  const trades: GapGoTrade[] = [];
  let sessionsSeen = new Set<string>();
  let candidates = 0;
  let skippedChase = 0;
  let noSignal = 0;
  let failed = 0;
  const startedAt = Date.now();

  for (let i = 0; i < names.length; i++) {
    const symbol = names[i];
    try {
      const intraday = await loadIntraday(yahoo, symbol, now, args);
      if (!intraday) continue;
      const daily = await yahoo.fetch({ symbol, interval: "1d", startMs: now - 600 * 86_400_000, endMs: now, includePrePost: false });
      const byDate = groupByDate(intraday);
      const dailyByDate = daily.map((b) => ({ date: etParts(b.timestamp).date, b }));
      const todayDate = etParts(now).date;
      for (const [date, bars] of byDate) {
        if (date >= todayDate) continue;                    // never the partial current session
        sessionsSeen.add(date);
        // Point-in-time daily stats strictly before this session.
        const prior = dailyByDate.filter((d) => d.date < date).map((d) => d.b);
        if (prior.length < 30) continue;
        const priorClose = prior[prior.length - 1].close;
        const w20 = prior.slice(-20);
        const high20 = Math.max(...w20.map((b) => b.high));
        const low20 = Math.min(...w20.map((b) => b.low));
        const high252 = Math.max(...prior.slice(-252).map((b) => b.high));
        const atr = averageTrueRange(prior, 14);

        const pre = bars.filter((b) => minutesEt(b.timestamp) < OPEN_MIN);
        const rth = bars.filter((b) => minutesEt(b.timestamp) >= OPEN_MIN && minutesEt(b.timestamp) < 16 * 60);
        if (pre.length === 0 || rth.length < 10) continue;
        const pmLast = pre[pre.length - 1].close;
        const gapPct = (pmLast / priorClose - 1) * 100;
        if (Math.abs(gapPct) < args.minGapPct) continue;
        const direction: "LONG" | "SHORT" | null = gapPct > 0 && pmLast > high20 ? "LONG" : gapPct < 0 && pmLast < low20 ? "SHORT" : null;
        if (!direction) continue;
        candidates++;
        const pmHigh = Math.max(...pre.map((b) => b.high));
        const pmLow = Math.min(...pre.map((b) => b.low));
        const open = rth[0].open;
        if (direction === "LONG" && open > pmHigh * (1 + OPEN_CHASE_PCT / 100)) { skippedChase++; continue; }
        if (direction === "SHORT" && open < pmLow * (1 - OPEN_CHASE_PCT / 100)) { skippedChase++; continue; }

        const trade = simulate(symbol, date, direction, gapPct, pmLast > high252, rth, pmHigh, pmLow, atr, slip);
        if (!trade) { noSignal++; continue; }
        trades.push(trade);
      }
    } catch (err) {
      failed++;
      log.debug("symbol failed", { symbol, error: err instanceof Error ? err.message : String(err) });
    }
    if ((i + 1) % 250 === 0) process.stdout.write(`  ${i + 1}/${names.length} names, ${trades.length} trades so far, ${((Date.now() - startedAt) / 60_000).toFixed(1)} min\n`);
  }

  if (args.out) {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, trades.map((t) => JSON.stringify(t)).join("\n") + (trades.length ? "\n" : ""));
  }

  const sessions = [...sessionsSeen].sort();
  process.stdout.write(`\n===== Gap-and-go diagnostic =====\n`);
  process.stdout.write(`Names ${names.length}, sessions ${sessions.length} (${sessions[0]} to ${sessions[sessions.length - 1]}), slippage ${args.slippageBps} bps/side, min gap ${args.minGapPct}%\n`);
  process.stdout.write(`Candidates ${candidates}: entered ${trades.length}, skipped for opening beyond +/-${OPEN_CHASE_PCT}% ${skippedChase}, no confirming close by 11:30 ${noSignal}, failed symbols ${failed}\n`);
  report("ALL SIGNALS", trades);
  report("LONG", trades.filter((t) => t.direction === "LONG"));
  report("SHORT", trades.filter((t) => t.direction === "SHORT"));
  report("gap 3-5%", trades.filter((t) => Math.abs(t.gapPct) < 5));
  report("gap 5-10%", trades.filter((t) => Math.abs(t.gapPct) >= 5 && Math.abs(t.gapPct) < 10));
  report("gap 10%+", trades.filter((t) => Math.abs(t.gapPct) >= 10));
  report("LONG above 52w high", trades.filter((t) => t.direction === "LONG" && t.above52w));
  report("LONG not above 52w high", trades.filter((t) => t.direction === "LONG" && !t.above52w));
  const mid = sessions[Math.floor(sessions.length / 2)];
  report(`first half (< ${mid})`, trades.filter((t) => t.date < mid));
  report(`second half (>= ${mid})`, trades.filter((t) => t.date >= mid));
  // Top 3 per session by absolute gap, mimicking taking only the strongest names.
  const perDay = new Map<string, GapGoTrade[]>();
  for (const t of trades) perDay.set(t.date, [...(perDay.get(t.date) ?? []), t]);
  const top3 = [...perDay.values()].flatMap((list) => [...list].sort((a, b) => Math.abs(b.gapPct) - Math.abs(a.gapPct)).slice(0, 3));
  report("TOP 3 PER SESSION by gap", top3);
  // Best-session removal.
  const bySession = new Map<string, number>();
  for (const t of trades) bySession.set(t.date, (bySession.get(t.date) ?? 0) + t.pnlPer1000);
  const best = [...bySession.entries()].sort((a, b) => b[1] - a[1])[0];
  const net = trades.reduce((s, t) => s + t.pnlPer1000, 0);
  if (best) process.stdout.write(`\nBest session ${best[0]}: ${fmt(best[1])} of ${fmt(net)} total; net without it ${fmt(net - best[1])}\n`);
  const exitCounts: Record<string, number> = {};
  for (const t of trades) for (const e of t.exits) exitCounts[e.reason] = (exitCounts[e.reason] ?? 0) + e.fraction;
  process.stdout.write(`Exit mix (position-weighted): ${Object.entries(exitCounts).map(([k, v]) => `${k} ${(v / Math.max(1, trades.length) * 100).toFixed(0)}%`).join(", ")}\n`);
}

function simulate(symbol: string, date: string, direction: "LONG" | "SHORT", gapPct: number, above52w: boolean, rth: readonly Bar[], pmHigh: number, pmLow: number, atr: number, slip: number): GapGoTrade | null {
  const first = rth[0];
  const stop = direction === "LONG" ? first.low : first.high;
  let entryIdx = -1;
  for (let i = 0; i < rth.length - 1; i++) {
    const m = minutesEt(rth[i].timestamp);
    if (m > LAST_SIGNAL_MIN) break;
    const confirmed = direction === "LONG" ? rth[i].close > pmHigh : rth[i].close < pmLow;
    if (confirmed) { entryIdx = i + 1; break; }
  }
  if (entryIdx < 0 || entryIdx >= rth.length) return null;
  const sign = direction === "LONG" ? 1 : -1;
  const entry = rth[entryIdx].open * (1 + sign * slip);
  // A stop above the entry (long) is a broken setup: the 09:30 candle low is
  // the stop reference; if the confirming candle already closed below it the
  // rule would never have fired. Guard anyway.
  if ((direction === "LONG" && stop >= entry) || (direction === "SHORT" && stop <= entry)) return null;
  const t1 = entry + sign * atr;
  const t2 = entry + sign * 1.5 * atr;
  const exits: { price: number; fraction: number; reason: string; time: string }[] = [];
  let remaining = 1;
  let hit1 = false;
  for (let i = entryIdx; i < rth.length && remaining > 0; i++) {
    const b = rth[i];
    const m = minutesEt(b.timestamp);
    const stopHit = direction === "LONG" ? b.close < stop : b.close > stop;
    if (stopHit) { exits.push({ price: b.close * (1 - sign * slip), fraction: remaining, reason: "stop", time: hhmm(b.timestamp) }); remaining = 0; break; }
    const reach1 = direction === "LONG" ? b.high >= t1 : b.low <= t1;
    const reach2 = direction === "LONG" ? b.high >= t2 : b.low <= t2;
    if (!hit1 && reach1) { exits.push({ price: t1 * (1 - sign * slip), fraction: 0.5, reason: "target1", time: hhmm(b.timestamp) }); remaining -= 0.5; hit1 = true; }
    if (hit1 && remaining > 0 && reach2) { exits.push({ price: t2 * (1 - sign * slip), fraction: remaining, reason: "target2", time: hhmm(b.timestamp) }); remaining = 0; break; }
    if (m >= TIME_EXIT_MIN) { exits.push({ price: b.close * (1 - sign * slip), fraction: remaining, reason: "time", time: hhmm(b.timestamp) }); remaining = 0; break; }
  }
  if (remaining > 0) { const last = rth[rth.length - 1]; exits.push({ price: last.close * (1 - sign * slip), fraction: remaining, reason: "eod", time: hhmm(last.timestamp) }); }
  const returnPct = exits.reduce((s, e) => s + e.fraction * sign * (e.price / entry - 1), 0) * 100;
  const stopDistPct = Math.abs(entry - stop) / entry * 100;
  return { symbol, date, direction, gapPct, above52w, entry, entryTime: hhmm(rth[entryIdx].timestamp), stop, atr, exits, returnPct, rMultiple: stopDistPct > 0 ? returnPct / stopDistPct : 0, pnlPer1000: returnPct * 10 };
}

function report(label: string, ts: readonly GapGoTrade[]): void {
  if (ts.length === 0) { process.stdout.write(`\n${label}: none\n`); return; }
  const wins = ts.filter((t) => t.returnPct > 0), losses = ts.filter((t) => t.returnPct <= 0);
  const avg = (a: readonly GapGoTrade[]): number => a.length ? a.reduce((s, t) => s + t.returnPct, 0) / a.length : 0;
  const gw = wins.reduce((s, t) => s + t.returnPct, 0), gl = -losses.reduce((s, t) => s + t.returnPct, 0);
  const exp = avg(ts);
  const net = ts.reduce((s, t) => s + t.pnlPer1000, 0);
  const avgR = ts.reduce((s, t) => s + t.rMultiple, 0) / ts.length;
  process.stdout.write(`\n${label}: n=${ts.length}  win ${(wins.length / ts.length * 100).toFixed(1)}%  avg win ${avg(wins).toFixed(2)}%  avg loss ${avg(losses).toFixed(2)}%  expectancy ${exp >= 0 ? "+" : ""}${exp.toFixed(2)}%/trade  PF ${gl > 0 ? (gw / gl).toFixed(2) : "inf"}  avg R ${avgR.toFixed(2)}  net at $1k/trade ${fmt(net)}\n`);
}

function groupByDate(bars: readonly Bar[]): Map<string, Bar[]> {
  const m = new Map<string, Bar[]>();
  for (const b of bars) { const d = etParts(b.timestamp).date; m.set(d, [...(m.get(d) ?? []), b]); }
  for (const list of m.values()) list.sort((a, b) => a.timestamp - b.timestamp);
  return m;
}

function averageTrueRange(bars: readonly Bar[], n: number): number {
  const tr: number[] = [];
  for (let i = bars.length - n; i < bars.length; i++) {
    const pc = bars[i - 1].close;
    tr.push(Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - pc), Math.abs(bars[i].low - pc)));
  }
  return tr.reduce((s, x) => s + x, 0) / tr.length;
}

function minutesEt(ts: number): number { const p = etParts(ts); return p.hour * 60 + p.minute; }
function hhmm(ts: number): string { const p = etParts(ts); return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`; }
function fmt(n: number): string { return `${n >= 0 ? "+" : "-"}$${Math.abs(n).toFixed(0)}`; }

// ----- H-GAP-WR grid (docs/gap-and-go-registration-2026-09-21.md) -----

const SELECTION_END_DATE = "2026-08-20"; // date split used by the recorded 39-session grid

interface Ctx {
  readonly symbol: string;
  readonly date: string;
  readonly direction: "LONG" | "SHORT";
  readonly gapPct: number;
  readonly beyond20: boolean;
  readonly beyond252: boolean;
  readonly rth: readonly Bar[];
  readonly pmHigh: number;
  readonly pmLow: number;
  readonly atr: number;
  readonly sectorAgrees: boolean;
  readonly spyAbove50: boolean;
}

type ExitRule = "atr" | "pct1" | "pct2" | "t1030" | "t1200";
type StopRef = "0930" | "pm";
type Cutoff = "0940" | "1130";
interface Variant { minGap: number; structure: "20d" | "252d"; direction: "long" | "both"; exit: ExitRule; stop: StopRef; cutoff: Cutoff; sector: boolean }

async function runGrid(names: readonly string[], yahoo: YahooHistoricalBars, now: number, args: Args): Promise<void> {
  const slip = args.slippageBps / 10_000;
  const startedAt = Date.now();

  // Sector ETF 09:30-candle direction per date: close of the first RTH bar vs prior session close.
  const etfGreen = new Map<string, Map<string, boolean>>();
  for (const etf of SECTOR_ETFS) {
    const bars = (await loadIntraday(yahoo, etf, now, args)) ?? [];
    const byDate = groupByDate(bars);
    const dates = [...byDate.keys()].sort();
    const m = new Map<string, boolean>();
    for (let i = 1; i < dates.length; i++) {
      const prev = byDate.get(dates[i - 1])!.filter((b) => minutesEt(b.timestamp) >= OPEN_MIN && minutesEt(b.timestamp) < 16 * 60);
      const cur = byDate.get(dates[i])!.filter((b) => minutesEt(b.timestamp) >= OPEN_MIN);
      if (prev.length === 0 || cur.length === 0) continue;
      m.set(dates[i], cur[0].close > prev[prev.length - 1].close);
    }
    etfGreen.set(etf, m);
  }

  // SPY above its 50-session average on the prior session (descriptive regime cut).
  const spyDaily = await yahoo.fetch({ symbol: "SPY", interval: "1d", startMs: now - 600 * 86_400_000, endMs: now, includePrePost: false });
  const spyAbove = new Map<string, boolean>();
  for (let i = 50; i < spyDaily.length; i++) {
    const sma = spyDaily.slice(i - 49, i + 1).reduce((s, b) => s + b.close, 0) / 50;
    spyAbove.set(etParts(spyDaily[i].timestamp).date, spyDaily[i].close > sma);
  }
  const regimeOnDate = (date: string): boolean => { const prior = [...spyAbove.keys()].filter((d) => d < date).sort(); return prior.length ? spyAbove.get(prior[prior.length - 1]) ?? false : false; };

  // One context per (symbol, session) meeting the loosest screen (3%, beyond 20-day).
  const ctxs: Ctx[] = [];
  let failed = 0;
  for (let i = 0; i < names.length; i++) {
    const symbol = names[i];
    try {
      const intraday = await loadIntraday(yahoo, symbol, now, args);
      if (!intraday) continue;
      const daily = await yahoo.fetch({ symbol, interval: "1d", startMs: now - 600 * 86_400_000, endMs: now, includePrePost: false });
      const byDate = groupByDate(intraday);
      const dailyByDate = daily.map((b) => ({ date: etParts(b.timestamp).date, b }));
      const todayDate = etParts(now).date;
      for (const [date, bars] of byDate) {
        if (date >= todayDate) continue;
        const prior = dailyByDate.filter((d) => d.date < date).map((d) => d.b);
        if (prior.length < 30) continue;
        const priorClose = prior[prior.length - 1].close;
        const w20 = prior.slice(-20), w252 = prior.slice(-252);
        const pre = bars.filter((b) => minutesEt(b.timestamp) < OPEN_MIN);
        const rth = bars.filter((b) => minutesEt(b.timestamp) >= OPEN_MIN && minutesEt(b.timestamp) < 16 * 60);
        if (pre.length === 0 || rth.length < 10) continue;
        const pmLast = pre[pre.length - 1].close;
        const gapPct = (pmLast / priorClose - 1) * 100;
        if (Math.abs(gapPct) < 3) continue;
        const direction: "LONG" | "SHORT" = gapPct > 0 ? "LONG" : "SHORT";
        const beyond20 = direction === "LONG" ? pmLast > Math.max(...w20.map((b) => b.high)) : pmLast < Math.min(...w20.map((b) => b.low));
        if (!beyond20) continue;
        const beyond252 = direction === "LONG" ? pmLast > Math.max(...w252.map((b) => b.high)) : pmLast < Math.min(...w252.map((b) => b.low));
        const pmHigh = Math.max(...pre.map((b) => b.high)), pmLow = Math.min(...pre.map((b) => b.low));
        const open = rth[0].open;
        if (direction === "LONG" && open > pmHigh * (1 + OPEN_CHASE_PCT / 100)) continue;
        if (direction === "SHORT" && open < pmLow * (1 - OPEN_CHASE_PCT / 100)) continue;
        const green = etfGreen.get(sectorFor(symbol))?.get(date);
        const sectorAgrees = green === undefined ? false : direction === "LONG" ? green : !green;
        ctxs.push({ symbol, date, direction, gapPct, beyond20, beyond252, rth, pmHigh, pmLow, atr: averageTrueRange(prior, 14), sectorAgrees, spyAbove50: regimeOnDate(date) });
      }
    } catch { failed++; }
    if ((i + 1) % 300 === 0) process.stdout.write(`  contexts: ${i + 1}/${names.length} names, ${ctxs.length} candidates, ${((Date.now() - startedAt) / 60_000).toFixed(1)} min\n`);
  }
  const sessions = [...new Set(ctxs.map((c) => c.date))].sort();
  const SELECTION_END = args.split === "half" ? sessions[Math.floor(sessions.length / 2) - 1] : SELECTION_END_DATE;
  process.stdout.write(`\n===== H-GAP-WR grid: ${ctxs.length} candidate contexts over ${sessions.length} sessions (${sessions[0]} to ${sessions[sessions.length - 1]}), ${failed} failed, slippage ${args.slippageBps} bps/side, source ${args.source} =====\nSelection: sessions <= ${SELECTION_END} (${args.split === "half" ? "median split" : "fixed date"}); validation after. Criterion: highest selection win rate with PF >= 1.30, expectancy > 0, n >= 60.\n`);

  const base: Variant = { minGap: 3, structure: "20d", direction: "both", exit: "atr", stop: "0930", cutoff: "1130", sector: false };
  const variants: Variant[] = [];
  for (const minGap of [3, 5, 10]) for (const structure of ["20d", "252d"] as const) for (const direction of ["long", "both"] as const)
    for (const exit of ["atr", "pct1", "pct2", "t1030", "t1200"] as const) for (const stop of ["0930", "pm"] as const) for (const cutoff of ["0940", "1130"] as const) for (const sector of [false, true])
      variants.push({ minGap, structure, direction, exit, stop, cutoff, sector });

  interface Res { v: Variant; key: string; sel: GStat; val: GStat; all: GStat }
  const evaluate = (v: Variant): Res => {
    const rets: { date: string; r: number }[] = [];
    for (const c of ctxs) {
      if (Math.abs(c.gapPct) < v.minGap) continue;
      if (v.structure === "252d" && !c.beyond252) continue;
      if (v.direction === "long" && c.direction === "SHORT") continue;
      if (v.sector && !c.sectorAgrees) continue;
      const r = manageGrid(c, v, slip);
      if (r !== null) rets.push({ date: c.date, r });
    }
    return { v, key: variantKey(v), sel: gstat(rets.filter((x) => x.date <= SELECTION_END).map((x) => x.r)), val: gstat(rets.filter((x) => x.date > SELECTION_END).map((x) => x.r)), all: gstat(rets.map((x) => x.r)) };
  };
  const results = variants.map(evaluate);
  if (args.gridOut) {
    const rows = ["minGap,structure,direction,exit,stop,cutoff,sector,selN,selWin,selExp,selPF,valN,valWin,valExp,valPF,allN,allWin,allExp,allPF",
      ...results.map((r) => [r.v.minGap, r.v.structure, r.v.direction, r.v.exit, r.v.stop, r.v.cutoff, r.v.sector, r.sel.n, r.sel.win.toFixed(1), r.sel.exp.toFixed(2), r.sel.pf.toFixed(2), r.val.n, r.val.win.toFixed(1), r.val.exp.toFixed(2), r.val.pf.toFixed(2), r.all.n, r.all.win.toFixed(1), r.all.exp.toFixed(2), r.all.pf.toFixed(2)].join(","))];
    fs.mkdirSync(path.dirname(args.gridOut), { recursive: true });
    fs.writeFileSync(args.gridOut, rows.join("\n") + "\n");
  }
  const line = (r: Res): string => `${r.key.padEnd(62)} SEL n=${String(r.sel.n).padStart(4)} win ${r.sel.win.toFixed(1).padStart(5)}% exp ${gp(r.sel.exp)} PF ${r.sel.pf.toFixed(2)} | VAL n=${String(r.val.n).padStart(4)} win ${r.val.win.toFixed(1).padStart(5)}% exp ${gp(r.val.exp)} PF ${r.val.pf.toFixed(2)}`;

  process.stdout.write(`\nBase variant:\n  ${line(evaluate(base))}\n`);
  process.stdout.write(`\nOne lever at a time (from base):\n`);
  const levers: Partial<Variant>[] = [{ minGap: 5 }, { minGap: 10 }, { structure: "252d" }, { direction: "long" }, { exit: "pct1" }, { exit: "pct2" }, { exit: "t1030" }, { exit: "t1200" }, { stop: "pm" }, { cutoff: "0940" }, { sector: true }];
  for (const l of levers) process.stdout.write(`  ${line(evaluate({ ...base, ...l }))}\n`);

  // Descriptive regime cut on two fixed variants (not a selection lever).
  const regimeLine = (label: string, v: Variant, above: boolean): string => {
    const rets: { date: string; r: number }[] = [];
    for (const c of ctxs) {
      if (c.spyAbove50 !== above) continue;
      if (Math.abs(c.gapPct) < v.minGap) continue;
      if (v.structure === "252d" && !c.beyond252) continue;
      if (v.direction === "long" && c.direction === "SHORT") continue;
      const r = manageGrid(c, v, slip);
      if (r !== null) rets.push({ date: c.date, r });
    }
    const a = gstat(rets.map((x) => x.r)), se = gstat(rets.filter((x) => x.date <= SELECTION_END).map((x) => x.r)), va = gstat(rets.filter((x) => x.date > SELECTION_END).map((x) => x.r));
    return `  ${label.padEnd(44)} ALL n=${String(a.n).padStart(4)} win ${a.win.toFixed(1)}% exp ${gp(a.exp)} PF ${a.pf.toFixed(2)} | SEL n=${se.n} win ${se.win.toFixed(1)}% PF ${se.pf.toFixed(2)} | VAL n=${va.n} win ${va.win.toFixed(1)}% PF ${va.pf.toFixed(2)}`;
  };
  process.stdout.write(`\nRegime cut (SPY vs 50-day on the prior session; descriptive):\n`);
  for (const [label, v] of [["base, SPY above 50d", base], ["base, SPY below 50d", base], ["gap>=10 both, SPY above 50d", { ...base, minGap: 10 }], ["gap>=10 both, SPY below 50d", { ...base, minGap: 10 }], ["gap>=10 long, SPY above 50d", { ...base, minGap: 10, direction: "long" as const }], ["gap>=10 long, SPY below 50d", { ...base, minGap: 10, direction: "long" as const }]] as const) {
    process.stdout.write(regimeLine(label, v, label.includes("above")) + "\n");
  }

  const eligible = results.filter((r) => r.sel.n >= 60 && r.sel.pf >= 1.3 && r.sel.exp > 0).sort((a, b) => b.sel.win - a.sel.win);
  process.stdout.write(`\nTop 12 eligible by selection win rate (${eligible.length} of ${results.length} variants eligible):\n`);
  for (const r of eligible.slice(0, 12)) process.stdout.write(`  ${line(r)}\n`);
  process.stdout.write(`\nTop 8 by VALIDATION win rate among eligible (for the record; not the selection rule):\n`);
  for (const r of [...eligible].sort((a, b) => b.val.win - a.val.win).slice(0, 8)) process.stdout.write(`  ${line(r)}\n`);
  if (eligible[0]) process.stdout.write(`\nCHOSEN: ${eligible[0].key}\n  validation: n=${eligible[0].val.n} win ${eligible[0].val.win.toFixed(1)}% exp ${gp(eligible[0].val.exp)} PF ${eligible[0].val.pf.toFixed(2)}\n`);
  else process.stdout.write(`\nCHOSEN: none met the constraints\n`);
}

function manageGrid(c: Ctx, v: Variant, slip: number): number | null {
  const rth = c.rth;
  const long = c.direction === "LONG";
  const sign = long ? 1 : -1;
  const cutoffMin = v.cutoff === "0940" ? 9 * 60 + 35 : LAST_SIGNAL_MIN;
  let entryIdx = -1;
  for (let i = 0; i < rth.length - 1; i++) {
    if (minutesEt(rth[i].timestamp) > cutoffMin) break;
    if (long ? rth[i].close > c.pmHigh : rth[i].close < c.pmLow) { entryIdx = i + 1; break; }
  }
  if (entryIdx < 0) return null;
  const entry = rth[entryIdx].open * (1 + sign * slip);
  const stop = v.stop === "0930" ? (long ? rth[0].low : rth[0].high) : (long ? c.pmLow : c.pmHigh);
  if (long ? stop >= entry : stop <= entry) return null;
  const exitPx = (p: number): number => p * (1 - sign * slip);
  const ret = (p: number): number => sign * (exitPx(p) / entry - 1) * 100;
  const timeLimit = v.exit === "t1030" ? 10 * 60 + 30 : v.exit === "t1200" ? 12 * 60 : TIME_EXIT_MIN;
  const target = v.exit === "pct1" ? entry * (1 + sign * 0.01) : v.exit === "pct2" ? entry * (1 + sign * 0.02) : null;
  let remaining = 1, acc = 0, hit1 = false;
  const t1 = entry + sign * c.atr, t2 = entry + sign * 1.5 * c.atr;
  for (let i = entryIdx; i < rth.length; i++) {
    const b = rth[i];
    const m = minutesEt(b.timestamp);
    if (long ? b.close < stop : b.close > stop) return acc + remaining * ret(b.close);
    if (v.exit === "atr") {
      if (!hit1 && (long ? b.high >= t1 : b.low <= t1)) { acc += 0.5 * ret(t1); remaining -= 0.5; hit1 = true; }
      if (hit1 && remaining > 0 && (long ? b.high >= t2 : b.low <= t2)) return acc + remaining * ret(t2);
    } else if (target !== null && (long ? b.high >= target : b.low <= target)) {
      return ret(target);
    }
    if (m >= timeLimit) return acc + remaining * ret(b.close);
  }
  return acc + remaining * ret(rth[rth.length - 1].close);
}

interface GStat { n: number; win: number; exp: number; pf: number }
function gstat(rs: readonly number[]): GStat {
  if (rs.length === 0) return { n: 0, win: 0, exp: 0, pf: 0 };
  const w = rs.filter((r) => r > 0), l = rs.filter((r) => r <= 0);
  const gw = w.reduce((a, b) => a + b, 0), gl = -l.reduce((a, b) => a + b, 0);
  return { n: rs.length, win: w.length / rs.length * 100, exp: rs.reduce((a, b) => a + b, 0) / rs.length, pf: gl > 0 ? gw / gl : 99 };
}
function variantKey(v: Variant): string { return `gap>=${v.minGap} ${v.structure} ${v.direction} exit=${v.exit} stop=${v.stop} cutoff=${v.cutoff} sector=${v.sector ? "on" : "off"}`; }
function gp(x: number): string { return `${x >= 0 ? "+" : ""}${x.toFixed(2)}%`; }

main().catch((err) => {
  process.stderr.write(`FATAL: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
