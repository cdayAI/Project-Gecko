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
import { averageTrueRange, minutesEt, simulate, OPEN_CHASE_PCT, OPEN_MIN, type GapGoTrade } from "./gap-replay.js";

interface Args { id: string; source: "yahoo" | "store" | "auto"; days: number; maxNames: number; slipBps: number; out: string; minDollarVol: number }
interface Day { readonly date: string; readonly open: number; readonly high: number; readonly low: number; readonly close: number }
interface Session { readonly date: string; readonly pre: readonly Bar[]; readonly rth: readonly Bar[]; readonly ah: readonly Bar[] }
interface Stat { readonly n: number; readonly win: number; readonly exp: number; readonly pf: number; readonly net: number }

const CLOSE_MIN = 16 * 60;
const MIN_HISTORY = 15;   // prior sessions needed for the 20-day level and ATR

function parseArgs(argv: readonly string[]): Args {
  const out: Args = { id: "all", source: "auto", days: 59, maxNames: 1500, slipBps: 10, out: path.join("docs", "results"), minDollarVol: 1e9 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--id") out.id = (argv[++i] ?? "all").toUpperCase();
    else if (a === "--source") { const v = argv[++i]; if (v === "yahoo" || v === "store" || v === "auto") out.source = v; }
    else if (a === "--days") out.days = Number(argv[++i]) || 59;
    else if (a === "--max-names") out.maxNames = Number(argv[++i]) || 1500;
    else if (a === "--slippage-bps") out.slipBps = Number(argv[++i]) || 0;
    else if (a === "--out") out.out = argv[++i] ?? out.out;
    else if (a === "--min-dollar-vol") out.minDollarVol = Number(argv[++i]) || 1e9;
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
function replay(symbol: string, s: Session, direction: "LONG" | "SHORT", gapPct: number, atr: number, slip: number): GapGoTrade | null {
  if (s.pre.length === 0 || s.rth.length < 3) return null;
  const pmHigh = Math.max(...s.pre.map((b) => b.high));
  const pmLow = Math.min(...s.pre.map((b) => b.low));
  const open = s.rth[0].open;
  if (direction === "LONG" ? open > pmHigh * (1 + OPEN_CHASE_PCT / 100) : open < pmLow * (1 - OPEN_CHASE_PCT / 100)) return null;
  return simulate(symbol, s.date, direction, gapPct, false, s.rth, pmHigh, pmLow, atr, slip);
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
      if (d.date < windowStart || !(prev.close > 0) || !(d.high > d.low)) continue;
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
    if (t) trades.push({ ...t, dir: ev.dir, gapBucket: bucket(gap, [0, 3, 10]) });
  }
  ctx.say(`  day 2: ${events.length - noPm} with pre-market prints (${noPm} without), gap in the day-1 direction ${gaps.length ? (gapsUp / gaps.length * 100).toFixed(0) : "n/a"}%, median gap in that direction ${median(gaps).toFixed(2)}%`);
  report(ctx, "long, all", trades.filter((t) => t.dir === "LONG"), true);
  for (const b of ["<0", "0-3", "3-10", "10+"]) report(ctx, `long, gap ${b}%`, trades.filter((t) => t.dir === "LONG" && t.gapBucket === b));
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
  const rows: { t: GapGoTrade; above20: boolean; sectorGreen: boolean | null }[] = [];
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
      if (s.pre.length === 0) continue;
      const prior = days[i - 1].close;
      const pmLast = s.pre[s.pre.length - 1].close;
      const gap = (pmLast / prior - 1) * 100;
      if (gap < 2) continue;
      const atr = atrOf(days, i - 1); const h20 = high20(days, i);
      if (atr === null || h20 === null) continue;
      const sg = etfGap(sectorFor(sym), s.date, sessions[i - 1].date);
      const t = replay(sym, s, "LONG", gap, atr, ctx.slip);
      if (t) rows.push({ t, above20: pmLast > h20, sectorGreen: sg === null ? null : sg > 0 });
    }
  }
  ctx.say(`  ${rows.length} rule entries from gaps >= 2%`);
  for (const min of [2, 3, 4]) {
    report(ctx, `gap >= ${min}%, any structure`, rows.filter((r) => r.t.gapPct >= min).map((r) => r.t));
    report(ctx, `gap >= ${min}%, above the 20-day high`, rows.filter((r) => r.t.gapPct >= min && r.above20).map((r) => r.t));
    report(ctx, `gap >= ${min}%, above the 20-day high, sector green (the AMD specification)`, rows.filter((r) => r.t.gapPct >= min && r.above20 && r.sectorGreen === true).map((r) => r.t), min === 3);
  }
}

