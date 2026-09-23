// Theory tests: registered hypotheses about catalyst-driven setups, replayed
// with the gap rule (gap-replay.ts) and reported as selection / validation
// halves. Pre-declared statements and pass criteria live in docs/theories.md;
// results go to docs/results/theory-<id>-<date>-<source>.txt, kept win or lose.
//
//   npm run theory -- --id T1              # day-2 continuation
//   npm run theory -- --id T2              # mega-cap catalyst gap (AMD type)
//   npm run theory -- --id T3              # earnings gap-and-go (Nasdaq calendar dates)
//   npm run theory -- --id T4              # after-hours mover follow-through
//   npm run theory -- --id all --source store   # operator's machine: 149 sessions of Schwab bars
//
// Yahoo gives about 60 days of 5-minute bars; the store (data/history/5m)
// gives 149 sessions. Both windows are short; a theory that passes here is a
// forward-test hypothesis, not an edge. Read-only; never places orders.

import * as fs from "node:fs";
import * as path from "node:path";
import { setLogLevel } from "../core/logger.js";
import type { Bar } from "../core/types.js";
import { YahooHistoricalBars } from "../data/yahoo-historical.js";
import { loadStoredIntraday } from "../data/bar-store.js";
import { etParts } from "../utils/time.js";
import { loadUniverse, type UniverseEntry } from "../research/universe.js";
import { SECTOR_ETFS, sectorFor } from "../research/sectors.js";
import { fetchEarnings } from "../research/earnings-calendar.js";
import { averageTrueRange, minutesEt, simulate, OPEN_CHASE_PCT, OPEN_MIN, type ExitMode, type GapGoTrade } from "./gap-replay.js";

interface Args { id: string; source: "yahoo" | "store" | "auto"; days: number; maxNames: number; slipBps: number; out: string; minDollarVol: number; startDate: string | null; endDate: string | null }
interface Day { readonly date: string; readonly open: number; readonly high: number; readonly low: number; readonly close: number }
interface Session { readonly date: string; readonly pre: readonly Bar[]; readonly rth: readonly Bar[]; readonly ah: readonly Bar[] }
interface Stat { readonly n: number; readonly win: number; readonly exp: number; readonly pf: number; readonly net: number }

const CLOSE_MIN = 16 * 60;
const MIN_HISTORY = 15;   // prior sessions needed for the 20-day level and ATR

function parseArgs(argv: readonly string[]): Args {
  const out: Args = { id: "all", source: "auto", days: 59, maxNames: 1500, slipBps: 10, out: path.join("docs", "results"), minDollarVol: 1e9, startDate: null, endDate: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--id") out.id = (argv[++i] ?? "all").toUpperCase();
    else if (a === "--source") { const v = argv[++i]; if (v === "yahoo" || v === "store" || v === "auto") out.source = v; }
    else if (a === "--days") out.days = Number(argv[++i]) || 59;
    else if (a === "--max-names") out.maxNames = Number(argv[++i]) || 1500;
    else if (a === "--slippage-bps") out.slipBps = Number(argv[++i]) || 0;
    else if (a === "--out") out.out = argv[++i] ?? out.out;
    else if (a === "--min-dollar-vol") out.minDollarVol = Number(argv[++i]) || 1e9;
    else if (a === "--start-date") out.startDate = argv[++i] ?? null;   // sessions on or after (YYYY-MM-DD)
    else if (a === "--end-date") out.endDate = argv[++i] ?? null;       // sessions on or before; use to keep a store run out of sample
  }
  return out;
}

interface Headline { readonly id: string; readonly label: string; readonly n: number; readonly win: number; readonly exp: number; readonly pf: number; readonly selExp: number | null; readonly valExp: number | null; readonly verdict: string; readonly date: string; readonly source: string }

class Ctx {
  readonly yahoo = new YahooHistoricalBars();
  readonly now = Date.now();
  readonly lines: string[] = [];
  readonly headlines: Headline[] = [];
  currentId = "";
  readonly slip: number;
  constructor(readonly args: Args, readonly entries: readonly UniverseEntry[]) { this.slip = args.slipBps / 10_000; }
  say(s: string): void { this.lines.push(s); process.stdout.write(s + "\n"); }
  inRange(date: string): boolean {
    // Today's session counts only once it is complete (the Yahoo runs of 2026-09-22 included the then-partial session).
    const p = etParts(this.now);
    if (date > p.date || (date === p.date && p.hour * 60 + p.minute < 16 * 60 + 5)) return false;
    return (this.args.startDate === null || date >= this.args.startDate) && (this.args.endDate === null || date <= this.args.endDate);
  }

  // Full intraday history for a symbol: the store when present and allowed, else Yahoo (about 60 days).
  async intraday(symbol: string, cache: boolean): Promise<readonly Bar[] | null> {
    if (this.args.source !== "yahoo") {
      const stored = loadStoredIntraday(symbol);
      if (stored) return stored;
      if (this.args.source === "store") return null;
    }
    try {
      return await this.yahoo.fetch({ symbol, interval: "5m", startMs: this.now - this.args.days * 86_400_000, endMs: this.now, includePrePost: true, cache });
    } catch { return null; }
  }

  // A short intraday window around one session (prior close through the after-hours of `date`).
  async window(symbol: string, date: string): Promise<readonly Bar[] | null> {
    const stored = this.args.source !== "yahoo" ? loadStoredIntraday(symbol) : null;
    if (stored) return stored.filter((b) => { const d = etParts(b.timestamp).date; return d <= date && d >= shiftDate(date, -5); });
    if (this.args.source === "store") return null;
    const start = Date.parse(`${shiftDate(date, -5)}T00:00:00-04:00`);
    const end = Date.parse(`${date}T23:59:00-04:00`);
    if (!(end > start) || end < this.now - this.args.days * 86_400_000) return null;
    try {
      return await this.yahoo.fetch({ symbol, interval: "5m", startMs: start, endMs: Math.min(end, this.now), includePrePost: true, cache: false });
    } catch { return null; }
  }

