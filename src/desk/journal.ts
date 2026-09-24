import * as fs from "node:fs";
import * as path from "node:path";
import { etDate } from "../utils/time.js";
import { contractSymbol, integer, number, record, text } from "./validation.js";

export interface ManualFill {
  readonly id: string;
  readonly source: "broker" | "manual";
  readonly executedAt: number;
  readonly contract: string;
  readonly multiplier: 100;
  readonly standardContract: true;
  readonly side: "BUY_TO_OPEN" | "SELL_TO_CLOSE";
  readonly quantity: number;
  readonly price: number;
  readonly fees: number;
  readonly planId: string;
  readonly planVersion: number;
  readonly correlationGroup: string;
}
export interface OpenLot {
  readonly fillId: string; readonly contract: string; readonly openedAt: number;
  readonly planId: string; readonly planVersion: number; readonly correlationGroup: string;
  quantity: number; readonly entryPrice: number; readonly entryFeePerContract: number;
}
export interface RealizedLot {
  readonly entryId: string; readonly exitId: string; readonly contract: string;
  readonly planId: string; readonly planVersion: number; readonly quantity: number;
  readonly openedAt: number; readonly closedAt: number; readonly grossPnl: number;
  readonly fees: number; readonly netPnl: number;
}
export interface JournalState { readonly fills: readonly ManualFill[]; readonly lots: readonly OpenLot[]; readonly realized: readonly RealizedLot[]; }

export function parseFill(value: unknown): ManualFill {
  const r = record(value);
  if (r.side !== "BUY_TO_OPEN" && r.side !== "SELL_TO_CLOSE") throw new Error("Only long-option opening buys and closing sells supported");
  if (r.source !== "broker" && r.source !== "manual") throw new Error("Fill source must be broker or manual");
  if (r.multiplier !== 100 || r.standardContract !== true) throw new Error("Journal requires explicit standard multiplier-100 contract metadata");
  return { id: text(r.id, "execution ID"), source: r.source, executedAt: integer(r.executedAt, "executedAt"), contract: contractSymbol(r.contract),
    multiplier: 100, standardContract: true,
    side: r.side, quantity: integer(r.quantity, "quantity"), price: number(r.price, "fill price", 0), fees: number(r.fees, "fees"),
    planId: text(r.planId, "planId"), planVersion: integer(r.planVersion, "planVersion"), correlationGroup: text(r.correlationGroup, "correlationGroup") };
}

// FIFO matching is confined to the same recommendation version. No assumed fills.
export function reconstruct(fills: readonly ManualFill[], asOf = Infinity): JournalState {
  const seen = new Map<string, string>();
  const unique: ManualFill[] = [];
  for (const raw of fills) {
    const f = parseFill(raw), encoded = JSON.stringify(f), previous = seen.get(f.id);
    if (previous !== undefined && previous !== encoded) throw new Error(`Conflicting execution ID ${f.id}`);
    if (previous === undefined) { seen.set(f.id, encoded); if (f.executedAt <= asOf) unique.push(f); }
  }
  // Stable input order resolves equal timestamps; do not invent buy-before-sell ordering.
  unique.sort((a, b) => a.executedAt - b.executedAt);
  const lots: OpenLot[] = [], realized: RealizedLot[] = [];
  for (const f of unique) {
    if (f.side === "BUY_TO_OPEN") {
      lots.push({ fillId: f.id, contract: f.contract, openedAt: f.executedAt, planId: f.planId, planVersion: f.planVersion,
        correlationGroup: f.correlationGroup, quantity: f.quantity, entryPrice: f.price, entryFeePerContract: f.fees / f.quantity });
      continue;
    }
    let remaining = f.quantity;
    for (const lot of lots) {
      if (lot.quantity === 0 || lot.contract !== f.contract || lot.planId !== f.planId || lot.planVersion !== f.planVersion) continue;
      if (lot.correlationGroup !== f.correlationGroup) throw new Error("Closing fill changes correlation group");
      const quantity = Math.min(remaining, lot.quantity);
      const grossPnl = (f.price - lot.entryPrice) * 100 * quantity;
      const fees = (lot.entryFeePerContract + f.fees / f.quantity) * quantity;
      realized.push({ entryId: lot.fillId, exitId: f.id, contract: f.contract, planId: f.planId, planVersion: f.planVersion,
        quantity, openedAt: lot.openedAt, closedAt: f.executedAt, grossPnl, fees, netPnl: grossPnl - fees });
      lot.quantity -= quantity; remaining -= quantity;
      if (remaining === 0) break;
    }
    if (remaining > 0) throw new Error(`Closing fill exceeds known position: ${f.id}`);
  }
  return { fills: unique, lots: lots.filter(x => x.quantity > 0), realized };
}

export class FillJournal {
  constructor(readonly directory = "data/desk") {}
  read(asOf = Infinity): JournalState {
    const file = path.join(this.directory, "fills.jsonl");
    const fills = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map(line => parseFill(JSON.parse(line) as unknown)) : [];
    return reconstruct(fills, asOf);
  }
  import(values: readonly unknown[]): { imported: number; duplicates: number } {
    fs.mkdirSync(this.directory, { recursive: true });
    const lock = path.join(this.directory, "journal.lock"), fd = fs.openSync(lock, "wx");
    try {
      const previous = this.read().fills, incoming = values.map(parseFill);
      if (incoming.some(f => f.executedAt > Date.now() + 500)) throw new Error("Future-dated fills cannot be imported");
      const complete = reconstruct([...previous, ...incoming]);
      const ids = new Set(previous.map(x => x.id));
      const fresh = complete.fills.filter(x => !ids.has(x.id));
      if (fresh.length) fs.appendFileSync(path.join(this.directory, "fills.jsonl"), fresh.map(x => JSON.stringify(x)).join("\n") + "\n");
      return { imported: fresh.length, duplicates: incoming.length - fresh.length };
    } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
  }
}

export function journalSummary(state: JournalState, now: number): Record<string, unknown> {
  const closed = state.realized, net = closed.reduce((s, x) => s + x.netPnl, 0);
  return { source: "recorded manual/broker fills", fillCount: state.fills.length, matchedLots: closed.length,
    grossRealizedPnl: closed.reduce((s, x) => s + x.grossPnl, 0), allocatedClosedFees: closed.reduce((s, x) => s + x.fees, 0), netRealizedPnl: net,
    todayNetRealizedPnl: closed.filter(x => etDate(x.closedAt) === etDate(now)).reduce((s, x) => s + x.netPnl, 0),
    openPremiumAtRisk: state.lots.reduce((s, x) => s + x.quantity * (x.entryPrice * 100 + x.entryFeePerContract), 0), openLots: state.lots };
}
