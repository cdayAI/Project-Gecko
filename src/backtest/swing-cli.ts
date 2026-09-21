// Multi-day swing diagnostics on daily bars across the liquid optionable
// universe: H-PULL (relative-strength pullback to the 20-day) and H-BOUNCE
// (three-down-day bounce above the 200-day), each with and without an
// SPY > 50-day regime gate. Frozen in docs/swing-registration-2026-09-21.md.
//
//   npm run backtest:swing                      # all universe names, ~3 years
//   npm run backtest:swing -- --max-names 300 --slippage-bps 20
//   npm run backtest:swing -- --out data/bt/swing.jsonl
//
// Point-in-time only: every statistic on the signal day uses bars through
// that day; entries at the next open; exits on closes.

import * as fs from "node:fs";
import * as path from "node:path";
import { createLogger, setLogLevel } from "../core/logger.js";
import { etParts } from "../utils/time.js";
import { YahooHistoricalBars } from "../data/yahoo-historical.js";
import { loadUniverse } from "../research/universe.js";
import type { Bar } from "../core/types.js";

const log = createLogger("swing");

interface Args { maxNames: number; slippageBps: number; out: string; lookbackDays: number }

function parseArgs(argv: readonly string[]): Args {
  const out: Args = { maxNames: 0, slippageBps: 10, out: "", lookbackDays: 1100 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--max-names") out.maxNames = Number(argv[++i]);
    else if (a === "--slippage-bps") out.slippageBps = Number(argv[++i]);
    else if (a === "--out") out.out = argv[++i] ?? "";
    else if (a === "--lookback") out.lookbackDays = Number(argv[++i]);
  }
  return out;
}

interface Series {
  readonly symbol: string;
  readonly dates: string[];
  readonly open: number[]; readonly high: number[]; readonly low: number[]; readonly close: number[]; readonly volume: number[];
  readonly sma5: number[]; readonly sma20: number[]; readonly sma50: number[]; readonly sma200: number[];
  readonly atr14: number[]; readonly ret60: number[]; readonly dollarVol20: number[];
}

export interface SwingTrade {
  readonly strategy: "PULL" | "BOUNCE";
  readonly symbol: string;
  readonly signalDate: string;
  readonly entryDate: string;
  readonly exitDate: string;
  readonly entry: number;
  readonly exit: number;
  readonly reason: "stop" | "target" | "time" | "eod";
  readonly held: number;
  readonly regimeOk: boolean;
  readonly rank: number;               // RS (PULL) or drop in ATRs (BOUNCE), for the capped portfolio
  readonly returnPct: number;          // net of slippage
  readonly pnlPer1000: number;
}

const MIN_DOLLAR_VOL = 30_000_000;