  // Daily bars: Yahoo 1d (200 days) or, for the store, derived from intraday.
  async daily(symbol: string): Promise<readonly Day[]> {
    if (this.args.source !== "yahoo") {
      const stored = loadStoredIntraday(symbol);
      if (stored) return dailyFromSessions(sessionsOf(stored));
      if (this.args.source === "store") return [];
    }
    try {
      const bars = await this.yahoo.fetch({ symbol, interval: "1d", startMs: this.now - 200 * 86_400_000, endMs: this.now, includePrePost: false, cache: true });
      return bars.map((b) => ({ date: etParts(b.timestamp).date, open: b.open, high: b.high, low: b.low, close: b.close }));
    } catch { return []; }
  }
}

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function sessionsOf(bars: readonly Bar[]): Session[] {
  const by = new Map<string, { pre: Bar[]; rth: Bar[]; ah: Bar[] }>();
  for (const b of bars) {
    const d = etParts(b.timestamp).date;
    const m = minutesEt(b.timestamp);
    const s = by.get(d) ?? { pre: [], rth: [], ah: [] };
    (m < OPEN_MIN ? s.pre : m < CLOSE_MIN ? s.rth : s.ah).push(b);
    by.set(d, s);
  }
  return [...by.entries()].filter(([, s]) => s.rth.length > 0).sort((a, b) => a[0].localeCompare(b[0])).map(([date, s]) => ({ date, pre: s.pre.sort((a, b) => a.timestamp - b.timestamp), rth: s.rth.sort((a, b) => a.timestamp - b.timestamp), ah: s.ah.sort((a, b) => a.timestamp - b.timestamp) }));
}

function dailyFromSessions(sessions: readonly Session[]): Day[] {
  return sessions.map((s) => ({ date: s.date, open: s.rth[0].open, high: Math.max(...s.rth.map((b) => b.high)), low: Math.min(...s.rth.map((b) => b.low)), close: s.rth[s.rth.length - 1].close }));
}

function atrOf(days: readonly Day[], upToIdx: number): number | null {
  if (upToIdx < MIN_HISTORY) return null;
  const slice = days.slice(Math.max(0, upToIdx - 14), upToIdx + 1);
  const bars: Bar[] = slice.map((d) => ({ symbol: "", timestamp: 0, open: d.open, high: d.high, low: d.low, close: d.close, volume: 0 }));
  return averageTrueRange(bars, Math.min(14, bars.length - 1));
}

function high20(days: readonly Day[], upToIdx: number): number | null {
  if (upToIdx < MIN_HISTORY) return null;
  return Math.max(...days.slice(Math.max(0, upToIdx - 20), upToIdx).map((d) => d.high));
}

function low20(days: readonly Day[], upToIdx: number): number | null {
  if (upToIdx < MIN_HISTORY) return null;
  return Math.min(...days.slice(Math.max(0, upToIdx - 20), upToIdx).map((d) => d.low));
}

// The rule with the open-chase skip, in one direction.
function replay(symbol: string, s: Session, direction: "LONG" | "SHORT", gapPct: number, atr: number, slip: number, exitMode: ExitMode = "targets"): GapGoTrade | null {
  if (s.pre.length === 0 || s.rth.length < 3) return null;
  const pmHigh = Math.max(...s.pre.map((b) => b.high));
  const pmLow = Math.min(...s.pre.map((b) => b.low));
  const open = s.rth[0].open;
  if (direction === "LONG" ? open > pmHigh * (1 + OPEN_CHASE_PCT / 100) : open < pmLow * (1 - OPEN_CHASE_PCT / 100)) return null;
  return simulate(symbol, s.date, direction, gapPct, false, s.rth, pmHigh, pmLow, atr, slip, exitMode);
}

// T7: the same trades under each exit; a variant passes when its expectancy
// beats the registered exit in both date halves and its PF is >= 1.3.
interface Variants { readonly t: GapGoTrade; readonly hold: GapGoTrade | null; readonly half: GapGoTrade | null }
function reportVariants(ctx: Ctx, label: string, rows: readonly Variants[]): void {
  if (rows.length < 4) return;
  const base = rows.map((r) => r.t);
  const dates = [...new Set(base.map((t) => t.date))].sort();
  const split = dates[Math.floor(dates.length / 2) - 1];
  const halves = (ts: readonly GapGoTrade[]): [Stat, Stat] => [stat(ts.filter((t) => t.date <= split)), stat(ts.filter((t) => t.date > split))];
  const [bs, bv] = halves(base);
  for (const [name, pick] of [["hold to 15:45", (r: Variants): GapGoTrade | null => r.hold], ["half at 1 ATR, rest to 15:45", (r: Variants): GapGoTrade | null => r.half]] as const) {
    const ts = rows.map(pick).filter((t): t is GapGoTrade => t !== null);
    const all = stat(ts); const [vs, vv] = halves(ts);
    const beats = vs.exp > bs.exp && vv.exp > bv.exp && all.pf >= 1.3;
    ctx.say(`    T7 exit variant "${name}" on ${label}: ${fmtStat(all)}; halves ${vs.exp >= 0 ? "+" : ""}${vs.exp.toFixed(2)}% / ${vv.exp >= 0 ? "+" : ""}${vv.exp.toFixed(2)}% against the registered exit ${bs.exp >= 0 ? "+" : ""}${bs.exp.toFixed(2)}% / ${bv.exp >= 0 ? "+" : ""}${bv.exp.toFixed(2)}%: ${beats ? "BEATS IT (both halves, PF >= 1.3)" : "does not beat it"}`);
    ctx.headlines.push({ id: "T7", label: `${name} on ${label}`, n: all.n, win: all.win, exp: all.exp, pf: all.pf, selExp: vs.exp, valExp: vv.exp, verdict: beats ? "PASS" : "NOT QUALIFIED", date: etParts(ctx.now).date, source: ctx.args.source });
  }
}

function stat(ts: readonly GapGoTrade[]): Stat {
  if (ts.length === 0) return { n: 0, win: 0, exp: 0, pf: 0, net: 0 };
  const wins = ts.filter((t) => t.returnPct > 0);
  const gw = wins.reduce((s, t) => s + t.returnPct, 0);
  const gl = -ts.filter((t) => t.returnPct <= 0).reduce((s, t) => s + t.returnPct, 0);
  return { n: ts.length, win: wins.length / ts.length * 100, exp: ts.reduce((s, t) => s + t.returnPct, 0) / ts.length, pf: gl > 0 ? gw / gl : 99, net: ts.reduce((s, t) => s + t.pnlPer1000, 0) };
}

function fmtStat(s: Stat): string {
  return s.n === 0 ? "n=0" : `n=${s.n}  win ${s.win.toFixed(1)}%  exp ${s.exp >= 0 ? "+" : ""}${s.exp.toFixed(2)}%  PF ${s.pf.toFixed(2)}  net at $1k/trade ${s.net >= 0 ? "+" : "-"}$${Math.abs(s.net).toFixed(0)}`;
}

