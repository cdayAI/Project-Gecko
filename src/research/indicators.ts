// Pure functions over daily bars. No I/O.

import type { Bar } from "../core/types.js";
import type { DailyStats, Provenance, UnderlyingSnapshot } from "./types.js";

export function atr(bars: readonly Bar[], period = 14): number {
  if (bars.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], p = bars[i - 1];
    trs.push(Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close)));
  }
  const n = Math.min(period, trs.length);
  const slice = trs.slice(-n);
  return slice.reduce((s, x) => s + x, 0) / n;
}

export function smaClose(bars: readonly Bar[], period: number): number {
  if (bars.length === 0) return 0;
  const n = Math.min(period, bars.length);
  const slice = bars.slice(-n);
  return slice.reduce((s, b) => s + b.close, 0) / n;
}

export function avgVolume(bars: readonly Bar[], period: number): number {
  if (bars.length === 0) return 0;
  const n = Math.min(period, bars.length);
  const slice = bars.slice(-n);
  return slice.reduce((s, b) => s + b.volume, 0) / n;
}

// Build DailyStats from bars plus today's snapshot. `bars` may or may not
// include today's bar; we detect that by comparing the last bar's date to
// the snapshot's session and exclude it from averages when it is today.
export function computeDailyStats(snapshot: UnderlyingSnapshot, barsInput: readonly Bar[], todayIsoDate: string, provenance: Provenance): DailyStats | null {
  if (barsInput.length < 5) return null;
  const bars = [...barsInput].sort((a, b) => a.timestamp - b.timestamp);
  const lastBarDate = new Date(bars[bars.length - 1].timestamp).toISOString().slice(0, 10);
  const history = lastBarDate === todayIsoDate ? bars.slice(0, -1) : bars;
  if (history.length < 5) return null;

  const a = atr(history, 14);
  const last = snapshot.last;
  const av20 = avgVolume(history, 20);
  const prevClose = snapshot.prevClose > 0 ? snapshot.prevClose : history[history.length - 1].close;
  const gapPct = snapshot.open > 0 && prevClose > 0 ? ((snapshot.open - prevClose) / prevClose) * 100 : 0;
  const range = snapshot.high - snapshot.low;
  const rangePositionPct = range > 0 ? Math.max(0, Math.min(100, ((last - snapshot.low) / range) * 100)) : 50;
  // 52-week extremes: prefer the snapshot's own values, else derive from
  // the bars when we have roughly a year of them.
  const yearBars = history.slice(-252);
  const hi52 = snapshot.fiftyTwoWeekHigh ?? (yearBars.length >= 200 ? Math.max(...yearBars.map((b) => b.high), snapshot.high) : undefined);
  const lo52 = snapshot.fiftyTwoWeekLow ?? (yearBars.length >= 200 ? Math.min(...yearBars.map((b) => b.low), snapshot.low > 0 ? snapshot.low : Infinity) : undefined);
  const pos52 = typeof hi52 === "number" && typeof lo52 === "number" && hi52 > lo52 ? Math.max(0, Math.min(100, ((last - lo52) / (hi52 - lo52)) * 100)) : null;
  const last20 = history.slice(-20);

  return {
    symbol: snapshot.symbol,
    bars: history.length,
    atr14: a,
    atrPct: last > 0 ? (a / last) * 100 : 0,
    avgVolume20: av20,
    relativeVolume: av20 > 0 ? snapshot.volume / av20 : 0,
    sma20: smaClose(history, 20),
    sma50: smaClose(history, 50),
    high20: Math.max(...last20.map((b) => b.high)),
    low20: Math.min(...last20.map((b) => b.low)),
    gapPct,
    rangePositionPct,
    fiftyTwoWeekPositionPct: pos52,
    provenance,
  };
}
