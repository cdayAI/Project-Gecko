// Forward trade log: the record that decides what is real.
//
//   npm run log -- add --date 2026-09-21 --symbol AMD --side long --source gap --tier watch \
//       --gap 4.3 --sector "SMH +2.5%" --catalyst "US-China talks called successful; ATH breakout" \
//       --taken no --instrument stock --entry 600.47 --entry-time 09:40 --stop 582.27 \
//       --exit 615.41 --exit-time 15:45 --exit-reason time --notes "watched"
//   npm run log -- add --date 2026-09-22 --symbol XYZ --taken yes --instrument "XYZ261016C00050000" --qty 2 --entry 3.10 ...
//   npm run log -- report            # win rate, expectancy, profit factor by tier / source / taken
//   npm run log -- list [--last 20]
//   npm run log -- close --id <id> --exit 12.34 --exit-time 15:45 --exit-reason target1
//
// Storage: docs/log/trades.jsonl, one JSON object per line, committed to the
// repo (not under data/, which is gitignored) so the log travels with the code.
// Every entry is a decision record: taken or watched, with the catalyst as
// you understood it at the time. Returns are on the instrument you logged
// (stock or option); the report shows both groups separately.

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

export const LOG_FILE = path.join("docs", "log", "trades.jsonl");

export interface TradeRecord {
  readonly id: string;
  readonly loggedAt: string;            // ISO time the record was written
  readonly date: string;                // session date YYYY-MM-DD
  readonly symbol: string;
  readonly side: "long" | "short";
  readonly source: "gap" | "swing" | "discretionary" | "other";
  readonly tier: "star" | "large" | "watch" | "bounce" | "none";   // scanner tier at decision time
  readonly gapPct?: number;
  readonly sector?: string;             // e.g. "SMH +2.5%"
  readonly catalyst?: string;           // what you believed the reason was, at the time
  readonly taken: boolean;              // false = watched / paper
  readonly instrument: string;          // "stock" or an OCC option symbol
  readonly qty?: number;
  readonly entry?: number;
  readonly entryTime?: string;          // HH:MM ET
  readonly stop?: number;
  readonly target1?: number;
  readonly target2?: number;
  readonly exit?: number;
  readonly exitTime?: string;
  readonly exitReason?: "target1" | "target2" | "stop" | "time" | "manual" | "open";
  readonly fees?: number;
  readonly notes?: string;
}

function readAll(): TradeRecord[] {
  if (!fs.existsSync(LOG_FILE)) return [];
  return fs.readFileSync(LOG_FILE, "utf-8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as TradeRecord);
}

function writeAll(rows: readonly TradeRecord[]): void {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.writeFileSync(LOG_FILE, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
}

function parseKv(argv: readonly string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) { m.set(key, "true"); continue; }
    m.set(key, next); i++;
  }
  return m;
}

const num = (v: string | undefined): number | undefined => (v === undefined || v === "" ? undefined : Number(v));

function returnPct(r: TradeRecord): number | null {
  if (r.entry === undefined || r.exit === undefined || !(r.entry > 0)) return null;
  const raw = (r.exit / r.entry - 1) * (r.side === "short" ? -1 : 1) * 100;
  return raw;
}

function pnlUsd(r: TradeRecord): number | null {
  if (r.entry === undefined || r.exit === undefined || r.qty === undefined) return null;
  const mult = r.instrument === "stock" ? 1 : 100;
  return (r.exit - r.entry) * (r.side === "short" ? -1 : 1) * r.qty * mult - (r.fees ?? 0);
}

function stat(label: string, rows: readonly TradeRecord[]): string {
  const closed = rows.filter((r) => returnPct(r) !== null);
  if (closed.length === 0) return `${label.padEnd(34)} n=0`;
  const rets = closed.map((r) => returnPct(r) as number);
  const w = rets.filter((x) => x > 0), l = rets.filter((x) => x <= 0);
  const gw = w.reduce((s, x) => s + x, 0), gl = -l.reduce((s, x) => s + x, 0);
  const exp = rets.reduce((s, x) => s + x, 0) / rets.length;
  const usd = closed.map(pnlUsd).filter((x): x is number => x !== null).reduce((s, x) => s + x, 0);
  return `${label.padEnd(34)} n=${String(closed.length).padStart(3)}  win ${(w.length / closed.length * 100).toFixed(0).padStart(3)}%  avg win ${(w.length ? gw / w.length : 0).toFixed(2)}%  avg loss ${(l.length ? -gl / l.length : 0).toFixed(2)}%  exp ${exp >= 0 ? "+" : ""}${exp.toFixed(2)}%  PF ${(gl > 0 ? gw / gl : 99).toFixed(2)}  realized $${usd.toFixed(0)}`;
}