// Whole window plus date halves; the pass test is declared in docs/theories.md.
function report(ctx: Ctx, label: string, ts: readonly GapGoTrade[], headline = false): void {
  const all = stat(ts);
  ctx.say(`  ${label}: ${fmtStat(all)}`);
  if ((!headline && ts.length < 30) || ts.length < 4) return;
  const dates = [...new Set(ts.map((t) => t.date))].sort();
  const split = dates[Math.floor(dates.length / 2) - 1];
  const sel = stat(ts.filter((t) => t.date <= split));
  const val = stat(ts.filter((t) => t.date > split));
  const pass = all.n >= 30 && all.exp > 0 && all.pf >= 1.3 && sel.exp > 0 && val.exp > 0;
  ctx.say(`    selection (<= ${split}): ${fmtStat(sel)}`);
  ctx.say(`    validation (> ${split}): ${fmtStat(val)}`);
  const verdict = pass ? "PASS" : all.n < 30 ? "NOT QUALIFIED (n < 30)" : "NOT QUALIFIED";
  ctx.say(`    ${headline ? "verdict" : "descriptive line, no verdict; would read"}: ${pass ? "PASS (n >= 30, exp > 0, PF >= 1.3, both halves positive)" : verdict}`);
  if (headline) ctx.headlines.push({ id: ctx.currentId, label, n: all.n, win: all.win, exp: all.exp, pf: all.pf, selExp: sel.exp, valExp: val.exp, verdict, date: etParts(ctx.now).date, source: ctx.args.source });
  const mix = new Map<string, number>();
  for (const t of ts) for (const e of t.exits) mix.set(e.reason, (mix.get(e.reason) ?? 0) + e.fraction);
  ctx.say(`    exit mix: ${[...mix.entries()].map(([k, v]) => `${k} ${(v / ts.length * 100).toFixed(0)}%`).join(", ")}`);
}

function bucket(v: number, edges: readonly number[]): string {
  const a = Math.abs(v);
  for (let i = 0; i < edges.length; i++) if (a < edges[i]) return i === 0 ? `<${edges[0]}` : `${edges[i - 1]}-${edges[i]}`;
  return `${edges[edges.length - 1]}+`;
}

function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// ----- T1: day-2 continuation -----
async function theoryT1(ctx: Ctx): Promise<void> {
  ctx.say(`\n===== T1 Day-2 continuation: close up 10%+ in the top quarter of the range above the prior 20-day high (mirror for shorts); the gap rule on the next session, no gap-size requirement =====`);
  const names = ctx.entries.slice(0, ctx.args.maxNames).map((e) => e.symbol);
  const windowStart = etParts(ctx.now - ctx.args.days * 86_400_000).date;
  interface Ev { symbol: string; date: string; next: string; dir: "LONG" | "SHORT"; dClose: number; atr: number; dayPct: number }
  const events: Ev[] = [];
  let scanned = 0;
  for (const sym of names) {
    const days = await ctx.daily(sym);
    scanned++;
    if (scanned % 300 === 0) process.stdout.write(`  ${scanned}/${names.length} daily histories\n`);
    for (let i = MIN_HISTORY; i < days.length - 1; i++) {
      const d = days[i]; const prev = days[i - 1];
      if (d.date < windowStart || !ctx.inRange(days[i + 1].date) || !(prev.close > 0) || !(d.high > d.low)) continue;
      const ret = (d.close / prev.close - 1) * 100;
      const pos = (d.close - d.low) / (d.high - d.low);
      const atr = atrOf(days, i);
      if (atr === null) continue;
      const h20 = high20(days, i); const l20 = low20(days, i);
      if (ret >= 10 && pos >= 0.75 && h20 !== null && d.close > h20) events.push({ symbol: sym, date: d.date, next: days[i + 1].date, dir: "LONG", dClose: d.close, atr, dayPct: ret });
      else if (ret <= -10 && pos <= 0.25 && l20 !== null && d.close < l20) events.push({ symbol: sym, date: d.date, next: days[i + 1].date, dir: "SHORT", dClose: d.close, atr, dayPct: ret });
    }
  }
  ctx.say(`  ${events.length} events in ${names.length} names since ${windowStart} (${events.filter((e) => e.dir === "LONG").length} up days, ${events.filter((e) => e.dir === "SHORT").length} down days)`);
  const trades: (GapGoTrade & { dir: string; gapBucket: string })[] = [];
  let noPm = 0; let gapsUp = 0; const gaps: number[] = [];
  for (const ev of events) {
    const bars = await ctx.window(ev.symbol, ev.next);
    const s = bars ? sessionsOf(bars).find((x) => x.date === ev.next) : undefined;
    if (!s || s.pre.length === 0) { noPm++; continue; }
    const gap = (s.pre[s.pre.length - 1].close / ev.dClose - 1) * 100;
    gaps.push(ev.dir === "LONG" ? gap : -gap);
    if ((ev.dir === "LONG" && gap > 0) || (ev.dir === "SHORT" && gap < 0)) gapsUp++;
    const t = replay(ev.symbol, s, ev.dir, gap, ev.atr, ctx.slip);
    const signed = ev.dir === "LONG" ? gap : -gap;   // gap in the day-1 direction
    if (t) trades.push({ ...t, dir: ev.dir, gapBucket: signed < 0 ? "<0" : signed < 3 ? "0-3" : signed < 10 ? "3-10" : "10+" });
  }
  ctx.say(`  day 2: ${events.length - noPm} with pre-market prints (${noPm} without), gap in the day-1 direction ${gaps.length ? (gapsUp / gaps.length * 100).toFixed(0) : "n/a"}%, median gap in that direction ${median(gaps).toFixed(2)}%`);
  report(ctx, "long, all", trades.filter((t) => t.dir === "LONG"), true);
  for (const b of ["<0", "0-3", "3-10", "10+"]) report(ctx, `long, day-2 gap ${b}% (in the day-1 direction)`, trades.filter((t) => t.dir === "LONG" && t.gapBucket === b));
  for (const b of ["<0", "0-3", "3-10", "10+"]) report(ctx, `short, day-2 gap ${b}% (in the day-1 direction)`, trades.filter((t) => t.dir === "SHORT" && t.gapBucket === b));
  report(ctx, "short, all", trades.filter((t) => t.dir === "SHORT"), true);
}

