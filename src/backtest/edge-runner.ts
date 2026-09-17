// Four frozen directional hypotheses; no option prices, order path or broker access.
import type { Bar } from "../core/types.js";
import { etParts } from "../utils/time.js";
import { validateBars } from "./manual-runner.js";
import { FROZEN_EDGE_DEFINITION } from "./edge-definition.js";
import type { EdgeCosts, EdgeDirection, EdgeEvent, EdgeFamily, EdgeResult, EdgeSessionResult, EdgeTrade } from "./edge-types.js";

interface Observation { readonly bar: Bar; readonly vwap: number; }
interface State {
  high: number;
  low: number;
  openingBars: number;
  previousCloseTime: number;
  priceVolume: number;
  volume: number;
  broken: boolean;
  signaled: boolean;
  history: Observation[];
}
interface Signal {
  readonly symbol: string;
  readonly session: string;
  readonly direction: EdgeDirection;
  readonly knownAt: number;
  readonly signalBarStart: number;
  readonly close: number;
  readonly vwap: number;
  readonly stop: number;
  readonly orHigh: number;
  readonly orLow: number;
}
interface Held {
  readonly signal: Signal;
  readonly entryTime: number;
  readonly entryRaw: number;
  readonly entryPrice: number;
  readonly quantity: number;
  readonly target: number;
  readonly plannedLossAtStop: number;
  lastCloseTime: number;
  lastMark: number;
}

function directionSign(direction: EdgeDirection): 1 | -1 { return direction === "LONG" ? 1 : -1; }

function detectSignal(family: EdgeFamily, state: State, current: Observation, time: number, session: string): Signal | null {
  const h = FROZEN_EDGE_DEFINITION.settings;
  const b = current.bar;
  const previous = state.history[state.history.length - 1];
  const prior = state.history[state.history.length - 2];
  let direction: EdgeDirection | null = null;
  let stop = NaN;
  if (family === "opening-range-continuation") {
    if (b.close > state.high && b.close > current.vwap) { direction = "LONG"; stop = state.low; }
    else if (b.close < state.low && b.close < current.vwap) { direction = "SHORT"; stop = state.high; }
  } else if (family === "failed-opening-range-breakout" && previous) {
    if (b.close >= state.low && b.close <= state.high) {
      if (previous.bar.close > state.high) { direction = "SHORT"; stop = previous.bar.high + h.failureStopBuffer; }
      else if (previous.bar.close < state.low) { direction = "LONG"; stop = previous.bar.low - h.failureStopBuffer; }
    }
  } else if (family === "vwap-trend-pullback" && previous && prior) {
    if (previous.bar.close > previous.vwap && prior.bar.close > prior.vwap && current.vwap > previous.vwap && b.low <= current.vwap && b.close > current.vwap) direction = "LONG";
    else if (previous.bar.close < previous.vwap && prior.bar.close < prior.vwap && current.vwap < previous.vwap && b.high >= current.vwap && b.close < current.vwap) direction = "SHORT";
  } else if (family === "vwap-overextension-reversal" && previous && prior) {
    const extension = (previous.bar.close - previous.vwap) / previous.vwap * 100;
    const priceMove = (b.close - previous.bar.close) / previous.bar.close * 100;
    const distanceShrank = Math.abs(b.close - current.vwap) < Math.abs(previous.bar.close - previous.vwap);
    if (distanceShrank && extension >= h.reversalMinimumPriorDistancePct && priceMove <= -h.reversalMinimumPriceMovePct && b.close > current.vwap) direction = "SHORT";
    else if (distanceShrank && extension <= -h.reversalMinimumPriorDistancePct && priceMove >= h.reversalMinimumPriceMovePct && b.close < current.vwap) direction = "LONG";
  }
  if (!direction) return null;
  if (!Number.isFinite(stop) && previous && prior) {
    stop = direction === "LONG" ? Math.min(prior.bar.low, previous.bar.low, b.low) : Math.max(prior.bar.high, previous.bar.high, b.high);
  }
  if (!Number.isFinite(stop) || stop <= 0) return null;
  return { symbol: b.symbol, session, direction, knownAt: time, signalBarStart: b.timestamp,
    close: b.close, vwap: current.vwap, stop, orHigh: state.high, orLow: state.low };
}

