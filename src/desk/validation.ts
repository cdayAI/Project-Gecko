import { parseOsi } from "../research/osi.js";
import { etParts } from "../utils/time.js";
import type { DeskConfig, DeskPolicy, ManualPlan } from "./types.js";

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object");
  return value as Record<string, unknown>;
}
export function number(value: unknown, name: string, min = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) throw new Error(`Invalid ${name}`);
  return value;
}
export function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing ${name}`);
  return value.trim();
}
export function integer(value: unknown, name: string, min = 1): number {
  const n = number(value, name, min);
  if (!Number.isSafeInteger(n)) throw new Error(`Invalid integer ${name}`);
  return n;
}
export function contractSymbol(value: unknown): string {
  const symbol = text(value, "contract").replace(/\s/g, "").toUpperCase();
  const parsed = parseOsi(symbol);
  if (!parsed || new Date(`${parsed.expiration}T00:00:00Z`).toISOString().slice(0, 10) !== parsed.expiration) throw new Error("Invalid option identity");
  return symbol;
}
export function parsePlan(value: unknown): ManualPlan {
  const r = record(value);
  const contract = contractSymbol(r.contract);
  const parsed = parseOsi(contract)!;
  const symbol = text(r.symbol, "symbol").toUpperCase();
  if (symbol !== parsed.underlying) throw new Error("Contract root does not match plan");
  const direction = r.direction;
  if (direction !== "LONG" && direction !== "SHORT") throw new Error("Invalid direction");
  if ((direction === "LONG") !== (parsed.optionType === "CALL")) throw new Error("Initial desk supports directional long calls or puts only");
  const p: ManualPlan = {
    id: text(r.id, "id"), version: integer(r.version, "version"), symbol, contract,
    strategy: text(r.strategy, "strategy"), direction,
    createdAt: number(r.createdAt, "createdAt", 1), validFrom: number(r.validFrom, "validFrom", 1),
    expiresAt: number(r.expiresAt, "expiresAt", 1), timeExit: number(r.timeExit, "timeExit", 1),
    trigger: number(r.trigger, "trigger", 0.0001), maxChase: number(r.maxChase, "maxChase", 0.0001),
    invalidation: number(r.invalidation, "invalidation", 0.0001),
    maxEntry: number(r.maxEntry, "maxEntry", 0.01), stopBid: number(r.stopBid, "stopBid"),
    targetBid: number(r.targetBid, "targetBid", 0.01), quantity: integer(r.quantity, "quantity"),
    correlationGroup: text(r.correlationGroup, "correlationGroup"), thesis: text(r.thesis, "thesis"),
    counterevidence: text(r.counterevidence, "counterevidence"),
    evidenceIds: Array.isArray(r.evidenceIds) ? r.evidenceIds.map(x => text(x, "evidence ID")) : [],
    researchPacketId: typeof r.researchPacketId === "string" ? r.researchPacketId : undefined,
    confidence: "UNVALIDATED", requireNews: r.requireNews === true,
  };
  if (p.createdAt > p.validFrom || p.validFrom >= p.expiresAt || p.expiresAt > p.timeExit) throw new Error("Invalid plan time sequence");
  if (p.stopBid >= p.maxEntry || p.targetBid <= p.maxEntry) throw new Error("Stop/target must bracket maximum entry");
  if (p.requireNews && (!p.evidenceIds.length || p.evidenceIds.some(id => !/@[1-9][0-9]*$/.test(id)))) throw new Error("News-dependent plans require evidence IDs pinned as id@revision");
  if (direction === "LONG" ? !(p.invalidation < p.trigger && p.trigger <= p.maxChase) : !(p.invalidation > p.trigger && p.trigger >= p.maxChase)) throw new Error("Invalid underlying trigger/invalidation/chase levels");
  const from = etParts(p.validFrom), exit = etParts(p.timeExit);
  const exitMinute = exit.hour * 60 + exit.minute;
  if (from.date !== exit.date || from.dayOfWeek === 0 || from.dayOfWeek === 6 || exitMinute >= 16 * 60 || from.date >= parsed.expiration) throw new Error("Initial desk requires same-session exits before 16:00 ET and expiration after the session");
  return p;
}
export function parseConfig(value: unknown): DeskConfig {
  const r = record(value), p = record(r.policy);
  const policy: DeskPolicy = {
    planningEquity: number(p.planningEquity, "planningEquity", 1),
    maxFullLossPerTrade: number(p.maxFullLossPerTrade, "maxFullLossPerTrade", 1),
    maxPlannedRiskPerTrade: number(p.maxPlannedRiskPerTrade, "maxPlannedRiskPerTrade", 1),
    maxAggregateDebit: number(p.maxAggregateDebit, "maxAggregateDebit", 1),
    maxCorrelatedDebit: number(p.maxCorrelatedDebit, "maxCorrelatedDebit", 1),
    dailyLossLimit: number(p.dailyLossLimit, "dailyLossLimit", 1),
    feePerContractPerSide: number(p.feePerContractPerSide, "feePerContractPerSide"),
    optionsPermissionVerified: p.optionsPermissionVerified === true,
    buyingPower: p.buyingPower === null ? null : number(p.buyingPower, "buyingPower"),
    positionsReconciledAt: p.positionsReconciledAt === null ? null : number(p.positionsReconciledAt, "positionsReconciledAt", 1),
  };
  if (policy.dailyLossLimit > policy.planningEquity || policy.maxAggregateDebit > policy.planningEquity || policy.maxFullLossPerTrade > policy.maxAggregateDebit || policy.maxCorrelatedDebit > policy.maxAggregateDebit || policy.maxPlannedRiskPerTrade > policy.maxFullLossPerTrade) throw new Error("Inconsistent risk limits");
  if (!Array.isArray(r.plans) || r.plans.length > 10) throw new Error("Expected at most ten explicit plans");
  const plans = r.plans.map(parsePlan);
  if (new Set(plans.map(x => x.id)).size !== plans.length || new Set(plans.map(x => x.contract)).size !== plans.length) throw new Error("One active version per plan ID and contract required");
  return { policy, plans };
}