// ----- T2: mega-cap catalyst gap (AMD type) -----
async function theoryT2(ctx: Ctx): Promise<void> {
  const names = ctx.entries.filter((e) => e.avgDollarVol20 >= ctx.args.minDollarVol).map((e) => e.symbol);
  ctx.say(`\n===== T2 Mega-cap catalyst gap: names with 20-day dollar volume >= $${(ctx.args.minDollarVol / 1e9).toFixed(1)}B (${names.length}), pre-market gap up 2%+ above the 20-day high with the sector ETF green pre-market; the gap rule long =====`);
  const etfSessions = new Map<string, Map<string, Session>>();
  for (const etf of SECTOR_ETFS) {
    const bars = await ctx.intraday(etf, true);
    if (bars) etfSessions.set(etf, new Map(sessionsOf(bars).map((s) => [s.date, s])));
  }
  const etfGap = (etf: string, date: string, prevDate: string): number | null => {
    const m = etfSessions.get(etf); const s = m?.get(date); const p = m?.get(prevDate);
    if (!s || !p || s.pre.length === 0) return null;
    return (s.pre[s.pre.length - 1].close / p.rth[p.rth.length - 1].close - 1) * 100;
  };
  const rows: { t: GapGoTrade; above20: boolean; sectorGreen: boolean | null; hold: GapGoTrade | null; half: GapGoTrade | null }[] = [];
  let scanned = 0;
  for (const sym of names) {
    const bars = await ctx.intraday(sym, true);
    scanned++;
    if (scanned % 50 === 0) process.stdout.write(`  ${scanned}/${names.length} names\n`);
    if (!bars) continue;
    const sessions = sessionsOf(bars);
    const days = dailyFromSessions(sessions);
    for (let i = MIN_HISTORY; i < sessions.length; i++) {
      const s = sessions[i];
      if (s.pre.length === 0 || !ctx.inRange(s.date)) continue;
      const prior = days[i - 1].close;
      const pmLast = s.pre[s.pre.length - 1].close;
      const gap = (pmLast / prior - 1) * 100;
      if (gap < 2) continue;
      const atr = atrOf(days, i - 1); const h20 = high20(days, i);
      if (atr === null || h20 === null) continue;
      const sg = etfGap(sectorFor(sym), s.date, sessions[i - 1].date);
      const t = replay(sym, s, "LONG", gap, atr, ctx.slip);
      if (t) rows.push({ t, above20: pmLast > h20, sectorGreen: sg === null ? null : sg > 0, hold: replay(sym, s, "LONG", gap, atr, ctx.slip, "hold"), half: replay(sym, s, "LONG", gap, atr, ctx.slip, "half-hold") });
    }
  }
  ctx.say(`  ${rows.length} rule entries from gaps >= 2%`);
  for (const min of [2, 3, 4]) {
    report(ctx, `gap >= ${min}%, any structure${min === 2 ? " (T8 headline)" : ""}`, rows.filter((r) => r.t.gapPct >= min).map((r) => r.t), min === 2);
    report(ctx, `gap >= ${min}%, above the 20-day high`, rows.filter((r) => r.t.gapPct >= min && r.above20).map((r) => r.t));
    report(ctx, `gap >= ${min}%, above the 20-day high, sector green (the AMD specification)`, rows.filter((r) => r.t.gapPct >= min && r.above20 && r.sectorGreen === true).map((r) => r.t), min === 3);
    if (min === 2) reportVariants(ctx, "any mega-cap gap >= 2% (T8)", rows.filter((r) => r.t.gapPct >= 2));
    if (min === 3) {
      reportVariants(ctx, "the AMD specification (gap >= 3%)", rows.filter((r) => r.t.gapPct >= 3 && r.above20 && r.sectorGreen === true));
      reportVariants(ctx, "any mega-cap gap >= 3%", rows.filter((r) => r.t.gapPct >= 3));
    }
  }
}

// ----- T3: earnings gap-and-go -----
async function theoryT3(ctx: Ctx): Promise<void> {
  ctx.say(`\n===== T3 Earnings gap-and-go: names on the Nasdaq calendar that gap 5%+ on the report session (report date, else the next session); the gap rule in the gap's direction =====`);
  const spy = await ctx.intraday("SPY", true);
  if (!spy) { ctx.say("  no SPY bars; cannot enumerate sessions"); return; }
  const sessions = sessionsOf(spy).map((s) => s.date).filter((d) => ctx.inRange(d));
  const universe = new Set(ctx.entries.slice(0, ctx.args.maxNames).map((e) => e.symbol));
  const trades: (GapGoTrade & { bucket: string })[] = [];
  const variants: (Variants & { bucket: string })[] = [];
  let reporters = 0; let withGap = 0; let noBars = 0;
  const seen = new Set<string>();
  for (let i = 0; i < sessions.length; i++) {
    const date = sessions[i];
    const cal = (await fetchEarnings(date)).filter((r) => universe.has(r.symbol));
    for (const r of cal) {
      const key = `${r.symbol}:${date}`;
      if (seen.has(key)) continue;
      seen.add(key);
      reporters++;
      const candidates = r.time === "pre-market" ? [date] : r.time === "after-hours" ? [sessions[i + 1]] : [date, sessions[i + 1]];
      for (const sd of candidates) {
        if (!sd) continue;
        const bars = await ctx.window(r.symbol, sd);
        const ss = bars ? sessionsOf(bars) : [];
        const idx = ss.findIndex((x) => x.date === sd);
        if (idx < 1 || ss[idx].pre.length === 0) { if (idx < 0) noBars++; continue; }
        const prior = ss[idx - 1].rth[ss[idx - 1].rth.length - 1].close;
        const gap = (ss[idx].pre[ss[idx].pre.length - 1].close / prior - 1) * 100;
        if (Math.abs(gap) < 5) continue;
        withGap++;
        const days = await ctx.daily(r.symbol);
        const di = days.findIndex((d) => d.date === sd);
        const atr = di > 0 ? atrOf(days, di - 1) : null;
        if (atr === null) break;
        const dir = gap > 0 ? "LONG" : "SHORT";
        const t = replay(r.symbol, ss[idx], dir, gap, atr, ctx.slip);
        if (t) {
          trades.push({ ...t, bucket: bucket(gap, [10]) });
          if (dir === "LONG") variants.push({ t, hold: replay(r.symbol, ss[idx], dir, gap, atr, ctx.slip, "hold"), half: replay(r.symbol, ss[idx], dir, gap, atr, ctx.slip, "half-hold"), bucket: bucket(gap, [10]) });
        }
        break;
      }
    }
    if ((i + 1) % 10 === 0) process.stdout.write(`  ${i + 1}/${sessions.length} sessions, ${reporters} reporters, ${withGap} gaps >= 5%\n`);
  }
  ctx.say(`  ${reporters} reporters in the universe over ${sessions.length} sessions; ${withGap} gapped 5%+ (${noBars} without bars)`);
  report(ctx, "long, all earnings gaps", trades.filter((t) => t.direction === "LONG"), true);
  report(ctx, "long, gap 5-10%", trades.filter((t) => t.direction === "LONG" && t.bucket === "<10"));
  report(ctx, "long, gap 10%+", trades.filter((t) => t.direction === "LONG" && t.bucket === "10+"), true);
  reportVariants(ctx, "earnings gaps 10%+ long", variants.filter((v) => v.bucket === "10+"));
  reportVariants(ctx, "all earnings gaps long", variants);
  report(ctx, "short, all earnings gaps (for the record)", trades.filter((t) => t.direction === "SHORT"));
  report(ctx, "short, gap 5-10%", trades.filter((t) => t.direction === "SHORT" && t.bucket === "<10"));
  report(ctx, "short, gap 10%+", trades.filter((t) => t.direction === "SHORT" && t.bucket === "10+"));
  ctx.say(`  reference, no catalyst filter (store, 123 sessions): 5-10% gaps 42-46% win, about -0.2%/trade; 10%+ gaps 45% / 54% win by half`);
}