function buildSeries(symbol: string, bars: readonly Bar[]): Series | null {
  const b = [...bars].sort((x, y) => x.timestamp - y.timestamp);
  if (b.length < 260) return null;
  const n = b.length;
  const dates = b.map((x) => etParts(x.timestamp).date);
  const open = b.map((x) => x.open), high = b.map((x) => x.high), low = b.map((x) => x.low), close = b.map((x) => x.close), volume = b.map((x) => x.volume);
  const sma = (k: number): number[] => { const out = new Array<number>(n).fill(NaN); let s = 0; for (let i = 0; i < n; i++) { s += close[i]; if (i >= k) s -= close[i - k]; if (i >= k - 1) out[i] = s / k; } return out; };
  const atr14 = new Array<number>(n).fill(NaN);
  for (let i = 14; i < n; i++) { let s = 0; for (let j = i - 13; j <= i; j++) s += Math.max(high[j] - low[j], Math.abs(high[j] - close[j - 1]), Math.abs(low[j] - close[j - 1])); atr14[i] = s / 14; }
  const ret60 = close.map((c, i) => (i >= 60 ? c / close[i - 60] - 1 : NaN));
  const dollarVol20 = new Array<number>(n).fill(NaN);
  { let s = 0; for (let i = 0; i < n; i++) { const dv = close[i] * volume[i]; s += dv; if (i >= 20) s -= close[i - 20] * volume[i - 20]; if (i >= 19) dollarVol20[i] = s / 20; } }
  return { symbol, dates, open, high, low, close, volume, sma5: sma(5), sma20: sma(20), sma50: sma(50), sma200: sma(200), atr14, ret60, dollarVol20 };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  setLogLevel("error");
  const uni = loadUniverse();
  if (!uni) throw new Error("No universe file; run npm run universe:build first");
  const names = (args.maxNames > 0 ? uni.entries.slice(0, args.maxNames) : uni.entries).map((e) => e.symbol);
  const yahoo = new YahooHistoricalBars();
  const now = Date.now();
  const startMs = now - args.lookbackDays * 86_400_000;
  const slip = args.slippageBps / 10_000;
  const startedAt = Date.now();

  const spyBars = await yahoo.fetch({ symbol: "SPY", interval: "1d", startMs, endMs: now, includePrePost: false });
  const spy = buildSeries("SPY", spyBars);
  if (!spy) throw new Error("SPY history too short");
  const spyRegime = new Map<string, boolean>();
  spy.dates.forEach((d, i) => spyRegime.set(d, Number.isFinite(spy.sma50[i]) && spy.close[i] > spy.sma50[i]));

  const series: Series[] = [];
  let failed = 0;
  for (let i = 0; i < names.length; i++) {
    try {
      const bars = await yahoo.fetch({ symbol: names[i], interval: "1d", startMs, endMs: now, includePrePost: false });
      const s = buildSeries(names[i], bars);
      if (s) series.push(s);
    } catch { failed++; }
    if ((i + 1) % 250 === 0) process.stdout.write(`  loaded ${i + 1}/${names.length} (${((Date.now() - startedAt) / 60_000).toFixed(1)} min)\n`);
  }

  // Cross-sectional 60-day-return threshold (80th percentile) per date.
  const retByDate = new Map<string, number[]>();
  for (const s of series) s.dates.forEach((d, i) => { if (Number.isFinite(s.ret60[i]) && s.dollarVol20[i] >= MIN_DOLLAR_VOL) retByDate.set(d, [...(retByDate.get(d) ?? []), s.ret60[i]]); });
  const p80 = new Map<string, number>();
  for (const [d, arr] of retByDate) { const sorted = [...arr].sort((a, b) => a - b); p80.set(d, sorted[Math.floor(sorted.length * 0.8)] ?? Infinity); }

  const trades: SwingTrade[] = [];
  for (const s of series) {
    const n = s.dates.length;
    for (let t = 205; t < n - 1; t++) {
      if (!(s.dollarVol20[t] >= MIN_DOLLAR_VOL)) continue;
      const regimeOk = spyRegime.get(s.dates[t]) ?? false;
      // H-PULL
      if (s.close[t] > s.sma50[t] && s.sma50[t] > s.sma200[t] && s.ret60[t] >= (p80.get(s.dates[t]) ?? Infinity) && s.low[t] <= s.sma20[t]) {
        let heldAbove = true;
        for (let k = 1; k <= 5; k++) if (!(s.low[t - k] > s.sma20[t - k])) { heldAbove = false; break; }
        if (heldAbove) {
          const tr = manage(s, t, "PULL", regimeOk, s.ret60[t], slip, (d, entry, atr) => s.close[d] < s.sma20[d] * 0.97 ? "stop" : s.close[d] >= entry + 2 * atr ? "target" : d - (t + 1) >= 9 ? "time" : null);
          if (tr) trades.push(tr);
        }
      }
      // H-BOUNCE
      if (s.close[t] > s.sma200[t] && s.close[t] < s.close[t - 1] && s.close[t - 1] < s.close[t - 2] && s.close[t - 2] < s.close[t - 3] && s.close[t - 3] - s.close[t] >= 1.5 * s.atr14[t]) {
        const drop = (s.close[t - 3] - s.close[t]) / s.atr14[t];
        const tr = manage(s, t, "BOUNCE", regimeOk, drop, slip, (d, entry, atr) => s.close[d] > s.sma5[d] ? "target" : s.close[d] < entry - 2 * atr ? "stop" : d - (t + 1) >= 4 ? "time" : null);
        if (tr) trades.push(tr);
      }
    }
  }

  if (args.out) { fs.mkdirSync(path.dirname(args.out), { recursive: true }); fs.writeFileSync(args.out, trades.map((t) => JSON.stringify(t)).join("\n") + (trades.length ? "\n" : "")); }

  const first = series.reduce((m, s) => (s.dates[205] < m ? s.dates[205] : m), "9999");
  const last = series.reduce((m, s) => (s.dates[s.dates.length - 1] > m ? s.dates[s.dates.length - 1] : m), "0000");
  process.stdout.write(`\n===== Swing diagnostics =====\nNames ${series.length} (failed ${failed}), signal window ${first} to ${last}, slippage ${args.slippageBps} bps/side\n`);
  for (const strat of ["PULL", "BOUNCE"] as const) {
    const all = trades.filter((t) => t.strategy === strat);
    process.stdout.write(`\n########## H-${strat} ##########\n`);
    report("ALL (ungated)", all);
    report("REGIME-GATED (SPY > 50d)", all.filter((t) => t.regimeOk));
    report("regime off (SPY < 50d)", all.filter((t) => !t.regimeOk));
    byQuarter("ALL", all); byQuarter("GATED", all.filter((t) => t.regimeOk));
    concentration("ALL", all); concentration("GATED", all.filter((t) => t.regimeOk));
    report("ALL capped portfolio (5 slots, $1k each, ranked)", capped(all, 5));
    report("GATED capped portfolio (5 slots)", capped(all.filter((t) => t.regimeOk), 5));
    const ex: Record<string, number> = {}; for (const t of all) ex[t.reason] = (ex[t.reason] ?? 0) + 1;
    process.stdout.write(`exit mix: ${Object.entries(ex).map(([k, v]) => `${k} ${(v / Math.max(1, all.length) * 100).toFixed(0)}%`).join(", ")}; avg held ${(all.reduce((s, t) => s + t.held, 0) / Math.max(1, all.length)).toFixed(1)} sessions\n`);
  }
}

