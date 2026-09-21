// Intraday mean-reversion pilot (docs/intraday-mr-registration-2026-09-21.md).
//
//   npm run backtest:mr                        # H-FILL and H-DIP, all variants
//   npm run backtest:mr -- --max-names 500 --slippage-bps 10 --out data/bt/mr.jsonl
//
// Long only. H-FILL: faded 1-5% gap-down in a stock above its 200-day whose
// 09:30 candle closed green; entry 09:35 open; target half fill (variant:
// full fill); stop on a close below the 09:30 low (variant: open - 0.5 ATR);
// time exit 12:00 (variant: 15:45). H-DIP: no gap, stock above its 20- and
// 200-day, trades 0.5 ATR below the open by 10:30 then a 5-minute close
// above the prior candle's high; entry next open; target the session open
// (variant: open + 0.25 ATR); stop on a close below the signal-time low;
// time exit 12:00 (variant: 15:45). Point-in-time daily stats. Split is
// by session count (first half selection) so it works on any history length.
// Reads data/history/5m/{SYM}.json when present (npm run history:pull),
// otherwise Yahoo's 59-day window.

import * as fs from "node:fs";
import * as path from "node:path";
import { setLogLevel } from "../core/logger.js";
import { etParts } from "../utils/time.js";
import { YahooHistoricalBars } from "../data/yahoo-historical.js";
import { loadStoredIntraday } from "../data/bar-store.js";
import { loadUniverse } from "../research/universe.js";
import type { Bar } from "../core/types.js";

interface Args { maxNames: number; slippageBps: number; out: string; lookbackDays: number; source: "auto" | "yahoo" | "store" }

function parseArgs(argv: readonly string[]): Args {
  const out: Args = { maxNames: 1500, slippageBps: 10, out: "", lookbackDays: 59, source: "auto" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--max-names") out.maxNames = Number(argv[++i]);
    else if (a === "--slippage-bps") out.slippageBps = Number(argv[++i]);
    else if (a === "--out") out.out = argv[++i] ?? "";
    else if (a === "--lookback") out.lookbackDays = Number(argv[++i]);
    else if (a === "--source") { const v = (argv[++i] ?? "").toLowerCase(); if (v === "yahoo" || v === "store" || v === "auto") out.source = v; }
  }
  return out;
}

const OPEN_MIN = 9 * 60 + 30;
const NOON = 12 * 60;
const LATE = 15 * 60 + 45;

interface Trade {
  readonly strategy: "FILL" | "DIP";
  readonly variant: string;
  readonly symbol: string;
  readonly date: string;
  readonly rank: number;             // gap size (FILL) or dip depth in ATR (DIP), larger first
  readonly entry: number;
  readonly exit: number;
  readonly reason: "target" | "stop" | "time";
  readonly returnPct: number;
}

interface DayCtx {
  readonly symbol: string;
  readonly date: string;
  readonly rth: readonly Bar[];
  readonly priorClose: number;
  readonly sma20: number;
  readonly sma200: number;
  readonly atr: number;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  setLogLevel("error");
  const uni = loadUniverse();
  if (!uni) throw new Error("No universe file; run npm run universe:build first");
  const names = uni.entries.slice(0, args.maxNames).map((e) => e.symbol);
  const yahoo = new YahooHistoricalBars();
  const now = Date.now();
  const today = etParts(now).date;
  const slip = args.slippageBps / 10_000;
  const startedAt = Date.now();

  const ctxs: DayCtx[] = [];
  let stored = 0, fetched = 0, failed = 0;
  for (let i = 0; i < names.length; i++) {
    const symbol = names[i];
    try {
      let intraday: readonly Bar[] | null = args.source === "yahoo" ? null : loadStoredIntraday(symbol);
      if (intraday) stored++;
      else if (args.source === "store") continue;
      else { intraday = await yahoo.fetch({ symbol, interval: "5m", startMs: now - args.lookbackDays * 86_400_000, endMs: now, includePrePost: true }); fetched++; }
      const daily = await yahoo.fetch({ symbol, interval: "1d", startMs: now - 400 * 86_400_000, endMs: now, includePrePost: false });
      const dailyByDate = daily.map((b) => ({ date: etParts(b.timestamp).date, b }));
      for (const [date, bars] of groupByDate(intraday)) {
        if (date >= today) continue;                         // never the partial current session
        const prior = dailyByDate.filter((d) => d.date < date).map((d) => d.b);
        if (prior.length < 205) continue;
        const rth = bars.filter((b) => { const m = minutesEt(b.timestamp); return m >= OPEN_MIN && m < 16 * 60; });
        if (rth.length < 30) continue;
        const c = prior.map((b) => b.close);
        ctxs.push({ symbol, date, rth, priorClose: c[c.length - 1], sma20: mean(c.slice(-20)), sma200: mean(c.slice(-200)), atr: atr14(prior) });
      }
    } catch { failed++; }
    if ((i + 1) % 300 === 0) process.stdout.write(`  ${i + 1}/${names.length} names, ${ctxs.length} sessions x names, ${((Date.now() - startedAt) / 60_000).toFixed(1)} min\n`);
  }
  const sessions = [...new Set(ctxs.map((c) => c.date))].sort();
  const splitIdx = Math.floor(sessions.length / 2);
  const selEnd = sessions[splitIdx - 1];