// ----- T4: after-hours mover follow-through -----
async function theoryT4(ctx: Ctx): Promise<void> {
  const names = ctx.entries.slice(0, ctx.args.maxNames).map((e) => e.symbol);
  ctx.say(`\n===== T4 After-hours mover follow-through: after-hours last 3%+ from the close; next session the gap rule in that direction (${names.length} names) =====`);
  const rows: { t: GapGoTrade; ah: number; held: boolean }[] = [];
  let events = 0; let held = 0; const gaps: number[] = []; let scanned = 0;
  for (const sym of names) {
    const bars = await ctx.intraday(sym, false);
    scanned++;
    if (scanned % 200 === 0) process.stdout.write(`  ${scanned}/${names.length} names, ${events} events\n`);
    if (!bars) continue;
    const sessions = sessionsOf(bars);
    const days = dailyFromSessions(sessions);
    for (let i = MIN_HISTORY; i < sessions.length - 1; i++) {
      const s = sessions[i];
      if (s.ah.length === 0) continue;
      const close = days[i].close;
      const ahLast = s.ah[s.ah.length - 1].close;
      const ah = (ahLast / close - 1) * 100;
      if (Math.abs(ah) < 3) continue;
      const next = sessions[i + 1];
      if (next.pre.length === 0 || !ctx.inRange(next.date)) continue;
      events++;
      const gap = (next.pre[next.pre.length - 1].close / close - 1) * 100;
      const same = Math.sign(gap) === Math.sign(ah);
      if (same) held++;
      gaps.push(ah > 0 ? gap : -gap);
      const atr = atrOf(days, i);
      if (atr === null) continue;
      const t = replay(sym, next, ah > 0 ? "LONG" : "SHORT", gap, atr, ctx.slip);
      if (t) rows.push({ t, ah, held: same });
    }
  }
  ctx.say(`  ${events} after-hours moves of 3%+ with next-day pre-market prints; gap kept the sign ${events ? (held / events * 100).toFixed(0) : "n/a"}% of the time; median gap in the after-hours direction ${median(gaps).toFixed(2)}%`);
  report(ctx, "long (after-hours up), all", rows.filter((r) => r.ah > 0).map((r) => r.t), true);
  for (const [lo, hi] of [[3, 5], [5, 10], [10, 1000]] as const) report(ctx, `long, after-hours +${lo}${hi < 1000 ? `-${hi}` : "+"}%`, rows.filter((r) => r.ah >= lo && r.ah < hi).map((r) => r.t));
  report(ctx, "long, gap still up at 09:25", rows.filter((r) => r.ah > 0 && r.held).map((r) => r.t));
  // Declared for the record only; the positive reading on 2026-09-22 is registered as T5 and validated with --end-date 2026-07-24 on the store.
  report(ctx, "short (after-hours down), all (T5 when run with --end-date 2026-07-24 on the store)", rows.filter((r) => r.ah < 0).map((r) => r.t), ctx.args.endDate !== null);
  report(ctx, "short, gap still down at 09:25", rows.filter((r) => r.ah < 0 && r.held).map((r) => r.t));
}

// ----- T6: failed-gap fade -----
async function theoryT6(ctx: Ctx): Promise<void> {
  const names = ctx.entries.slice(0, ctx.args.maxNames).map((e) => e.symbol);
  ctx.say(`\n===== T6 Failed-gap fade: a gap up that closes a 5-minute candle below its pre-market low is shorted with the mirror rule (mirror long for gaps down); ${names.length} names =====`);
  const rows: { t: GapGoTrade; gap: number; fade: "SHORT" | "LONG" }[] = [];
  const gapDays = new Map<string, number>(); const fired = new Map<string, number>();
  let scanned = 0;
  for (const sym of names) {
    const bars = await ctx.intraday(sym, false);
    scanned++;
    if (scanned % 200 === 0) process.stdout.write(`  ${scanned}/${names.length} names, ${rows.length} fades\n`);
    if (!bars) continue;
    const sessions = sessionsOf(bars);
    const days = dailyFromSessions(sessions);
    for (let i = MIN_HISTORY; i < sessions.length; i++) {
      const s = sessions[i];
      if (s.pre.length === 0 || !ctx.inRange(s.date)) continue;
      const gap = (s.pre[s.pre.length - 1].close / days[i - 1].close - 1) * 100;
      if (Math.abs(gap) < 3) continue;
      const atr = atrOf(days, i - 1);
      if (atr === null) continue;
      const key = `${gap > 0 ? "up" : "down"} ${bucket(gap, [5, 10])}`;
      gapDays.set(key, (gapDays.get(key) ?? 0) + 1);
      const fade: "SHORT" | "LONG" = gap > 0 ? "SHORT" : "LONG";
      const t = replay(sym, s, fade, gap, atr, ctx.slip);
      if (t) { rows.push({ t, gap, fade }); fired.set(key, (fired.get(key) ?? 0) + 1); }
    }
  }
  ctx.say(`  gap days and how many fired the fade by 11:30: ${[...gapDays.entries()].sort().map(([k, n]) => `${k}%: ${fired.get(k) ?? 0}/${n}`).join(", ")}`);
  report(ctx, "short fade, gap up 5-10%", rows.filter((r) => r.fade === "SHORT" && r.gap >= 5 && r.gap < 10).map((r) => r.t), true);
  report(ctx, "short fade, gap up 3-5%", rows.filter((r) => r.fade === "SHORT" && r.gap >= 3 && r.gap < 5).map((r) => r.t));
  report(ctx, "short fade, gap up 10%+", rows.filter((r) => r.fade === "SHORT" && r.gap >= 10).map((r) => r.t));
  report(ctx, "long fade, gap down 5-10%", rows.filter((r) => r.fade === "LONG" && r.gap <= -5 && r.gap > -10).map((r) => r.t));
  report(ctx, "long fade, gap down 3-5%", rows.filter((r) => r.fade === "LONG" && r.gap <= -3 && r.gap > -5).map((r) => r.t));
  report(ctx, "long fade, gap down 10%+", rows.filter((r) => r.fade === "LONG" && r.gap <= -10).map((r) => r.t));
}

// ----- T9: gap attribute filters (accuracy) -----
interface T9Row { readonly t: GapGoTrade; readonly dir: "LONG" | "SHORT"; readonly gap: number; readonly stopAtr: number; readonly firstVol: number | null; readonly pmVolRatio: number | null; readonly tapeWith: boolean | null; readonly entryMin: number; readonly strength: number; readonly above20: boolean; readonly sectorGreen: boolean | null }

