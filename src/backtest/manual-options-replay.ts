// A single fixed plan replay, not a strategy search or a historical options dataset.
import type { ManualPlan, QuoteFrame } from "../desk/types.js";
import { parsePlan } from "../desk/validation.js";
import { evaluateQuotePair } from "../research/quote-quality.js";
import { parseOsi } from "../research/osi.js";
import type { OptionQuote, UnderlyingSnapshot } from "../research/types.js";
import type { OptionReplayConfig, OptionReplayFill, OptionReplayResult } from "./manual-options-types.js";

const DEFAULTS: OptionReplayConfig = Object.freeze({ maxFrameGapMs: 10_000,
  feePerContractPerSide: 0.10, adverseSlippagePerShare: 0.01, maxFullLoss: 250,
  maxPlannedLoss: 50, allowSynthetic: false });

export function replayManualOption(rawPlan: ManualPlan, frames: readonly QuoteFrame[], overrides: Partial<OptionReplayConfig> = {}): OptionReplayResult {
  const plan = parsePlan(rawPlan);
  const cfg = { ...DEFAULTS, ...overrides };
  if (![cfg.maxFrameGapMs, cfg.feePerContractPerSide, cfg.adverseSlippagePerShare, cfg.maxFullLoss, cfg.maxPlannedLoss].every(Number.isFinite) ||
      cfg.maxFrameGapMs <= 0 || cfg.feePerContractPerSide < 0 || cfg.adverseSlippagePerShare < 0 || cfg.maxFullLoss <= 0 ||
      cfg.maxPlannedLoss <= 0 || cfg.maxPlannedLoss > cfg.maxFullLoss) throw new Error("Invalid option replay cost/risk configuration");
  let previous = 0;
  let synthetic = false;
  for (const frame of frames) {
    if (!Number.isSafeInteger(frame.capturedAt) || frame.capturedAt <= previous || !Array.isArray(frame.options) || !Array.isArray(frame.underlying) ||
        !["webull", "recorded", "synthetic"].includes(frame.source)) throw new Error("Option frames must be valid and strictly increasing; never reorder future data");
    if (frame.capturedAt < plan.createdAt) throw new Error("Plan was created after observations; retrospective contract selection is not allowed");
    if (frame.source === "synthetic") { synthetic = true; if (!cfg.allowSynthetic) throw new Error("Synthetic frames require explicit engine-test mode"); }
    if (new Set(frame.options.map((q) => q.osiSymbol)).size !== frame.options.length ||
        new Set(frame.underlying.map((q) => q.symbol)).size !== frame.underlying.length) throw new Error("Duplicate identity in option frame");
    previous = frame.capturedAt;
  }
  let entry: OptionReplayFill | null = null;
  let exit: OptionReplayFill | null = null;
  let pendingAt: number | null = null;
  let invalidated = false;
  let status: OptionReplayResult["status"] = "NO_ENTRY";
  let exitReason: OptionReplayResult["exitReason"] = null;
  const events: { at: number; type: string; detail: string }[] = [];
  const event = (at: number, type: string, detail: string): void => { events.push({ at, type, detail }); };
  const result = (): OptionReplayResult => ({
    label: synthetic ? "SYNTHETIC_ENGINE_TEST_NOT_PERFORMANCE" : "HYPOTHETICAL_QUOTE_REPLAY_NOT_EXECUTED",
    planId: plan.id, planVersion: plan.version, contract: plan.contract, status, entry, exit, exitReason,
    netPnl: entry && exit ? ((exit.price - entry.price) * 100 - 2 * cfg.feePerContractPerSide) * plan.quantity : null,
    fullPremiumLoss: entry ? (entry.price * 100 + 2 * cfg.feePerContractPerSide) * plan.quantity : null,
    plannedLoss: entry ? ((entry.price - Math.max(0, plan.stopBid - cfg.adverseSlippagePerShare)) * 100 + 2 * cfg.feePerContractPerSide) * plan.quantity : null,
    events,
  });
  if (plan.requireNews) {
    status = "BLOCKED_NEWS_EVIDENCE";
    event(plan.createdAt, "blocked", "Quote-only replay has no time-indexed news evidence; required catalyst cannot be bypassed");
    return result();
  }
  previous = 0;
  for (const frame of frames) {
    const now = frame.capturedAt;
    const gap = previous > 0 && now - previous > cfg.maxFrameGapMs;
    previous = now;
    if (gap) {
      event(now, "gap", "Recorded frame gap exceeds limit; intervening stop/target path is unknown");
      pendingAt = null;
      if (entry) { status = "UNRESOLVED_DATA_GAP"; break; }
    }
    const q = frame.options.find((v) => v.osiSymbol === plan.contract);
    const u = frame.underlying.find((v) => v.symbol === plan.symbol);
    const basic = usablePair(u, q, now, plan.quantity);
    if (entry) {
      if (!basic || !q || !u) { status = "UNRESOLVED_DATA_GAP"; event(now, "blocked", "Missing, delayed, stale, future, or undersized exit quote; no invented fill"); break; }
      if (now >= plan.timeExit) exitReason = "time";
      else if (q.bid <= plan.stopBid) exitReason = "premium-stop";
      else if (plan.direction === "LONG" ? u.last <= plan.invalidation : u.last >= plan.invalidation) exitReason = "underlying-invalidation";
      else if (q.bid >= plan.targetBid) exitReason = "target";
      if (exitReason) {
        exit = { at: now, quoteTime: q.quoteTime!, quotedPrice: q.bid,
          price: Math.max(0, q.bid - cfg.adverseSlippagePerShare), quantity: plan.quantity };
        status = "CLOSED";
        event(now, "hypothetical-exit", `${exitReason}; observed bid less adverse slippage`);
        break;
      }
      continue;
    }
    if (now < plan.validFrom || now >= plan.expiresAt || invalidated) { pendingAt = null; continue; }
    if (!basic || !q || !u || evaluateQuotePair(u, q, now).status !== "DATA_PASS") {
      pendingAt = null; event(now, "entry-blocked", "Entry quote identity, timing, size, spread, or feed qualification failed"); continue;
    }
    const invalid = plan.direction === "LONG" ? u.last <= plan.invalidation || u.last > plan.maxChase : u.last >= plan.invalidation || u.last < plan.maxChase;
    if (invalid) { invalidated = true; pendingAt = null; event(now, "invalidated", "Underlying invalidation/chase condition; no reentry in this plan version"); continue; }
    const triggered = plan.direction === "LONG" ? u.last >= plan.trigger : u.last <= plan.trigger;
    const askWithSlip = q.ask + cfg.adverseSlippagePerShare;
    const fullLoss = (askWithSlip * 100 + 2 * cfg.feePerContractPerSide) * plan.quantity;
    const plannedLoss = ((askWithSlip - Math.max(0, plan.stopBid - cfg.adverseSlippagePerShare)) * 100 + 2 * cfg.feePerContractPerSide) * plan.quantity;
    if (!triggered || askWithSlip > plan.maxEntry || q.bid <= plan.stopBid || q.bid >= plan.targetBid ||
        fullLoss > cfg.maxFullLoss || plannedLoss > cfg.maxPlannedLoss) { pendingAt = null; event(now, "entry-blocked", "Trigger, entry cap, stop/target bracket, or risk budget failed"); continue; }
    if (pendingAt === null) { pendingAt = now; event(now, "signal", "Qualifying observation; earliest fill is the next qualifying recorded frame"); continue; }
    entry = { at: now, quoteTime: q.quoteTime!, quotedPrice: q.ask, price: askWithSlip, quantity: plan.quantity };
    pendingAt = null;
    event(now, "hypothetical-entry", "Observed next-frame ask plus adverse slippage; a quote is not a verified fill");
  }
  if (entry && !exit && status !== "UNRESOLVED_DATA_GAP") status = "UNRESOLVED_OPEN_POSITION";
  return result();
}