function manage(s: Series, t: number, strategy: "PULL" | "BOUNCE", regimeOk: boolean, rank: number, slip: number, rule: (d: number, entry: number, atr: number) => "stop" | "target" | "time" | null): SwingTrade | null {
  const n = s.dates.length;
  const e = t + 1;
  if (e >= n) return null;
  const entry = s.open[e] * (1 + slip);
  const atr = s.atr14[t];
  if (!(entry > 0) || !(atr > 0)) return null;
  for (let d = e; d < n; d++) {
    const r = rule(d, entry, atr);
    if (r) return finish(s, strategy, t, e, d, entry, r, regimeOk, rank, slip);
  }
  return finish(s, strategy, t, e, n - 1, entry, "eod", regimeOk, rank, slip);
}

function finish(s: Series, strategy: "PULL" | "BOUNCE", t: number, e: number, d: number, entry: number, reason: SwingTrade["reason"], regimeOk: boolean, rank: number, slip: number): SwingTrade {
  const exit = s.close[d] * (1 - slip);
  const returnPct = (exit / entry - 1) * 100;
  return { strategy, symbol: s.symbol, signalDate: s.dates[t], entryDate: s.dates[e], exitDate: s.dates[d], entry, exit, reason, held: d - e + 1, regimeOk, rank, returnPct, pnlPer1000: returnPct * 10 };
}

