// Gap-and-go rule replay shared by the registered backtests
// (gap-and-go-cli.ts) and the theory tests (theory-cli.ts). The rule as
// registered in docs/gap-and-go-registration-2026-09-21.md: the first
// 5-minute candle (09:30 included) that closes beyond the pre-market extreme
// confirms; entry at the next candle's open; no signal after 11:30; stop on a
// 5-minute close through the 09:30 candle's opposite extreme; half at 1 ATR,
// rest at 1.5 ATR; time exit 15:45.

import type { Bar } from "../core/types.js";
import { etParts } from "../utils/time.js";

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

export const OPEN_MIN = 9 * 60 + 30;
export const LAST_SIGNAL_MIN = 11 * 60 + 30;
export const TIME_EXIT_MIN = 15 * 60 + 45;
export const OPEN_CHASE_PCT = 1.5;

export function simulate(symbol: string, date: string, direction: "LONG" | "SHORT", gapPct: number, above52w: boolean, rth: readonly Bar[], pmHigh: number, pmLow: number, atr: number, slip: number): GapGoTrade | null {
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

export function groupByDate(bars: readonly Bar[]): Map<string, Bar[]> {
  const m = new Map<string, Bar[]>();
  for (const b of bars) { const d = etParts(b.timestamp).date; m.set(d, [...(m.get(d) ?? []), b]); }
  for (const list of m.values()) list.sort((a, b) => a.timestamp - b.timestamp);
  return m;
}

export function averageTrueRange(bars: readonly Bar[], n: number): number {
  const tr: number[] = [];
  for (let i = bars.length - n; i < bars.length; i++) {
    const pc = bars[i - 1].close;
    tr.push(Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - pc), Math.abs(bars[i].low - pc)));
  }
  return tr.reduce((s, x) => s + x, 0) / tr.length;
}

export function minutesEt(ts: number): number { const p = etParts(ts); return p.hour * 60 + p.minute; }
export function hhmm(ts: number): string { const p = etParts(ts); return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`; }