export function runEdgeHypothesis(input: readonly Bar[], family: EdgeFamily, costOverrides: Partial<EdgeCosts> = {}): EdgeResult {
  if (!FROZEN_EDGE_DEFINITION.families.includes(family)) throw new Error("Unregistered edge family");
  if (!costOverrides || typeof costOverrides !== "object" || Array.isArray(costOverrides) ||
      Object.keys(costOverrides).some((key) => !["slippageBpsPerSide", "minimumSlippagePerShare", "feePerOrder"].includes(key))) throw new Error("Only cost stress overrides are supported; no strategy parameter search");
  const costs: EdgeCosts = { ...FROZEN_EDGE_DEFINITION.costs, ...costOverrides };
  if (Object.values(costs).some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0)) throw new Error("Invalid cost scenario");
  const h = FROZEN_EDGE_DEFINITION.settings;
  if (2 * costs.feePerOrder >= h.plannedRisk) throw new Error("Round-trip fees consume the planned risk allowance");
  validateBars(input);
  const interval = h.intervalMinutes * 60_000;
  const bars = input.filter((b) => {
    const p = etParts(b.timestamp), minute = p.hour * 60 + p.minute;
    return p.dayOfWeek > 0 && p.dayOfWeek < 6 && minute >= h.openingStart && minute < 960;
  }).sort((a, b) => a.timestamp - b.timestamp || a.symbol.localeCompare(b.symbol));
  const opens = new Map<number, Bar[]>(), closes = new Map<number, Bar[]>();
  for (const b of bars) {
    if (b.timestamp % interval !== 0) throw new Error(`Misaligned five-minute bar ${b.symbol}:${b.timestamp}`);
    opens.set(b.timestamp, [...(opens.get(b.timestamp) ?? []), b]);
    closes.set(b.timestamp + interval, [...(closes.get(b.timestamp + interval) ?? []), b]);
  }
  const timeline = [...new Set([...opens.keys(), ...closes.keys()])].sort((a, b) => a - b);
  const states = new Map<string, State>(), pending = new Map<string, Signal>();
  const dates = [...new Set(bars.map((b) => etParts(b.timestamp).date))].sort();
  const trades: EdgeTrade[] = [], events: EdgeEvent[] = [], issues: string[] = [];
  let held: Held | null = null;
  let unresolved: EdgeResult["unresolvedPosition"] = null;
  let equity: number = h.startingEquity;
  let dayStart: number = equity;
  let currentSession = "";
  let peak: number = equity;
  let drawdown = 0;
  const slip = (price: number): number => Math.max(costs.minimumSlippagePerShare, price * costs.slippageBpsPerSide / 10_000);
  const emit = (time: number, symbol: string, type: EdgeEvent["type"], detail: string): void => {
    events.push({ timestamp: time, session: etParts(time).date, symbol, type, detail });
  };
  const exit = (raw: number, time: number, intervalStart: number, reason: EdgeTrade["reason"]): void => {
    if (!held) throw new Error("Exit attempted without position");
    const p = held, s = p.signal, sign = directionSign(s.direction);
    const price = Math.max(0, raw - sign * slip(raw));
    const gross = sign * (raw - p.entryRaw) * p.quantity;
    const slippage = sign * ((p.entryPrice - p.entryRaw) + (raw - price)) * p.quantity;
    const fees = 2 * costs.feePerOrder;
    const net = gross - slippage - fees;
    equity += net;
    trades.push({ family, symbol: s.symbol, session: s.session, direction: s.direction,
      signalBarStart: s.signalBarStart, signalKnownAt: s.knownAt, signalClose: s.close, signalVwap: s.vwap,
      entryTime: p.entryTime, entryRaw: p.entryRaw, entryPrice: p.entryPrice, quantity: p.quantity,
      stop: s.stop, target: p.target, plannedLossAtStop: p.plannedLossAtStop,
      exitTime: time, exitIntervalStart: intervalStart, exitRaw: raw, exitPrice: price, reason,
      grossPnl: gross, slippageCost: slippage, fees, netPnl: net });
    emit(time, s.symbol, "exit", `${reason}; net=${net.toFixed(6)}`);
    held = null;
  };
  for (const time of timeline) {
    const ep = etParts(time), minute = ep.hour * 60 + ep.minute;
    if (ep.date !== currentSession) {
      currentSession = ep.date;
      dayStart = equity;
      states.clear(); pending.clear();
    }
    for (const b of closes.get(time) ?? []) {
      const bp = etParts(b.timestamp), startMinute = bp.hour * 60 + bp.minute;
      if (held && held.signal.symbol === b.symbol && held.entryTime <= b.timestamp) {
        const long = held.signal.direction === "LONG";
        const stopped = long ? b.low <= held.signal.stop : b.high >= held.signal.stop;
        const targeted = long ? b.high >= held.target : b.low <= held.target;
        if (stopped) exit(held.signal.stop, time, b.timestamp, targeted ? "ambiguous-stop-first" : "stop");
        else if (targeted) exit(held.target, time, b.timestamp, "target");
        else { held.lastCloseTime = time; held.lastMark = b.close; }
      }
      // Only the morning signal window requires continuity for strategy selection.
      if (startMinute >= h.entryCutoff) continue;
      let state = states.get(b.symbol);
      if (!state) {
        state = { high: -Infinity, low: Infinity, openingBars: 0, previousCloseTime: b.timestamp,
          priceVolume: 0, volume: 0, broken: startMinute !== h.openingStart, signaled: false, history: [] };
        states.set(b.symbol, state);
        if (state.broken) issues.push(`${bp.date}:${b.symbol}:session does not start at09:30`);
      }
      if (state.previousCloseTime !== b.timestamp) {
        state.broken = true;
        const issue = `${bp.date}:${b.symbol}:missing interval before${new Date(b.timestamp).toISOString()}`;
        issues.push(issue); emit(time, b.symbol, "data-gap", issue);
      }
      state.previousCloseTime = time;
      state.priceVolume += (b.high + b.low + b.close) / 3 * b.volume;
      state.volume += b.volume;
      const vwap = state.volume > 0 ? state.priceVolume / state.volume : NaN;
      if (!Number.isFinite(vwap)) {
        state.broken = true; issues.push(`${bp.date}:${b.symbol}:VWAP unavailable from zero cumulative volume`);
      }
      if (startMinute < h.openingEnd) {
        state.high = Math.max(state.high, b.high); state.low = Math.min(state.low, b.low); state.openingBars++;
      }
      const current = { bar: b, vwap };
      if (!state.broken && !state.signaled && state.openingBars === 3 && minute >= h.firstSignalKnownMinute && minute <= h.lastSignalKnownMinute) {
        const signal = detectSignal(family, state, current, time, bp.date);
        if (signal) {
          state.signaled = true; pending.set(b.symbol, signal);
          emit(time, b.symbol, "signal", `${signal.direction}; stop=${signal.stop}; close=${signal.close}; VWAP=${signal.vwap}`);
        }
      }
      state.history.push(current);
      if (state.history.length > 2) state.history.shift();
    }
    const starts = opens.get(time) ?? [];
    const activeBar = held ? starts.find((b) => b.symbol === held!.signal.symbol) : undefined;
    if (held && !activeBar) {
      unresolved = { symbol: held.signal.symbol, session: held.signal.session, entryTime: held.entryTime, detectedAt: time,
        reason: "No contiguous next held-position bar; intrabar exit path unknown" };
      issues.push(`${held.signal.session}:${held.signal.symbol}:held-position missing next observation`);
      emit(time, held.signal.symbol, "data-gap", unresolved.reason);
      break;
    }
    if (held && activeBar) {
      if (held.lastCloseTime !== time) throw new Error("Internal chronology violation for held position");
      if (minute >= h.exitMinute) exit(activeBar.open, time, time, "time");
      else {
        const long = held.signal.direction === "LONG";
        if (long ? activeBar.open <= held.signal.stop : activeBar.open >= held.signal.stop) exit(activeBar.open, time, time, "gap-stop");
        else if (long ? activeBar.open >= held.target : activeBar.open <= held.target) exit(held.target, time, time, "target");
      }
    }
    for (const b of starts) {
      const signal = pending.get(b.symbol);
      if (!signal) continue;
      pending.delete(b.symbol);
      const sign = directionSign(signal.direction);
      const price = b.open + sign * slip(b.open);
      const stopDistance = sign * (price - signal.stop);
      const stopPct = stopDistance / b.open * 100;
      const plannedBudget = Math.min(h.plannedRisk, Math.max(0, h.dailyLossLimit + equity - dayStart));
      let refusal = "";
      if (signal.knownAt !== time) refusal = "Missing immediate next bar; expired signal";
      else if (held) refusal = "Shared portfolio position already open";
      else if (dayStart - equity >= h.dailyLossLimit) refusal = "Realized daily loss limit reached";
      else if (plannedBudget <= 2 * costs.feePerOrder) refusal = "Remaining daily allowance cannot cover round-trip fees";
      else if (minute >= h.entryCutoff) refusal = "Entry cutoff reached";
      else if (price <= 0 || stopPct < h.minimumStopPct || stopPct > h.maximumStopPct) refusal = "Directional stop distance outside frozen bounds";
      else if (family === "opening-range-continuation") {
        const boundary = signal.direction === "LONG" ? signal.orHigh : signal.orLow;
        const extension = sign * (b.open - boundary);
        if (extension <= 0 || extension > h.continuationMaximumExtensionR * (signal.orHigh - signal.orLow)) refusal = "Opening-range continuation extension cap";
      }
      if (refusal) { emit(time, b.symbol, "rejected", refusal); continue; }
      const riskPerShare = stopDistance + slip(signal.stop);
      const qty = Math.floor(Math.min((plannedBudget - 2 * costs.feePerOrder) / riskPerShare,
        h.maxNotional / price, (equity - costs.feePerOrder) / price));
      const target = price + sign * h.targetR * stopDistance;
      if (qty < 1 || target <= 0) { emit(time, b.symbol, "rejected", "No affordable integer quantity or valid target"); continue; }
      held = { signal, entryTime: time, entryRaw: b.open, entryPrice: price, quantity: qty, target,
        plannedLossAtStop: qty * riskPerShare + 2 * costs.feePerOrder, lastCloseTime: time, lastMark: b.open };
      emit(time, b.symbol, "entry", `${signal.direction}; qty=${qty}; next-open=${price.toFixed(6)}`);
    }
    for (const [symbol, signal] of pending) {
      if (signal.knownAt <= time) { pending.delete(symbol); emit(time, symbol, "rejected", "Missing immediate next bar; expired signal"); }
    }
    const liquidation = held ? equity + (directionSign(held.signal.direction) * (held.lastMark - held.entryPrice) - slip(held.lastMark)) * held.quantity - 2 * costs.feePerOrder : equity;
    peak = Math.max(peak, liquidation); drawdown = Math.max(drawdown, peak - liquidation);
  }
  // Post-run coverage audit only: never use future completeness to select a signal.
  // Qualification requires each observed symbol/session from09:30 through11:30 open.
  const coverage = new Map<string, Set<number>>();
  for (const b of bars) {
    const p = etParts(b.timestamp), key = `${p.date}:${b.symbol}`;
    const minutes = coverage.get(key) ?? new Set<number>();
    minutes.add(p.hour * 60 + p.minute); coverage.set(key, minutes);
  }
  for (const [key, minutes] of coverage) {
    const missing: number[] = [];
    for (let minute = h.openingStart; minute <= h.exitMinute; minute += h.intervalMinutes) if (!minutes.has(minute)) missing.push(minute);
    if (missing.length) issues.push(`${key}:coverage missing ET minutes ${missing.join(",")}`);
  }
  const sum = (field: "netPnl" | "grossPnl" | "fees" | "slippageCost", rows: readonly EdgeTrade[] = trades): number => rows.reduce((n, t) => n + t[field], 0);
  const sessions: EdgeSessionResult[] = dates.map((session) => {
    const rows = trades.filter((t) => t.session === session);
    const complete = !issues.some((issue) => issue.startsWith(`${session}:`)) && (!unresolved || session < unresolved.session);
    return { session, tradeCount: rows.length, grossPnl: sum("grossPnl", rows), slippageCost: sum("slippageCost", rows),
      fees: sum("fees", rows), netPnl: complete ? sum("netPnl", rows) : null, complete };
  });
  const loss = -trades.filter((t) => t.netPnl < 0).reduce((n, t) => n + t.netPnl, 0);
  const gain = trades.filter((t) => t.netPnl > 0).reduce((n, t) => n + t.netPnl, 0);
  return { label: "UNDERLYING_DIRECTION_DIAGNOSTIC_NOT_OPTIONS_PNL", definitionVersion: FROZEN_EDGE_DEFINITION.version,
    family, costs, shortsAreHypothetical: true, stockBorrowAndMarginModeled: false, bars: bars.length, sessionDates: dates,
    sessions, trades, events, dataQualityIssues: issues, unresolvedPosition: unresolved,
    eligibleForRanking: dates.length > 0 && !unresolved && issues.length === 0, startingEquity: h.startingEquity,
    endingRealizedEquity: equity, completedNetPnl: sum("netPnl"), netPnl: unresolved || issues.length ? null : sum("netPnl"),
    grossPnl: sum("grossPnl"), slippageCost: sum("slippageCost"), fees: sum("fees"),
    winRate: trades.length ? trades.filter((t) => t.netPnl > 0).length / trades.length : null,
    profitFactor: loss > 0 ? gain / loss : null, maxFiveMinuteLiquidationDrawdown: drawdown };
}