async function theoryT9(ctx: Ctx): Promise<void> {
  const names = ctx.entries.slice(0, ctx.args.maxNames).map((e) => e.symbol);
  ctx.say(`\n===== T9 Gap attribute filters: every pre-market gap of 3%+ replayed with the registered rule (long up, short down), then six pre-declared filters; ${names.length} names =====`);
  const spyBars = await ctx.intraday("SPY", true);
  const spy = new Map((spyBars ? sessionsOf(spyBars) : []).map((x) => [x.date, x] as const));
  const etf = new Map<string, Map<string, Session>>();
  for (const e of SECTOR_ETFS) { const b = await ctx.intraday(e, true); if (b) etf.set(e, new Map(sessionsOf(b).map((x) => [x.date, x] as const))); }
  const rows: T9Row[] = [];
  let scanned = 0;
  for (const sym of names) {
    const bars = await ctx.intraday(sym, true);
    scanned++;
    if (scanned % 200 === 0) process.stdout.write(`  ${scanned}/${names.length} names, ${rows.length} trades\n`);
    if (!bars) continue;
    const sessions = sessionsOf(bars);
    const days = dailyFromSessions(sessions);
    for (let i = MIN_HISTORY; i < sessions.length; i++) {
      const s = sessions[i];
      if (s.pre.length === 0 || !ctx.inRange(s.date)) continue;
      const pmLast = s.pre[s.pre.length - 1].close;
      const gap = (pmLast / days[i - 1].close - 1) * 100;
      if (Math.abs(gap) < 3) continue;
      const atr = atrOf(days, i - 1); const h20 = high20(days, i);
      if (atr === null || h20 === null) continue;
      const dir: "LONG" | "SHORT" = gap > 0 ? "LONG" : "SHORT";
      const t = replay(sym, s, dir, gap, atr, ctx.slip);
      if (!t) continue;
      const long = dir === "LONG";
      const f = s.rth[0];
      const range = f.high - f.low;
      const strength = range > 0 ? (long ? (f.close - f.low) / range : (f.high - f.close) / range) : 0.5;
      const prev5 = sessions.slice(Math.max(0, i - 5), i).flatMap((x) => x.rth);
      const avg5m = prev5.length ? prev5.reduce((a, b) => a + b.volume, 0) / prev5.length : 0;
      const prev20 = sessions.slice(Math.max(0, i - 20), i);
      const avgDay = prev20.length ? prev20.reduce((a, x) => a + x.rth.reduce((q, b) => q + b.volume, 0), 0) / prev20.length : 0;
      const pmVol = s.pre.reduce((a, b) => a + b.volume, 0);
      const entryMin = Number(t.entryTime.slice(0, 2)) * 60 + Number(t.entryTime.slice(3, 5));
      const sp = spy.get(s.date);
      const spyAt = sp ? sp.rth.filter((b) => minutesEt(b.timestamp) <= entryMin).pop() : undefined;
      const tapeWith = sp && spyAt && sp.rth.length ? (long ? spyAt.open > sp.rth[0].open : spyAt.open < sp.rth[0].open) : null;
      const sm = etf.get(sectorFor(sym)); const se = sm?.get(s.date); const sePrev = sm?.get(sessions[i - 1].date);
      const sectorGreen = se && sePrev && se.pre.length > 0 && sePrev.rth.length > 0 ? se.pre[se.pre.length - 1].close > sePrev.rth[sePrev.rth.length - 1].close : null;
      rows.push({ t, dir, gap, stopAtr: Math.abs(t.entry - t.stop) / atr, firstVol: avg5m > 0 ? f.volume / avg5m : null, pmVolRatio: pmVol > 0 && avgDay > 0 ? pmVol / avgDay : null, tapeWith, entryMin, strength, above20: pmLast > h20, sectorGreen });
    }
  }
  ctx.say(`  ${rows.length} rule trades from gaps of 3%+ (${rows.filter((r) => r.pmVolRatio !== null).length} with pre-market volume)`);
  const pops: readonly (readonly [string, (r: T9Row) => boolean])[] = [
    ["long, gap 3-5%", (r) => r.dir === "LONG" && r.gap < 5],
    ["long, gap 5-10%", (r) => r.dir === "LONG" && r.gap >= 5 && r.gap < 10],
    ["long, gap 10%+", (r) => r.dir === "LONG" && r.gap >= 10],
    ["long, star spec (10%+, above the 20-day high, sector green)", (r) => r.dir === "LONG" && r.gap >= 10 && r.above20 && r.sectorGreen === true],
    ["short, gap 3-5%", (r) => r.dir === "SHORT" && r.gap > -5],
    ["short, gap 5-10%", (r) => r.dir === "SHORT" && r.gap <= -5 && r.gap > -10],
    ["short, gap 10%+", (r) => r.dir === "SHORT" && r.gap <= -10],
  ];
  const filters: readonly (readonly [string, (r: T9Row) => boolean | null])[] = [
    ["F1 stop within 1 ATR", (r) => r.stopAtr <= 1],
    ["F2 09:30 volume >= 3x a normal 5-min bar", (r) => r.firstVol === null ? null : r.firstVol >= 3],
    ["F3 SPY with the trade at entry", (r) => r.tapeWith],
    ["F4 entry by 09:45", (r) => r.entryMin <= 9 * 60 + 45],
    ["F5 strong 09:30 candle (top or bottom third)", (r) => r.strength >= 2 / 3],
    ["F6 pre-market volume >= 10% of a day", (r) => r.pmVolRatio === null ? null : r.pmVolRatio >= 0.1],
  ];
  const sp = (x: Stat): string => `${x.exp >= 0 ? "+" : ""}${x.exp.toFixed(2)}%`;
  for (const [label, pick] of pops) {
    const base = rows.filter(pick);
    if (base.length < 10) { ctx.say(`  ${label}: n=${base.length}, too few for filters`); continue; }
    const dates = [...new Set(base.map((r) => r.t.date))].sort();
    const split = dates[Math.floor(dates.length / 2) - 1];
    const halves = (rs: readonly T9Row[]): [Stat, Stat, Stat] => [stat(rs.map((r) => r.t)), stat(rs.filter((r) => r.t.date <= split).map((r) => r.t)), stat(rs.filter((r) => r.t.date > split).map((r) => r.t))];
    const [ba, bs, bv] = halves(base);
    ctx.say(`  ${label}: ${fmtStat(ba)}; halves ${sp(bs)} / ${sp(bv)} (split ${split})`);
    for (const [fl, fn] of filters) {
      const known = base.filter((r) => fn(r) !== null);
      if (known.length === 0) { ctx.say(`    ${fl}: no data on this source`); continue; }
      const kept = known.filter((r) => fn(r) === true);
      const [fa, fs, fv] = halves(kept);
      // Registered rule (2026-09-23 14:01 UTC) plus one tightening made after the first run: both filtered halves must also be positive.
      const beats = fa.n >= 30 && fa.exp > 0 && fa.pf >= 1.3 && fs.n > 0 && fv.n > 0 && fs.exp > bs.exp && fv.exp > bv.exp;
      const pass = beats && fs.exp > 0 && fv.exp > 0;
      ctx.say(`    ${fl}: ${fmtStat(fa)}; halves ${sp(fs)} / ${sp(fv)}${known.length < base.length ? `; ${base.length - known.length} without data` : ""}: ${pass ? "IMPROVES (n >= 30, exp > 0, PF >= 1.3, beats the population in both halves, both halves positive)" : beats ? "beats the population but a half still loses: no" : "no"}`);
      if (pass) ctx.headlines.push({ id: "T9", label: `${fl} on ${label}`, n: fa.n, win: fa.win, exp: fa.exp, pf: fa.pf, selExp: fs.exp, valExp: fv.exp, verdict: "CANDIDATE (store validation pending)", date: etParts(ctx.now).date, source: ctx.args.source });
    }
  }
}

