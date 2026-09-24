// Causal, long-only underlying hypothesis diagnostic. Never estimates option P&L.
import type { Bar } from "../core/types.js";
import { etParts } from "../utils/time.js";
import type { ManualEvent, ManualHypothesis, ManualResult, ManualTrade } from "./manual-types.js";

export const DEFAULT_MANUAL_HYPOTHESIS: ManualHypothesis = Object.freeze({
  version: "underlying-orb-v1", intervalMinutes: 5, startingCash: 5_000,
  maxNotional: 1_000, plannedRisk: 25, dailyLossLimit: 50,
  openingStart: 570, openingEnd: 585, entryCutoff: 660, exitMinute: 690,
  minimumRangePct: 0.1, maximumRangePct: 5, maximumEntryExtensionR: 0.25,
  rewardR: 2, slippageBpsPerSide: 2, minimumSlippagePerShare: 0.005, feePerOrder: 1,
});

interface SessionState {
  readonly date: string;
  high: number;
  low: number;
  openingBars: number;
  lastCloseTime: number;
  broken: boolean;
  signaled: boolean;
}
interface Pending {
  readonly symbol: string;
  readonly time: number;
  readonly signalBarStart: number;
  readonly high: number;
  readonly low: number;
}
interface Position {
  readonly symbol: string;
  readonly session: string;
  readonly signalBarStart: number;
  readonly signalKnownAt: number;
  readonly entryTime: number;
  readonly entryRaw: number;
  readonly entryPrice: number;
  readonly quantity: number;
  readonly stop: number;
  readonly target: number;
  readonly plannedLossAtStop: number;
  lastCloseTime: number;
  lastClose: number;
}

export function validateBars(input: readonly Bar[]): void {
  const keys = new Set<string>();
  for (const b of input) {
    if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(b.symbol) ||
        ![b.timestamp, b.open, b.high, b.low, b.close, b.volume].every(Number.isFinite) ||
        b.timestamp <= 0 || !Number.isInteger(b.timestamp) || b.open <= 0 || b.low <= 0 ||
        b.high < Math.max(b.open, b.close, b.low) || b.low > Math.min(b.open, b.close) ||
        b.volume < 0) throw new Error(`Invalid bar: ${b.symbol} at ${b.timestamp}`);
    const key = `${b.symbol}:${b.timestamp}`;
    if (keys.has(key)) throw new Error(`Duplicate bar: ${key}`);
    keys.add(key);
  }
}

export function validateHypothesis(h: ManualHypothesis): void {
  const numeric: readonly (keyof ManualHypothesis)[] = ["startingCash", "maxNotional", "plannedRisk", "dailyLossLimit",
    "openingStart", "openingEnd", "entryCutoff", "exitMinute", "minimumRangePct", "maximumRangePct",
    "maximumEntryExtensionR", "rewardR", "slippageBpsPerSide", "minimumSlippagePerShare", "feePerOrder"];
  if (h.version !== "underlying-orb-v1" || h.intervalMinutes !== 5 ||
      numeric.some((key) => typeof h[key] !== "number" || !Number.isFinite(h[key])) ||
      h.startingCash <= 0 || h.maxNotional <= 0 || h.plannedRisk <= 2 * h.feePerOrder ||
      h.dailyLossLimit <= 0 || h.rewardR <= 0 || h.minimumRangePct < 0 ||
      h.maximumRangePct < h.minimumRangePct || h.maximumEntryExtensionR < 0 ||
      h.slippageBpsPerSide < 0 || h.minimumSlippagePerShare < 0 || h.feePerOrder < 0 ||
      h.openingStart !== 570 || h.openingEnd !== 585 ||
      h.entryCutoff <= h.openingEnd + 5 || h.exitMinute <= h.entryCutoff || h.exitMinute >= 960 ||
      h.entryCutoff % 5 !== 0 || h.exitMinute % 5 !== 0) throw new Error("Invalid fixed ORB hypothesis configuration");
}

