// Catalyst gap-and-go diagnostic over the liquid optionable universe.
//
//   npm run backtest:gapgo                       # top 1,500 names, 59 days
//   npm run backtest:gapgo -- --max-names 300 --min-gap 3 --slippage-bps 10
//   npm run backtest:gapgo -- --out data/bt/gapgo.jsonl
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
import type { Bar } from "../core/types.js";

const log = createLogger("gap-and-go");

interface Args {
  maxNames: number;
  minGapPct: number;
  slippageBps: number;
  out: string;
  lookbackDays: number;
}

function parseArgs(argv: readonly string[]): Args {
  const out: Args = { maxNames: 1500, minGapPct: 3, slippageBps: 5, out: "", lookbackDays: 59 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--max-names") out.maxNames = Number(argv[++i]);
    else if (a === "--min-gap") out.minGapPct = Number(argv[++i]);
    else if (a === "--slippage-bps") out.slippageBps = Number(argv[++i]);
    else if (a === "--out") out.out = argv[++i] ?? "";
    else if (a === "--lookback") out.lookbackDays = Number(argv[++i]);
  }
  return out;
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
      const intraday = await yahoo.fetch({ symbol, interval: "5m", startMs: now - args.lookbackDays * 86_400_000, endMs: now, includePrePost: true });
      const daily = await yahoo.fetch({ symbol, interval: "1d", startMs: now - 400 * 86_400_000, endMs: now, includePrePost: false });
      const byDate = groupByDate(intraday);
      const dailyByDate = daily.map((b) => ({ date: etParts(b.timestamp).date, b }));
      for (const [date, bars] of byDate) {
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

main().catch((err) => {
  process.stderr.write(`FATAL: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