  const variants: { strategy: "FILL" | "DIP"; name: string; run: (c: DayCtx) => Trade | null }[] = [
    { strategy: "FILL", name: "half-fill, stop 0930 low, out 12:00", run: (c) => fill(c, "half", "0930", NOON, slip) },
    { strategy: "FILL", name: "full-fill, stop 0930 low, out 12:00", run: (c) => fill(c, "full", "0930", NOON, slip) },
    { strategy: "FILL", name: "half-fill, stop 0930 low, out 15:45", run: (c) => fill(c, "half", "0930", LATE, slip) },
    { strategy: "FILL", name: "half-fill, stop open-0.5ATR, out 12:00", run: (c) => fill(c, "half", "atr", NOON, slip) },
    { strategy: "DIP", name: "target open, stop signal low, out 12:00", run: (c) => dip(c, "open", NOON, slip) },
    { strategy: "DIP", name: "target open, stop signal low, out 15:45", run: (c) => dip(c, "open", LATE, slip) },
    { strategy: "DIP", name: "target open+0.25ATR, stop signal low, out 12:00", run: (c) => dip(c, "plus", NOON, slip) },
  ];

  const all: Trade[] = [];
  process.stdout.write(`\n===== Intraday mean-reversion pilot: ${ctxs.length} name-sessions over ${sessions.length} sessions (${sessions[0]} to ${sessions[sessions.length - 1]}); stored ${stored}, yahoo ${fetched}, failed ${failed}; slippage ${args.slippageBps} bps/side =====\nSelection: first ${splitIdx} sessions (through ${selEnd}); validation: the rest.\n`);
  for (const v of variants) {
    const trades: Trade[] = [];
    for (const c of ctxs) { const t = v.run(c); if (t) trades.push({ ...t, variant: v.name }); }
    all.push(...trades);
    const sel = trades.filter((t) => t.date <= selEnd), val = trades.filter((t) => t.date > selEnd);
    process.stdout.write(`\n## H-${v.strategy}: ${v.name}\n`);
    line("  all", trades, sessions.length); line("  selection", sel, splitIdx); line("  validation", val, sessions.length - splitIdx);
    const book = topPerDay(trades, 10);
    line("  10-slot book (largest dips)", book, sessions.length);
    line("     validation", book.filter((t) => t.date > selEnd), sessions.length - splitIdx);
    const ex: Record<string, number> = {}; for (const t of trades) ex[t.reason] = (ex[t.reason] ?? 0) + 1;
    process.stdout.write(`  exit mix: ${Object.entries(ex).map(([k, n]) => `${k} ${(n / Math.max(1, trades.length) * 100).toFixed(0)}%`).join(", ")}\n`);
  }
  if (args.out) { fs.mkdirSync(path.dirname(args.out), { recursive: true }); fs.writeFileSync(args.out, all.map((t) => JSON.stringify(t)).join("\n") + "\n"); }
}

function fill(c: DayCtx, target: "half" | "full", stopRef: "0930" | "atr", timeMin: number, slip: number): Trade | null {
  const first = c.rth[0];
  const gap = (first.open / c.priorClose - 1) * 100;
  if (!(gap <= -1 && gap >= -5)) return null;
  if (!(c.priorClose > c.sma200)) return null;
  if (!(first.close > first.open)) return null;
  if (c.rth.length < 3) return null;
  const entry = c.rth[1].open * (1 + slip);
  const tgt = target === "half" ? (first.open + c.priorClose) / 2 : c.priorClose;
  const stop = stopRef === "0930" ? first.low : first.open - 0.5 * c.atr;
  if (tgt <= entry || stop >= entry) return null;
  return manage(c, "FILL", -gap, 1, entry, tgt, stop, timeMin, slip);
}

