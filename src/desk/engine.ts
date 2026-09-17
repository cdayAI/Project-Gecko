import { evaluateQuotePair } from "../research/quote-quality.js";
import { etDate, isRegularSession } from "../utils/time.js";
import type { JournalState } from "./journal.js";
import type { DeskConfig, ManualPlan, PlanStatus, PlanUpdate, QuoteFrame } from "./types.js";

export interface NewsReadiness { readonly available: boolean; readonly eventIds: readonly string[]; readonly reasons: readonly string[]; }
export interface DeskEvaluation { readonly updates: readonly PlanUpdate[]; readonly accountMarkedPnl: number | null; readonly dataSource: QuoteFrame["source"]; readonly unmonitoredPositions: readonly string[]; readonly dailyHaltDate: string | null; }

export function evaluateDesk(config: DeskConfig, frame: QuoteFrame, journal: JournalState,
  previous: readonly PlanUpdate[] = [], news: ReadonlyMap<string, NewsReadiness> = new Map(), priorDailyHaltDate: string | null = null): DeskEvaluation {
  const now = frame.capturedAt, policy = config.policy;
  const snapshots = new Map(frame.underlying.map(x => [x.symbol, x]));
  const options = new Map(frame.options.map(x => [x.osiSymbol, x]));
  const existing = new Map(previous.filter(x => x.at <= now).map(x => [`${x.planId}:${x.version}`, x]));
  const todayRealized = journal.realized.filter(x => etDate(x.closedAt) === etDate(now)).reduce((s, x) => s + x.netPnl, 0);
  let markedPnl: number | null = todayRealized;
  let reservedDebit = journal.lots.reduce((s, x) => s + x.quantity * (x.entryPrice * 100 + x.entryFeePerContract), 0);
  let newReservations = 0;
  const groupDebit = new Map<string, number>();
  for (const lot of journal.lots) {
    groupDebit.set(lot.correlationGroup, (groupDebit.get(lot.correlationGroup) ?? 0) + lot.quantity * (lot.entryPrice * 100 + lot.entryFeePerContract));
    const q = options.get(lot.contract), u = q ? snapshots.get(q.underlying) : undefined;
    if (!q || !u || evaluateQuotePair(u, q, now).status !== "DATA_PASS") { markedPnl = null; continue; }
    if (markedPnl !== null) markedPnl += lot.quantity * ((q.bid - lot.entryPrice) * 100 - lot.entryFeePerContract - policy.feePerContractPerSide);
  }
  const updates: PlanUpdate[] = [];
  const dailyHalted = priorDailyHaltDate === etDate(now) || (markedPnl !== null && markedPnl <= -policy.dailyLossLimit);
  const overnight = journal.lots.some(l => etDate(l.openedAt) !== etDate(now));
  const unmonitoredPositions = journal.lots.filter(l => !config.plans.some(p => p.id === l.planId && p.version === l.planVersion && p.contract === l.contract)).map(l => `${l.contract}: ${l.quantity} contract(s), plan ${l.planId} v${l.planVersion}; attach a monitoring plan and check position manually`);
  // Fixed config order is the priority. Reserve cash for all simultaneous eligible alerts.
  for (const plan of config.plans) {
    const u = snapshots.get(plan.symbol), q = options.get(plan.contract);
    const roundTripFees = 2 * policy.feePerContractPerSide * plan.quantity;
    const heldLots = journal.lots.filter(x => x.planId === plan.id && x.planVersion === plan.version && x.contract === plan.contract);
    const quantityOpen = heldLots.reduce((s, x) => s + x.quantity, 0);
    const fullLoss = quantityOpen > 0 ? heldLots.reduce((s, l) => s + l.quantity * (l.entryPrice * 100 + l.entryFeePerContract + policy.feePerContractPerSide), 0) : plan.maxEntry * 100 * plan.quantity + roundTripFees;
    const plannedRisk = quantityOpen > 0 ? Math.max(0, fullLoss - plan.stopBid * 100 * quantityOpen) : (plan.maxEntry - plan.stopBid) * 100 * plan.quantity + roundTripFees;
    const quality = u && q ? evaluateQuotePair(u, q, now) : { status: "DATA_BLOCK" as const, reasons: ["missing underlying or contract quote"] };
    const prior = existing.get(`${plan.id}:${plan.version}`);
    let status: PlanStatus = "WATCHING", reasons: string[] = [];
    if (quantityOpen > 0) {
      status = "OPEN";
      if (prior?.status === "EXIT_WATCH" || prior?.status === "INVALIDATED" || prior?.status === "EXPIRED") {
        status = "EXIT_WATCH"; reasons.push(...prior.reasons, "exit review remains required until the actual closing fill is recorded");
      }
      if (quantityOpen > plan.quantity || fullLoss > policy.maxFullLossPerTrade || dailyHalted || heldLots.some(l => etDate(l.openedAt) !== etDate(now))) {
        status = "EXIT_WATCH"; reasons.push("recorded position or account loss exceeds configured limits; manual review required");
      }
      if (now >= plan.timeExit) { status = "EXIT_WATCH"; reasons.push("planned time exit reached; manual action required"); }
      if (quality.status !== "DATA_PASS") { reasons.push(...quality.reasons, "position mark unavailable; check broker"); }
      else if (q && u) {
        if (q.bid <= plan.stopBid) { status = "EXIT_WATCH"; reasons.push("planned premium stop reached; fill is not guaranteed"); }
        if (q.bid >= plan.targetBid) { status = "EXIT_WATCH"; reasons.push("target bid reached"); }
        if (invalidated(plan, u.last)) { status = "EXIT_WATCH"; reasons.push("underlying invalidation reached"); }
      }
    } else if (journal.fills.some(x => x.planId === plan.id && x.planVersion === plan.version && x.side === "BUY_TO_OPEN")) {
      status = "CLOSED"; reasons.push("journal shows plan position fully closed; reentry requires a new version");
    } else if (prior?.status === "INVALIDATED" || prior?.status === "EXPIRED") {
      status = prior.status; reasons = [...prior.reasons];
    } else if (now >= plan.expiresAt) {
      status = "EXPIRED"; reasons.push("entry window expired");
    } else if (now < plan.validFrom || !isRegularSession(now)) {
      status = "WATCHING"; reasons.push("outside entry session/window");
    } else if (quality.status !== "DATA_PASS") {
      status = "DATA_BLOCKED"; reasons.push(...quality.reasons);
    } else if (u && invalidated(plan, u.last)) {
      status = "INVALIDATED"; reasons.push("underlying invalidation reached");
    } else if (u && (plan.direction === "LONG" ? u.last > plan.maxChase : u.last < plan.maxChase)) {
      status = "INVALIDATED"; reasons.push("maximum chase level exceeded; reentry requires a new version");
    } else if (u && q) {
      const info = news.get(plan.symbol);
      if (plan.requireNews && (!info?.available || !plan.evidenceIds.length || !plan.evidenceIds.every(id => info.eventIds.includes(id)))) {
        status = "DATA_BLOCKED"; reasons.push("required attributed news evidence unavailable", ...(info?.reasons ?? []));
      } else if (q.ask > plan.maxEntry) { reasons.push("option ask exceeds maximum entry"); }
      else if (q.bid <= plan.stopBid || q.bid >= plan.targetBid) { reasons.push("option is already outside planned stop/target bracket"); }
      else if (plan.direction === "LONG" ? u.last < plan.trigger : u.last > plan.trigger) { reasons.push("underlying trigger pending"); }
      else {
        const blocks: string[] = [];
        if (!policy.optionsPermissionVerified) blocks.push("options permission unverified");
        if ((q.askSize ?? 0) < plan.quantity) blocks.push("displayed ask size is smaller than planned quantity");
        if (overnight) blocks.push("overnight exposure requires a daily baseline; intraday desk cannot qualify new risk");
        if (policy.buyingPower === null || newReservations + fullLoss > policy.buyingPower) blocks.push("verified buying power unavailable or insufficient");
        if (policy.positionsReconciledAt === null || policy.positionsReconciledAt > now || now - policy.positionsReconciledAt > 15 * 60_000) blocks.push("account/position reconciliation older than 15 minutes or unknown");
        if (policy.positionsReconciledAt !== null && journal.fills.some(f => f.executedAt > policy.positionsReconciledAt!)) blocks.push("fills since account reconciliation; refresh buying power and positions");
        if (fullLoss > policy.maxFullLossPerTrade) blocks.push("full premium exposure exceeds per-trade limit");
        if (plannedRisk > policy.maxPlannedRiskPerTrade) blocks.push("planned risk exceeds per-trade limit");
        if (reservedDebit + fullLoss > policy.maxAggregateDebit) blocks.push("aggregate premium cap reached");
        if ((groupDebit.get(plan.correlationGroup) ?? 0) + fullLoss > policy.maxCorrelatedDebit) blocks.push("correlated premium cap reached");
        if (markedPnl === null) blocks.push("open exposure cannot be marked from fresh quotes");
        if (dailyHalted) blocks.push("daily loss limit reached; entries halted for this ET session");
        if (journal.lots.some(l => !config.plans.some(p => p.id === l.planId && p.version === l.planVersion && p.contract === l.contract))) blocks.push("open position has no active monitoring plan");
        if (blocks.length) { status = "RISK_BLOCKED"; reasons.push(...blocks); }
        else { status = "ELIGIBLE"; reasons.push("conditional research setup eligible; manual decision and execution required");
          reservedDebit += fullLoss; newReservations += fullLoss; groupDebit.set(plan.correlationGroup, (groupDebit.get(plan.correlationGroup) ?? 0) + fullLoss); }
      }
    }
    updates.push({ planId: plan.id, version: plan.version, at: now, status, reasons: [...new Set(reasons)], contract: plan.contract,
      quoteTime: q?.quoteTime ?? q?.provenance?.sourceTimestamp ?? null,
      validUntil: status === "ELIGIBLE" ? Math.min(plan.expiresAt, now + 2000, (q?.quoteTime ?? 0) + 5000, (u?.quoteTime ?? 0) + 5000, (u?.lastTradeTime ?? 0) + 5000) : now,
      bid: quality.status === "DATA_PASS" && q ? q.bid : null, ask: quality.status === "DATA_PASS" && q ? q.ask : null,
      quantity: quantityOpen || plan.quantity, plannedRisk, fullLoss,
      targetProfitScenario: quantityOpen > 0 ? plan.targetBid * 100 * quantityOpen - fullLoss : (plan.targetBid - plan.maxEntry) * 100 * plan.quantity - roundTripFees, probabilityOfProfit: null });
  }
  return { updates, accountMarkedPnl: overnight ? null : markedPnl, dataSource: frame.source, unmonitoredPositions, dailyHaltDate: dailyHalted ? etDate(now) : null };
}

function invalidated(plan: ManualPlan, price: number): boolean { return plan.direction === "LONG" ? price <= plan.invalidation : price >= plan.invalidation; }