function main(): void {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? "report";
  const kv = parseKv(argv.slice(1));
  const rows = readAll();

  if (cmd === "add") {
    const date = kv.get("date") ?? new Date().toISOString().slice(0, 10);
    const symbol = (kv.get("symbol") ?? "").toUpperCase();
    if (!symbol) throw new Error("--symbol is required");
    const side = (kv.get("side") ?? "long") as TradeRecord["side"];
    const source = (kv.get("source") ?? "gap") as TradeRecord["source"];
    const tier = (kv.get("tier") ?? "none") as TradeRecord["tier"];
    const takenRaw = (kv.get("taken") ?? "no").toLowerCase();
    const rec: TradeRecord = {
      id: randomUUID().slice(0, 8),
      loggedAt: new Date().toISOString(),
      date, symbol, side, source, tier,
      gapPct: num(kv.get("gap")),
      sector: kv.get("sector"),
      catalyst: kv.get("catalyst"),
      taken: takenRaw === "yes" || takenRaw === "true" || takenRaw === "y",
      instrument: kv.get("instrument") ?? "stock",
      qty: num(kv.get("qty")),
      entry: num(kv.get("entry")),
      entryTime: kv.get("entry-time"),
      stop: num(kv.get("stop")),
      target1: num(kv.get("target1")),
      target2: num(kv.get("target2")),
      exit: num(kv.get("exit")),
      exitTime: kv.get("exit-time"),
      exitReason: (kv.get("exit-reason") as TradeRecord["exitReason"]) ?? (kv.get("exit") ? "manual" : "open"),
      fees: num(kv.get("fees")),
      notes: kv.get("notes"),
    };
    writeAll([...rows, rec]);
    process.stdout.write(`logged ${rec.id}: ${rec.date} ${rec.symbol} ${rec.side} ${rec.instrument} ${rec.taken ? "TAKEN" : "watched"}${rec.exit !== undefined ? ` ret ${returnPct(rec)?.toFixed(2)}%` : " (open)"}\n`);
    return;
  }

  if (cmd === "close") {
    const id = kv.get("id"); if (!id) throw new Error("--id is required");
    const i = rows.findIndex((r) => r.id === id); if (i < 0) throw new Error(`no record ${id}`);
    const r = rows[i];
    const updated: TradeRecord = { ...r, exit: num(kv.get("exit")) ?? r.exit, exitTime: kv.get("exit-time") ?? r.exitTime, exitReason: (kv.get("exit-reason") as TradeRecord["exitReason"]) ?? "manual", fees: num(kv.get("fees")) ?? r.fees, notes: kv.get("notes") ?? r.notes };
    rows[i] = updated; writeAll(rows);
    process.stdout.write(`closed ${id}: ${updated.symbol} exit ${updated.exit} (${updated.exitReason}) ret ${returnPct(updated)?.toFixed(2)}%\n`);
    return;
  }

  if (cmd === "list") {
    const last = Number(kv.get("last") ?? "30");
    for (const r of rows.slice(-last)) {
      const ret = returnPct(r);
      process.stdout.write(`${r.id}  ${r.date}  ${r.symbol.padEnd(5)} ${r.side.padEnd(5)} ${r.source.padEnd(13)} ${r.tier.padEnd(6)} ${(r.taken ? "TAKEN" : "watch").padEnd(6)} ${r.instrument.padEnd(20)} entry ${r.entry ?? "-"} exit ${r.exit ?? "-"} ${ret === null ? "(open)" : (ret >= 0 ? "+" : "") + ret.toFixed(2) + "%"}  ${r.catalyst ?? ""}\n`);
    }
    return;
  }

  // report
  process.stdout.write(`\n===== Forward log: ${rows.length} records, ${rows.filter((r) => returnPct(r) !== null).length} closed, ${rows.filter((r) => r.taken).length} taken =====\n`);
  process.stdout.write(stat("ALL closed", rows) + "\n");
  process.stdout.write(stat("  taken (real fills)", rows.filter((r) => r.taken)) + "\n");
  process.stdout.write(stat("  watched (paper)", rows.filter((r) => !r.taken)) + "\n");
  process.stdout.write(stat("  stock", rows.filter((r) => r.instrument === "stock")) + "\n");
  process.stdout.write(stat("  options", rows.filter((r) => r.instrument !== "stock")) + "\n");
  for (const source of ["gap", "swing", "discretionary", "other"] as const) process.stdout.write(stat(`  source=${source}`, rows.filter((r) => r.source === source)) + "\n");
  for (const tier of ["star", "large", "watch", "bounce", "none"] as const) process.stdout.write(stat(`  tier=${tier}`, rows.filter((r) => r.tier === tier)) + "\n");
  process.stdout.write(stat("  with a named catalyst", rows.filter((r) => (r.catalyst ?? "").trim().length > 0)) + "\n");
  process.stdout.write(stat("  no catalyst noted", rows.filter((r) => (r.catalyst ?? "").trim().length === 0)) + "\n");
  const open = rows.filter((r) => returnPct(r) === null);
  if (open.length) process.stdout.write(`open: ${open.map((r) => `${r.id} ${r.symbol}`).join(", ")}\n`);
  process.stdout.write(`\nThe comparison that matters: tier=star vs tier=watch, and "with a named catalyst" vs without. Thirty closed records per group before reading anything into it.\n\n`);
}

main();