function dip(c: DayCtx, target: "open" | "plus", timeMin: number, slip: number): Trade | null {
  const first = c.rth[0];
  const gap = Math.abs(first.open / c.priorClose - 1) * 100;
  if (gap >= 1) return null;
  if (!(c.priorClose > c.sma20 && c.priorClose > c.sma200)) return null;
  let low = first.low, dipped = false;
  for (let i = 1; i < c.rth.length - 1; i++) {
    const b = c.rth[i];
    if (minutesEt(b.timestamp) > 10 * 60 + 30) break;
    if (b.low < low) low = b.low;
    if (!dipped && low <= first.open - 0.5 * c.atr) dipped = true;
    if (dipped && b.close > c.rth[i - 1].high) {
      const entry = c.rth[i + 1].open * (1 + slip);
      const tgt = target === "open" ? first.open : first.open + 0.25 * c.atr;
      if (tgt <= entry || low >= entry) return null;
      return manage(c, "DIP", (first.open - low) / c.atr, i + 1, entry, tgt, low, timeMin, slip);
    }
  }
  return null;
}

function manage(c: DayCtx, strategy: "FILL" | "DIP", rank: number, entryIdx: number, entry: number, target: number, stop: number, timeMin: number, slip: number): Trade {
  const ex = (p: number): number => p * (1 - slip);
  const done = (exit: number, reason: Trade["reason"]): Trade => ({ strategy, variant: "", symbol: c.symbol, date: c.date, rank, entry, exit, reason, returnPct: (exit / entry - 1) * 100 });
  for (let i = entryIdx; i < c.rth.length; i++) {
    const b = c.rth[i];
    if (b.close < stop) return done(ex(b.close), "stop");
    if (b.high >= target) return done(ex(target), "target");
    if (minutesEt(b.timestamp) >= timeMin) return done(ex(b.close), "time");
  }
  return done(ex(c.rth[c.rth.length - 1].close), "time");
}

function topPerDay(ts: readonly Trade[], k: number): Trade[] {
  const byDay = new Map<string, Trade[]>();
  for (const t of ts) byDay.set(t.date, [...(byDay.get(t.date) ?? []), t]);
  return [...byDay.values()].flatMap((l) => [...l].sort((a, b) => b.rank - a.rank).slice(0, k));
}

function line(label: string, ts: readonly Trade[], sessions: number): void {
  if (ts.length === 0) { process.stdout.write(`${label.padEnd(30)} none\n`); return; }
  const w = ts.filter((t) => t.returnPct > 0), l = ts.filter((t) => t.returnPct <= 0);
  const avg = (a: readonly Trade[]): number => (a.length ? a.reduce((s, t) => s + t.returnPct, 0) / a.length : 0);
  const gw = w.reduce((s, t) => s + t.returnPct, 0), gl = -l.reduce((s, t) => s + t.returnPct, 0);
  process.stdout.write(`${label.padEnd(30)} n=${String(ts.length).padStart(5)} (${(ts.length / Math.max(1, sessions)).toFixed(1)}/day)  win ${(w.length / ts.length * 100).toFixed(1).padStart(5)}%  avg win ${avg(w).toFixed(2)}%  avg loss ${avg(l).toFixed(2)}%  exp ${avg(ts) >= 0 ? "+" : ""}${avg(ts).toFixed(2)}%  PF ${(gl > 0 ? gw / gl : 99).toFixed(2)}\n`);
}

function groupByDate(bars: readonly Bar[]): Map<string, Bar[]> {
  const m = new Map<string, Bar[]>();
  for (const b of bars) { const d = etParts(b.timestamp).date; m.set(d, [...(m.get(d) ?? []), b]); }
  for (const l of m.values()) l.sort((a, b) => a.timestamp - b.timestamp);
  return m;
}
function atr14(bars: readonly Bar[]): number {
  const tr: number[] = [];
  for (let i = bars.length - 14; i < bars.length; i++) { const pc = bars[i - 1].close; tr.push(Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - pc), Math.abs(bars[i].low - pc))); }
  return mean(tr);
}
function mean(a: readonly number[]): number { return a.reduce((s, x) => s + x, 0) / (a.length || 1); }
function minutesEt(ts: number): number { const p = etParts(ts); return p.hour * 60 + p.minute; }

main().catch((err) => { process.stderr.write(`FATAL: ${err instanceof Error ? err.message : String(err)}\n`); process.exit(1); });