// ----- T10 / T11: earnings drift, swing (daily bars) -----
interface DriftTrade extends GapGoTrade { readonly react: number; readonly hold: 5 | 10 | 20; readonly spyUp: boolean | null }

// Every earnings reaction in the universe over the lookback, with the T10
// entry, exits for 5-, 10- and 20-session holds, and whether SPY closed above
// its 50-day average on the reaction day.
async function collectDrift(ctx: Ctx, lookbackDays: number): Promise<{ trades: DriftTrade[]; dates: string[]; reporters: number; signals: number }> {
  const universe = new Set(ctx.entries.slice(0, ctx.args.maxNames).map((e) => e.symbol));
  const today = etParts(ctx.now).date;
  const spyDaily = await ctx.yahoo.fetch({ symbol: "SPY", interval: "1d", startMs: ctx.now - (lookbackDays + 90) * 86_400_000, endMs: ctx.now, includePrePost: false, cache: true });
  const spyDays = spyDaily.map((b) => ({ date: etParts(b.timestamp).date, close: b.close })).filter((d) => d.date < today);
  const spyUpOn = new Map<string, boolean>();
  for (let i = 49; i < spyDays.length; i++) {
    const sma = spyDays.slice(i - 49, i + 1).reduce((a, d) => a + d.close, 0) / 50;
    spyUpOn.set(spyDays[i].date, spyDays[i].close > sma);
  }
  const firstDate = etParts(ctx.now - lookbackDays * 86_400_000).date;
  const dates = spyDays.map((d) => d.date).filter((d) => d >= firstDate);
  const daily = new Map<string, readonly Day[] | null>();
  const dailyFor = async (sym: string): Promise<readonly Day[] | null> => {
    if (daily.has(sym)) return daily.get(sym) ?? null;
    let out: Day[] | null = null;
    try {
      const bars = await ctx.yahoo.fetch({ symbol: sym, interval: "1d", startMs: ctx.now - (lookbackDays + 30) * 86_400_000, endMs: ctx.now, includePrePost: false, cache: true });
      out = bars.map((b) => ({ date: etParts(b.timestamp).date, open: b.open, high: b.high, low: b.low, close: b.close })).filter((d) => d.date < today);
    } catch { out = null; }
    daily.set(sym, out);
    return out;
  };
  const trades: DriftTrade[] = [];
  const seen = new Set<string>();
  let reporters = 0; let signals = 0;
  for (let k = 0; k < dates.length; k++) {
    const cal = (await fetchEarnings(dates[k])).filter((r) => universe.has(r.symbol));
    await new Promise((res) => setTimeout(res, 120));
    for (const r of cal) {
      const days = await dailyFor(r.symbol);
      if (!days) continue;
      const j = days.findIndex((d) => d.date === dates[k]);
      if (j < 15 || j + 2 >= days.length) continue;
      const ret = (x: number): number => days[x].close / days[x - 1].close - 1;
      let react: number; let entryIdx: number;
      if (r.time === "pre-market") { react = j; entryIdx = j + 1; }
      else if (r.time === "after-hours") { react = j + 1; entryIdx = j + 2; }
      else { react = Math.abs(ret(j)) >= Math.abs(ret(j + 1)) ? j : j + 1; entryIdx = j + 2; }
      const key = `${r.symbol}:${days[react].date}`;
      if (seen.has(key) || entryIdx >= days.length) continue;
      seen.add(key);
      reporters++;
      if (!ctx.inRange(days[entryIdx].date)) continue;
      const d = days[react];
      const loc = d.high > d.low ? (d.close - d.low) / (d.high - d.low) : 0.5;
      const rr = ret(react) * 100;
      const dir: "LONG" | "SHORT" | null = rr >= 5 && loc >= 0.5 ? "LONG" : rr <= -5 && loc <= 0.5 ? "SHORT" : null;
      if (!dir) continue;
      signals++;
      const sign = dir === "LONG" ? 1 : -1;
      const trs: number[] = [];
      for (let x = react - 13; x <= react; x++) trs.push(Math.max(days[x].high - days[x].low, Math.abs(days[x].high - days[x - 1].close), Math.abs(days[x].low - days[x - 1].close)));
      const atr = trs.reduce((a, b) => a + b, 0) / trs.length;
      const entry = days[entryIdx].open * (1 + sign * ctx.slip);
      const stop = entry - sign * 2 * atr;
      for (const hold of [5, 10, 20] as const) {
        const last = entryIdx + hold - 1;
        if (last >= days.length) continue;
        let exitPrice = days[last].close; let reason = "hold"; let exitDate = days[last].date;
        for (let x = entryIdx; x <= last; x++) {
          if (sign * (days[x].close - stop) < 0) { exitPrice = days[x].close; reason = "stop"; exitDate = days[x].date; break; }
        }
        const px = exitPrice * (1 - sign * ctx.slip);
        const returnPct = sign * (px / entry - 1) * 100;
        trades.push({ symbol: r.symbol, date: days[entryIdx].date, direction: dir, gapPct: rr, above52w: false, entry, entryTime: "open", stop, atr, exits: [{ price: px, fraction: 1, reason, time: exitDate }], returnPct, rMultiple: returnPct / (2 * atr / entry * 100), pnlPer1000: returnPct * 10, react: rr, hold, spyUp: spyUpOn.get(d.date) ?? null });
      }
    }
    if ((k + 1) % 100 === 0) process.stdout.write(`  ${k + 1}/${dates.length} sessions, ${reporters} reporters, ${signals} signals\n`);
  }
  return { trades, dates, reporters, signals };
}

