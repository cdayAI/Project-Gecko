// Option structure analysis for a candidate.
//
// Given a chain, a directional bias, and a risk budget, enumerate a small
// set of defined-risk structures and price them off the quotes we have.
// Everything is computed from bid/ask; nothing here estimates probability
// of profit or expected value. The output is what a careful trader would
// compute by hand before deciding: cost, worst case, breakeven, spread
// drag, and whether one contract even fits the budget.

import type { OptionQuote, OptionChainSnapshot, OptionStructure, ResearchBudget, StructureKind } from "./types.js";
import { daysBetween } from "./osi.js";

export interface AnalyzeOptions {
  readonly todayIsoDate: string;
  readonly atr: number;                  // underlying ATR in dollars; 0 if unknown
  readonly minDte: number;               // skip expirations closer than this
  readonly maxDte: number;
  readonly maxStructures: number;
}


const DTE_BUCKETS: readonly { label: string; min: number; max: number }[] = [
  { label: "near", min: 1, max: 6 },
  { label: "weekly", min: 7, max: 20 },
  { label: "monthly", min: 21, max: 60 },
];

export function analyzeChain(chain: OptionChainSnapshot, budget: ResearchBudget, opts: AnalyzeOptions): OptionStructure[] {
  const spot = chain.underlyingPrice;
  if (spot <= 0) return [];
  const out: OptionStructure[] = [];
  const usable = chain.contracts.filter((c) => {
    const dte = daysBetween(opts.todayIsoDate, c.expiration);
    return dte >= opts.minDte && dte <= opts.maxDte;
  });
  const expirations = [...new Set(usable.map((c) => c.expiration))].sort();

  // Pick one expiration per DTE bucket: the most liquid one (by total open
  // interest) inside the bucket, so monthlies win over odd weeklies.
  const oiByExp = new Map<string, number>();
  for (const c of usable) oiByExp.set(c.expiration, (oiByExp.get(c.expiration) ?? 0) + c.openInterest);
  const chosen: string[] = [];
  for (const b of DTE_BUCKETS) {
    const inBucket = expirations.filter((x) => { const d = daysBetween(opts.todayIsoDate, x); return d >= b.min && d <= b.max; });
    if (inBucket.length === 0) continue;
    const best = inBucket.reduce((a, x) => ((oiByExp.get(x) ?? 0) > (oiByExp.get(a) ?? 0) ? x : a), inBucket[0]);
    if (!chosen.includes(best)) chosen.push(best);
  }

  for (const exp of chosen) {
    const dte = daysBetween(opts.todayIsoDate, exp);
    const calls = usable.filter((c) => c.expiration === exp && c.optionType === "CALL").sort((a, b) => a.strike - b.strike);
    const puts = usable.filter((c) => c.expiration === exp && c.optionType === "PUT").sort((a, b) => a.strike - b.strike);
    // Target width: about one ATR, or 1% of spot if ATR unknown, snapped to listed strikes.
    const width = opts.atr > 0 ? opts.atr : spot * 0.01;

    const atmCall = nearest(calls, spot);
    const atmPut = nearest(puts, spot);
    if (atmCall && quotable(atmCall)) out.push(single("long-call", "LONG", exp, dte, atmCall, budget));
    if (atmPut && quotable(atmPut)) out.push(single("long-put", "SHORT", exp, dte, atmPut, budget));
    // Verticals: try the ATR-width spread, a half-width spread, and the
    // narrowest listed spread, so a small account still sees something that
    // fits its budget. Duplicates (same short strike) are dropped.
    const widths = [width, width / 2, 0];
    if (atmCall && quotable(atmCall)) {
      const seen = new Set<number>();
      for (const w of widths) {
        const above = calls.filter((c) => c.strike > atmCall.strike);
        const shortLeg = w > 0 ? nearest(above, atmCall.strike + w) : above[0] ?? null;
        if (!shortLeg || !quotable(shortLeg) || seen.has(shortLeg.strike)) continue;
        seen.add(shortLeg.strike);
        const v = vertical("call-debit-spread", "LONG", exp, dte, atmCall, shortLeg, budget);
        if (v.debitMid > 0) out.push(v);
      }
    }
    if (atmPut && quotable(atmPut)) {
      const seen = new Set<number>();
      for (const w of widths) {
        const below = puts.filter((p) => p.strike < atmPut.strike);
        const shortLeg = w > 0 ? nearest(below, atmPut.strike - w) : below[below.length - 1] ?? null;
        if (!shortLeg || !quotable(shortLeg) || seen.has(shortLeg.strike)) continue;
        seen.add(shortLeg.strike);
        const v = vertical("put-debit-spread", "SHORT", exp, dte, atmPut, shortLeg, budget);
        if (v.debitMid > 0) out.push(v);
      }
    }
  }

  // Drop structures that cannot pay: verticals whose debit eats the whole
  // width, and legs so deep in the money they are stock substitutes.
  const sane = out.filter((s) => {
    if (s.maxGainPerContract !== null && s.maxGainPerContract <= 0) return false;
    const longDelta = s.legs[0].delta;
    if (longDelta !== null && (Math.abs(longDelta) > 0.9 || Math.abs(longDelta) < 0.1)) return false;
    return true;
  });
  // Order: fits the budget first, then reward:risk at least 1:1 (or
  // uncapped), then lowest spread drag.
  sane.sort((a, b) => {
    const fa = a.contractsForBudget > 0 ? 0 : 1, fb = b.contractsForBudget > 0 ? 0 : 1;
    if (fa !== fb) return fa - fb;
    const ra = a.rewardToRisk === null || a.rewardToRisk >= 1 ? 0 : 1, rb = b.rewardToRisk === null || b.rewardToRisk >= 1 ? 0 : 1;
    if (ra !== rb) return ra - rb;
    return a.spreadCostPct - b.spreadCostPct;
  });
  return sane.slice(0, opts.maxStructures);
}