// Portfolio with at most `slots` open positions; new signals on a date are
// taken by descending rank while slots are free.
function capped(ts: readonly SwingTrade[], slots: number): SwingTrade[] {
  const byEntry = new Map<string, SwingTrade[]>();
  for (const t of ts) byEntry.set(t.entryDate, [...(byEntry.get(t.entryDate) ?? []), t]);
  const dates = [...byEntry.keys()].sort();
  const open: SwingTrade[] = []; const taken: SwingTrade[] = [];
  for (const d of dates) {
    for (let i = open.length - 1; i >= 0; i--) if (open[i].exitDate < d) open.splice(i, 1);
    const cands = [...(byEntry.get(d) ?? [])].sort((a, b) => b.rank - a.rank);
    for (const c of cands) { if (open.length >= slots) break; if (open.some((o) => o.symbol === c.symbol)) continue; open.push(c); taken.push(c); }
  }
  return taken;
}

function report(label: string, ts: readonly SwingTrade[]): void {
  if (ts.length === 0) { process.stdout.write(`${label}: none\n`); return; }
  const w = ts.filter((t) => t.returnPct > 0), l = ts.filter((t) => t.returnPct <= 0);
  const avg = (a: readonly SwingTrade[]): number => (a.length ? a.reduce((s, t) => s + t.returnPct, 0) / a.length : 0);
  const gw = w.reduce((s, t) => s + t.returnPct, 0), gl = -l.reduce((s, t) => s + t.returnPct, 0);
  const net = ts.reduce((s, t) => s + t.pnlPer1000, 0);
  process.stdout.write(`${label.padEnd(48)} n=${String(ts.length).padStart(5)}  win ${(w.length / ts.length * 100).toFixed(1).padStart(5)}%  avg win ${avg(w).toFixed(2)}%  avg loss ${avg(l).toFixed(2)}%  exp ${(avg(ts) >= 0 ? "+" : "") + avg(ts).toFixed(2)}%  PF ${(gl > 0 ? gw / gl : Infinity).toFixed(2)}  net $${net.toFixed(0)}\n`);
}

function byQuarter(label: string, ts: readonly SwingTrade[]): void {
  const q = new Map<string, SwingTrade[]>();
  for (const t of ts) { const k = `${t.entryDate.slice(0, 4)}Q${Math.ceil(Number(t.entryDate.slice(5, 7)) / 3)}`; q.set(k, [...(q.get(k) ?? []), t]); }
  const keys = [...q.keys()].sort();
  process.stdout.write(`${label} by quarter: ${keys.map((k) => { const a = q.get(k)!; const e = a.reduce((s, t) => s + t.returnPct, 0) / a.length; return `${k} n=${a.length} ${e >= 0 ? "+" : ""}${e.toFixed(2)}%`; }).join(" | ")}\n`);
  const m = new Map<string, number>();
  for (const t of ts) { const k = t.entryDate.slice(0, 7); m.set(k, (m.get(k) ?? 0) + t.pnlPer1000); }
  const best = [...m.entries()].sort((a, b) => b[1] - a[1])[0];
  const net = ts.reduce((s, t) => s + t.pnlPer1000, 0);
  if (best) process.stdout.write(`${label} best month ${best[0]} $${best[1].toFixed(0)} of net $${net.toFixed(0)}; without it $${(net - best[1]).toFixed(0)}\n`);
}

function concentration(label: string, ts: readonly SwingTrade[]): void {
  const m = new Map<string, number>();
  for (const t of ts) m.set(t.symbol, (m.get(t.symbol) ?? 0) + t.pnlPer1000);
  const net = ts.reduce((s, t) => s + t.pnlPer1000, 0);
  const best = [...m.entries()].sort((a, b) => b[1] - a[1])[0];
  if (best) process.stdout.write(`${label} best symbol ${best[0]} $${best[1].toFixed(0)} = ${net !== 0 ? (best[1] / net * 100).toFixed(0) : "n/a"}% of net; symbols traded ${m.size}\n`);
}

main().catch((err) => { process.stderr.write(`FATAL: ${err instanceof Error ? err.message : String(err)}\n`); process.exit(1); });