function usablePair(u: UnderlyingSnapshot | undefined, q: OptionQuote | undefined, now: number, quantity: number): boolean {
  if (!u || !q || q.contractVerified !== true || q.contractStandard !== true || q.contractMultiplier !== 100 ||
      q.provenance?.delayMinutes !== 0 || q.provenance.delayed || q.provenance.delayStatus === "delayed" ||
      u.provenance?.delayed || u.provenance?.delayStatus === "delayed" ||
      (u.provenance?.delayMinutes !== undefined && u.provenance.delayMinutes !== 0)) return false;
  const identity = parseOsi(q.osiSymbol);
  if (!identity || identity.underlying !== q.underlying || identity.optionType !== q.optionType ||
      identity.expiration !== q.expiration || identity.strike !== q.strike) return false;
  const times = [q.quoteTime, u.quoteTime, u.lastTradeTime];
  if (times.some((time) => typeof time !== "number" || !Number.isSafeInteger(time) || time > now || now - time > 5_000)) return false;
  return q.underlying === u.symbol && Number.isFinite(u.last) && u.last > 0 &&
    Number.isFinite(q.bid) && q.bid >= 0 && Number.isFinite(q.ask) && q.ask >= q.bid &&
    Number.isInteger(q.bidSize) && q.bidSize! >= quantity && Number.isInteger(q.askSize) && q.askSize! >= quantity &&
    Math.abs(q.quoteTime! - u.quoteTime!) <= 2_000;
}