// A leg we can actually price: a real bid and an ask at or above it.
function quotable(q: OptionQuote): boolean {
  return Number.isFinite(q.bid) && Number.isFinite(q.ask) && q.bid > 0 && q.ask >= q.bid;
}

function nearest(list: readonly OptionQuote[], target: number): OptionQuote | null {
  let best: OptionQuote | null = null, bestD = Infinity;
  for (const c of list) {
    const d = Math.abs(c.strike - target);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

function mid(q: OptionQuote): number {
  if (q.bid > 0 && q.ask > 0 && q.ask >= q.bid) return (q.bid + q.ask) / 2;
  return q.last > 0 ? q.last : Math.max(q.bid, q.ask, 0);
}

function liquidityFlags(legs: readonly OptionQuote[]): string[] {
  const flags: string[] = [];
  for (const q of legs) {
    const m = mid(q);
    if (q.bid <= 0) flags.push(`${q.osiSymbol}: no bid`);
    if (q.openInterest < 100) flags.push(`${q.osiSymbol}: open interest ${q.openInterest}`);
    if (q.volume === 0) flags.push(`${q.osiSymbol}: no volume today`);
    if (m > 0 && (q.ask - q.bid) / m > 0.10) flags.push(`${q.osiSymbol}: bid/ask ${(((q.ask - q.bid) / m) * 100).toFixed(0)}% of mid`);
  }
  return flags;
}

function single(kind: StructureKind, direction: "LONG" | "SHORT", exp: string, dte: number, leg: OptionQuote, budget: ResearchBudget): OptionStructure {
  const m = mid(leg);
  const debitAsk = leg.ask > 0 ? leg.ask : m;
  const maxLoss = debitAsk * 100;
  const maxGain = kind === "long-put" ? Math.max(0, leg.strike - debitAsk) * 100 : null;
  const breakeven = kind === "long-call" ? leg.strike + debitAsk : leg.strike - debitAsk;
  return {
    kind, direction, expiration: exp, daysToExpiration: dte, legs: [leg],
    debitMid: m, debitAsk, maxLossPerContract: maxLoss, maxGainPerContract: maxGain, rewardToRisk: maxGain === null ? null : maxGain / maxLoss, breakeven,
    spreadCostPct: m > 0 ? ((leg.ask - leg.bid) / m) * 100 : 0,
    netDelta: leg.delta, netTheta: leg.theta !== null ? leg.theta * 100 : null,
    contractsForBudget: maxLoss > 0 ? Math.floor(budget.maxRiskPerTradeUsd / maxLoss) : 0,
    liquidityFlags: liquidityFlags([leg]),
  };
}

function vertical(kind: StructureKind, direction: "LONG" | "SHORT", exp: string, dte: number, longLeg: OptionQuote, shortLeg: OptionQuote, budget: ResearchBudget): OptionStructure {
  const width = Math.abs(shortLeg.strike - longLeg.strike);
  const debitMid = mid(longLeg) - mid(shortLeg);
  const debitAsk = (longLeg.ask > 0 ? longLeg.ask : mid(longLeg)) - shortLeg.bid;
  const maxLoss = Math.max(0, debitAsk) * 100;
  const maxGain = Math.max(0, width - debitAsk) * 100;
  const breakeven = kind === "call-debit-spread" ? longLeg.strike + debitAsk : longLeg.strike - debitAsk;
  const pkgBid = longLeg.bid - shortLeg.ask, pkgAsk = longLeg.ask - shortLeg.bid;
  return {
    kind, direction, expiration: exp, daysToExpiration: dte, legs: [longLeg, shortLeg],
    debitMid, debitAsk, maxLossPerContract: maxLoss, maxGainPerContract: maxGain, rewardToRisk: maxLoss > 0 ? maxGain / maxLoss : null, breakeven,
    spreadCostPct: debitMid > 0 ? ((pkgAsk - pkgBid) / debitMid) * 100 : 0,
    netDelta: longLeg.delta !== null && shortLeg.delta !== null ? longLeg.delta - shortLeg.delta : null,
    netTheta: longLeg.theta !== null && shortLeg.theta !== null ? (longLeg.theta - shortLeg.theta) * 100 : null,
    contractsForBudget: maxLoss > 0 ? Math.floor(budget.maxRiskPerTradeUsd / maxLoss) : 0,
    liquidityFlags: liquidityFlags([longLeg, shortLeg]),
  };
}