// ----- T3: earnings gap-and-go -----
async function theoryT3(ctx: Ctx): Promise<void> {
  ctx.say(`\n===== T3 Earnings gap-and-go: names on the Nasdaq calendar that gap 5%+ on the report session (report date, else the next session); the gap rule in the gap's direction =====`);
  const spy = await ctx.intraday("SPY", true);
  if (!spy) { ctx.say("  no SPY bars; cannot enumerate sessions"); return; }
  const sessions = sessionsOf(spy).map((s) => s.date);
  const universe = new Set(ctx.entries.slice(0, ctx.args.maxNames).map((e) => e.symbol));
  const trades: (GapGoTrade & { bucket: string })[] = [];
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
        const t = replay(r.symbol, ss[idx], gap > 0 ? "LONG" : "SHORT", gap, atr, ctx.slip);
        if (t) trades.push({ ...t, bucket: bucket(gap, [10]) });
        break;
      }
    }
    if ((i + 1) % 10 === 0) process.stdout.write(`  ${i + 1}/${sessions.length} sessions, ${reporters} reporters, ${withGap} gaps >= 5%\n`);
  }
  ctx.say(`  ${reporters} reporters in the universe over ${sessions.length} sessions; ${withGap} gapped 5%+ (${noBars} without bars)`);
  report(ctx, "long, all earnings gaps", trades.filter((t) => t.direction === "LONG"), true);
  report(ctx, "long, gap 5-10%", trades.filter((t) => t.direction === "LONG" && t.bucket === "<10"));
  report(ctx, "long, gap 10%+", trades.filter((t) => t.direction === "LONG" && t.bucket === "10+"), true);
  report(ctx, "short, all earnings gaps", trades.filter((t) => t.direction === "SHORT"), true);
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
      if (next.pre.length === 0) continue;
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
  report(ctx, "short (after-hours down), all", rows.filter((r) => r.ah < 0).map((r) => r.t), true);
  report(ctx, "short, gap still down at 09:25", rows.filter((r) => r.ah < 0 && r.held).map((r) => r.t));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  setLogLevel("error");
  const uni = loadUniverse();
  if (!uni) throw new Error("no universe file; run npm run universe:build");
  const ctx = new Ctx(args, uni.entries);
  const today = etParts(ctx.now).date;
  const ids = args.id === "ALL" ? ["T1", "T2", "T3", "T4"] : [args.id];
  ctx.say(`Theory tests ${today}: source ${args.source}, window ${args.days} days (Yahoo) or the store, slippage ${args.slipBps} bps/side, universe ${uni.entries.length} names (built ${uni.builtAt.slice(0, 10)})`);
  ctx.say(`Rule: first 5-minute close beyond the pre-market extreme (09:30 candle included) confirms; entry at the next candle's open; no signal after 11:30; skip if the open is ${OPEN_CHASE_PCT}% beyond the extreme; stop on a 5-minute close through the 09:30 candle's opposite extreme; half at 1 ATR, rest at 1.5 ATR; time exit 15:45. Pass: n >= 30, exp > 0, PF >= 1.3, both date halves positive.`);
  const started = Date.now();
  for (const id of ids) {
    ctx.currentId = id;
    if (id === "T1") await theoryT1(ctx);
    else if (id === "T2") await theoryT2(ctx);
    else if (id === "T3") await theoryT3(ctx);
    else if (id === "T4") await theoryT4(ctx);
    else ctx.say(`unknown theory ${id}`);
  }
  ctx.say(`\n${((Date.now() - started) / 60_000).toFixed(1)} min`);
  fs.mkdirSync(args.out, { recursive: true });
  const file = path.join(args.out, `theory-${ids.join("").toLowerCase()}-${today}-${args.source}.txt`);
  fs.writeFileSync(file, ctx.lines.join("\n") + "\n");
  process.stdout.write(`written: ${file}\n`);
  // Headline stats for the night list (docs/results/theories.json), merged by theory id.
  const jsonFile = path.join(args.out, "theories.json");
  let existing: Headline[] = [];
  try { if (fs.existsSync(jsonFile)) existing = JSON.parse(fs.readFileSync(jsonFile, "utf-8")) as Headline[]; } catch { existing = []; }
  const merged = [...existing.filter((h) => !ids.includes(h.id)), ...ctx.headlines];
  fs.writeFileSync(jsonFile, JSON.stringify(merged, null, 2) + "\n");
}

main().catch((err) => {
  process.stderr.write(`theory-cli failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