export function runManualHypothesis(input: readonly Bar[], h: ManualHypothesis = DEFAULT_MANUAL_HYPOTHESIS): ManualResult {
  validateHypothesis(h);
  validateBars(input);
  const interval = h.intervalMinutes * 60_000;
  const bars = input.filter((b) => {
    const p = etParts(b.timestamp);
    const minute = p.hour * 60 + p.minute;
    return p.dayOfWeek > 0 && p.dayOfWeek < 6 && minute >= h.openingStart && minute < 960;
  }).sort((a, b) => a.timestamp - b.timestamp || a.symbol.localeCompare(b.symbol));
  for (const b of bars) {
    if (b.timestamp % interval !== 0) throw new Error(`Bar is not aligned to five minutes: ${b.symbol} ${b.timestamp}`);
  }
  const opening = new Map<number, Bar[]>();
  const closing = new Map<number, Bar[]>();
  for (const b of bars) {
    opening.set(b.timestamp, [...(opening.get(b.timestamp) ?? []), b]);
    closing.set(b.timestamp + interval, [...(closing.get(b.timestamp + interval) ?? []), b]);
  }
  const timeline = [...new Set([...opening.keys(), ...closing.keys()])].sort((a, b) => a - b);
  const states = new Map<string, SessionState>();
  const pending = new Map<string, Pending>();
  const trades: ManualTrade[] = [];
  const events: ManualEvent[] = [];
  const dates = new Set<string>();
  let position: Position | null = null;
  let cash = h.startingCash;
  let realized = h.startingCash;
  let peak = h.startingCash;
  let drawdown = 0;
  let date = "";
  let dayStartEquity = h.startingCash;
  const slip = (price: number): number => Math.max(h.minimumSlippagePerShare, price * h.slippageBpsPerSide / 10_000);
  const event = (timestamp: number, symbol: string, type: string, detail: string): void => { events.push({ timestamp, symbol, type, detail }); };
  const closePosition = (raw: number, time: number, intervalStart: number, reason: ManualTrade["reason"]): void => {
    if (!position) throw new Error("Exit without an active position");
    const p = position;
    const price = Math.max(0, raw - slip(raw));
    const gross = (raw - p.entryRaw) * p.quantity;
    const slippage = ((p.entryPrice - p.entryRaw) + (raw - price)) * p.quantity;
    const fees = 2 * h.feePerOrder;
    const net = gross - slippage - fees;
    cash += price * p.quantity - h.feePerOrder;
    realized += net;
    trades.push({ ...p, exitTime: time, exitIntervalStart: intervalStart, direction: "LONG",
      exitRaw: raw, exitPrice: price, grossPnl: gross, slippageCost: slippage, fees, netPnl: net, reason });
    event(time, p.symbol, "exit", `${reason}; net=${net.toFixed(6)}`);
    position = null;
  };
  for (const time of timeline) {
    const ep = etParts(time);
    const minute = ep.hour * 60 + ep.minute;
    if (ep.date !== date) {
      date = ep.date;
      dayStartEquity = realized;
      states.clear();
      pending.clear();
    }
    // A bar's high/low/close become available only at its closing boundary.
    // Intrabar exits are timestamped at that boundary because their exact time is unknown.
    for (const b of closing.get(time) ?? []) {
      const bp = etParts(b.timestamp);
      const barMinute = bp.hour * 60 + bp.minute;
      dates.add(bp.date);
      if (position && position.symbol === b.symbol && position.entryTime <= b.timestamp) {
        const stopHit = b.low <= position.stop;
        const targetHit = b.high >= position.target;
        if (stopHit) closePosition(position.stop, time, b.timestamp, targetHit ? "ambiguous-stop-first" : "stop");
        else if (targetHit) closePosition(position.target, time, b.timestamp, "target");
        else { position.lastClose = b.close; position.lastCloseTime = time; }
      }
      let state = states.get(b.symbol);
      if (!state) {
        state = { date: bp.date, high: -Infinity, low: Infinity, openingBars: 0,
          lastCloseTime: b.timestamp, broken: barMinute !== h.openingStart, signaled: false };
        states.set(b.symbol, state);
      }
      if (state.lastCloseTime !== b.timestamp) {
        state.broken = true;
        event(time, b.symbol, "data-gap", "Noncontiguous bars; new signals disabled for this session");
      }
      state.lastCloseTime = time;
      if (barMinute < h.openingEnd) {
        state.high = Math.max(state.high, b.high);
        state.low = Math.min(state.low, b.low);
        state.openingBars++;
        continue;
      }
      const width = state.high - state.low;
      const widthPct = width / ((state.high + state.low) / 2) * 100;
      if (!state.signaled && !state.broken && state.openingBars === 3 && minute < h.entryCutoff &&
          widthPct >= h.minimumRangePct && widthPct <= h.maximumRangePct && b.close > state.high) {
        state.signaled = true;
        pending.set(b.symbol, { symbol: b.symbol, time, signalBarStart: b.timestamp, high: state.high, low: state.low });
        event(time, b.symbol, "signal", "First completed five-minute close above completed opening range");
      }
    }
    // Scheduled time exits precede use of the current bar's high/low/close.
    const starts = opening.get(time) ?? [];
    const heldBar = position ? starts.find((b) => b.symbol === position!.symbol) : undefined;
    if (position && heldBar) {
      if (position.lastCloseTime !== time) closePosition(heldBar.open, time, time, "data-gap");
      else if (minute >= h.exitMinute) closePosition(heldBar.open, time, time, "time");
      else if (heldBar.open <= position.stop) closePosition(heldBar.open, time, time, "gap-stop");
      else if (heldBar.open >= position.target) closePosition(position.target, time, time, "target");
    }
    // Sorting by symbol gives a stable tie-break without consulting future outcomes.
    for (const b of starts) {
      const signal = pending.get(b.symbol);
      if (!signal) continue;
      pending.delete(b.symbol);
      let refusal = "";
      if (signal.time !== time) refusal = "No immediate next bar; signal expired";
      else if (position) refusal = "Shared portfolio already holds a position";
      else if (dayStartEquity - realized >= h.dailyLossLimit) refusal = "Realized daily loss limit reached";
      else if (minute >= h.entryCutoff) refusal = "Entry cutoff reached";
      else if (b.open <= signal.high || b.open > signal.high + h.maximumEntryExtensionR * (signal.high - signal.low)) refusal = "Next open outside permitted breakout extension";
      if (refusal) { event(time, b.symbol, "entry-rejected", refusal); continue; }
      const price = b.open + slip(b.open);
      const perShareRisk = price - signal.low + slip(signal.low);
      const quantity = Math.floor(Math.min((h.plannedRisk - 2 * h.feePerOrder) / perShareRisk,
        h.maxNotional / price, (cash - h.feePerOrder) / price));
      if (quantity < 1) { event(time, b.symbol, "entry-rejected", "Insufficient cash/notional/risk allowance for one share"); continue; }
      position = { symbol: b.symbol, session: date, signalBarStart: signal.signalBarStart, signalKnownAt: signal.time,
        entryTime: time, entryRaw: b.open, entryPrice: price, quantity, stop: signal.low,
        target: price + h.rewardR * (price - signal.low),
        plannedLossAtStop: perShareRisk * quantity + 2 * h.feePerOrder,
        lastClose: b.open, lastCloseTime: time };
      cash -= price * quantity + h.feePerOrder;
      event(time, b.symbol, "entry", `next-open; quantity=${quantity}; price=${price.toFixed(6)}`);
    }
    for (const [symbol, signal] of pending) {
      if (signal.time < time) { pending.delete(symbol); event(time, symbol, "entry-rejected", "Missing next bar; signal expired"); }
    }
    const liquidation = position ? cash + Math.max(0, position.lastClose - slip(position.lastClose)) * position.quantity - h.feePerOrder : cash;
    peak = Math.max(peak, liquidation);
    drawdown = Math.max(drawdown, peak - liquidation);
  }
  const sum = (field: "netPnl" | "grossPnl" | "fees" | "slippageCost"): number => trades.reduce((n, t) => n + t[field], 0);
  const wins = trades.filter((t) => t.netPnl > 0);
  const losses = trades.filter((t) => t.netPnl < 0);
  const lossSum = -losses.reduce((n, t) => n + t.netPnl, 0);
  return { label: "UNDERLYING_ONLY_DIAGNOSTIC_NOT_OPTIONS_PNL", bars: bars.length,
    sessionDates: [...dates].sort(), trades, events,
    unresolvedPosition: position ? { symbol: position.symbol, entryTime: position.entryTime } : null,
    startingCash: h.startingCash, endingRealizedEquity: realized, netPnl: sum("netPnl"),
    grossPnl: sum("grossPnl"), fees: sum("fees"), slippageCost: sum("slippageCost"),
    winRate: trades.length ? wins.length / trades.length : null,
    profitFactor: lossSum > 0 ? wins.reduce((n, t) => n + t.netPnl, 0) / lossSum : null,
    maxFiveMinuteLiquidationDrawdown: drawdown, returnPct: sum("netPnl") / h.startingCash * 100 };
}