async function theoryT10(ctx: Ctx): Promise<void> {
  ctx.say(`\n===== T10 Earnings drift (swing): reaction day +5%+ closing in the upper half of its range; long at the next open (after both candidate days when the report time is not supplied); hold 5 sessions (10 and 20 descriptive); stop on a close 2 ATR against =====`);
  const { trades, dates, reporters, signals } = await collectDrift(ctx, 425);
  const months = Math.max(1, dates.length / 21);
  ctx.say(`  ${reporters} earnings reactions in the universe over ${dates.length} sessions (${dates[0]} to ${dates[dates.length - 1]}); ${signals} signals, about ${(signals / months).toFixed(0)} a month`);
  const pick = (dir: "LONG" | "SHORT", hold: 5 | 10 | 20): DriftTrade[] => trades.filter((t) => t.direction === dir && t.hold === hold);
  report(ctx, "long, reaction +5%+, hold 5 sessions", pick("LONG", 5), true);
  report(ctx, "long, reaction +5-10%, hold 5", pick("LONG", 5).filter((t) => t.react < 10));
  report(ctx, "long, reaction +10%+, hold 5", pick("LONG", 5).filter((t) => t.react >= 10));
  report(ctx, "long, hold 10 sessions", pick("LONG", 10));
  report(ctx, "long, hold 20 sessions", pick("LONG", 20));
  report(ctx, "short, reaction -5% or worse, hold 5 sessions (for the record)", pick("SHORT", 5));
  report(ctx, "short, hold 10 sessions", pick("SHORT", 10));
  report(ctx, "short, hold 20 sessions", pick("SHORT", 20));
}

// T11: the T10 long signal only when SPY closed above its 50-day on the
// reaction day; validated on 2023-01-03 to 2025-07-24, which T10 never saw.
async function theoryT11(ctx: Ctx): Promise<void> {
  const VALIDATION_START = "2023-01-03";
  const VALIDATION_END = "2025-07-24";
  ctx.say(`\n===== T11 Earnings drift in an uptrend: T10's long signal, 5-session hold, only when SPY closed above its 50-day on the reaction day; unseen window ${VALIDATION_START} to ${VALIDATION_END} =====`);
  const lookback = Math.ceil((ctx.now - Date.parse(`${VALIDATION_START}T12:00:00Z`)) / 86_400_000) + 5;
  const { trades, dates, reporters, signals } = await collectDrift(ctx, lookback);
  ctx.say(`  ${reporters} earnings reactions over ${dates.length} sessions (${dates[0]} to ${dates[dates.length - 1]}); ${signals} signals`);
  const long5 = trades.filter((t) => t.direction === "LONG" && t.hold === 5);
  const unseen = long5.filter((t) => t.date >= VALIDATION_START && t.date <= VALIDATION_END);
  const seen = long5.filter((t) => t.date > VALIDATION_END);
  ctx.say(`  Unseen window (${VALIDATION_START} to ${VALIDATION_END}):`);
  report(ctx, "  unfiltered T10 rule", unseen, false);
  report(ctx, "  SPY above its 50-day (the T11 rule)", unseen.filter((t) => t.spyUp === true), true);
  report(ctx, "  SPY below its 50-day (for reference)", unseen.filter((t) => t.spyUp === false));
  ctx.say(`  T10 window (${VALIDATION_END} onward, seen when the rule was formed; reference only):`);
  report(ctx, "  unfiltered T10 rule", seen);
  report(ctx, "  SPY above its 50-day", seen.filter((t) => t.spyUp === true));
  report(ctx, "  SPY below its 50-day", seen.filter((t) => t.spyUp === false));
  const f = stat(unseen.filter((t) => t.spyUp === true)); const u = stat(unseen);
  ctx.say(`  T11 against the unfiltered rule on the unseen window: ${f.exp >= 0 ? "+" : ""}${f.exp.toFixed(2)}% vs ${u.exp >= 0 ? "+" : ""}${u.exp.toFixed(2)}% per trade (${f.exp > u.exp ? "better" : "not better"})`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  setLogLevel("error");
  const uni = loadUniverse();
  if (!uni) throw new Error("no universe file; run npm run universe:build");
  const ctx = new Ctx(args, uni.entries);
  const today = etParts(ctx.now).date;
  const ids = args.id === "ALL" ? ["T1", "T2", "T3", "T4", "T6", "T9", "T10", "T11"] : args.id === "T7" ? ["T2", "T3"] : [args.id];
  ctx.say(`Theory tests ${today}: source ${args.source}, window ${args.days} days (Yahoo) or the store${args.startDate || args.endDate ? `, sessions ${args.startDate ?? "start"} to ${args.endDate ?? "end"}` : ""}, slippage ${args.slipBps} bps/side, universe ${uni.entries.length} names (built ${uni.builtAt.slice(0, 10)})`);
  ctx.say(`Rule: first 5-minute close beyond the pre-market extreme (09:30 candle included) confirms; entry at the next candle's open; no signal after 11:30; skip if the open is ${OPEN_CHASE_PCT}% beyond the extreme; stop on a 5-minute close through the 09:30 candle's opposite extreme; half at 1 ATR, rest at 1.5 ATR; time exit 15:45. Pass: n >= 30, exp > 0, PF >= 1.3, both date halves positive.`);
  const started = Date.now();
  for (const id of ids) {
    ctx.currentId = id;
    if (id === "T1") await theoryT1(ctx);
    else if (id === "T2") await theoryT2(ctx);
    else if (id === "T3") await theoryT3(ctx);
    else if (id === "T4") await theoryT4(ctx);
    else if (id === "T6") await theoryT6(ctx);
    else if (id === "T9") await theoryT9(ctx);
    else if (id === "T10") await theoryT10(ctx);
    else if (id === "T11") await theoryT11(ctx);
    else ctx.say(`unknown theory ${id}`);
  }
  ctx.say(`\n${((Date.now() - started) / 60_000).toFixed(1)} min`);
  fs.mkdirSync(args.out, { recursive: true });
  const file = path.join(args.out, `theory-${ids.join("").toLowerCase()}-${today}-${args.source}${args.endDate ? `-to-${args.endDate}` : ""}${args.startDate ? `-from-${args.startDate}` : ""}.txt`);
  fs.writeFileSync(file, ctx.lines.join("\n") + "\n");
  process.stdout.write(`written: ${file}\n`);
  // Headline stats for the night list (docs/results/theories.json), merged by theory id.
  const jsonFile = path.join(args.out, "theories.json");
  let existing: Headline[] = [];
  try { if (fs.existsSync(jsonFile)) existing = JSON.parse(fs.readFileSync(jsonFile, "utf-8")) as Headline[]; } catch { existing = []; }
  const merged = [...existing.filter((h) => !ids.includes(h.id) && !(h.id === "T7" && ctx.headlines.some((x) => x.id === "T7" && x.label === h.label))), ...ctx.headlines];
  fs.writeFileSync(jsonFile, JSON.stringify(merged, null, 2) + "\n");
}

main().catch((err) => {
  process.stderr.write(`theory-cli failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
