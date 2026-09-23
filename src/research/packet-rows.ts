// Parser for the gap scan text the packet stores (docs/daily/<date>/scan-gap.txt),
// shared by the live monitor and the scorecard so both read a row the same way.
//
// Row layout (whitespace separated): Sym Pre-mkt Gap% PMvol PMhigh PMlow 20dhi
// 52whi >20d >52w <20dLo ATR $vol20 Sector Sector% Contract... | bucket text.
// A leading "*" on the symbol marks the H-GAP-SECTOR-LONG specification.

import * as fs from "node:fs";
import * as path from "node:path";

export type PacketTier = "star" | "large" | "watch" | "mega";

export interface PacketRow {
  readonly symbol: string;
  readonly star: boolean;
  readonly table: string;              // "UP LARGE", "UP WATCH", "UP MEGA-CAP", "DOWN LARGE", "DOWN WATCH"
  readonly side: "long" | "short";
  readonly tier: PacketTier;
  readonly megaSpec: boolean;          // T2 specification flag from the bucket text
  readonly premarketLast: number;
  readonly gapPct: number;
  readonly pmHigh: number;
  readonly pmLow: number;
  readonly high20: number;
  readonly above20: boolean;
  readonly atr: number;
  readonly sector: string;
  readonly sectorPct: number | null;
}

export interface PacketScan {
  readonly preOpen: boolean;           // header says "Pre-market gap scan" (not an after-open recap)
  readonly header: string;
  readonly rows: readonly PacketRow[];
}

export function parseScanGap(text: string): PacketScan {
  const lines = text.split("\n");
  const header = lines.find((l) => l.startsWith("===== ")) ?? "";
  const rows: PacketRow[] = [];
  let side: "long" | "short" | null = null;
  let kind = "";
  for (const line of lines) {
    const h = line.match(/^GAP (UP|DOWN): ([A-Z-]+)/);
    if (h) { side = h[1] === "UP" ? "long" : "short"; kind = h[2]; continue; }
    if (!side) continue;
    const m = line.match(/^\s{1,3}(\*?)([A-Z][A-Z.-]{0,6})\s+[\d.]+\s+[+-][\d.]+/);
    if (!m) continue;
    const tok = line.trim().split(/\s+/);
    const premarketLast = Number(tok[1]); const gapPct = Number(tok[2]);
    const pmHigh = Number(tok[4]); const pmLow = Number(tok[5]); const high20 = Number(tok[6]); const atr = Number(tok[11]);
    if (![premarketLast, pmHigh, pmLow, atr].every((n) => Number.isFinite(n) && n > 0) || !Number.isFinite(gapPct)) continue;
    const sectorPct = Number((tok[14] ?? "").replace("%", ""));
    const star = m[1] === "*";
    const tier: PacketTier = star ? "star" : kind === "MEGA-CAP" ? "mega" : kind === "LARGE" ? "large" : "watch";
    rows.push({
      symbol: m[2], star, table: `${side === "long" ? "UP" : "DOWN"} ${kind}`, side, tier,
      megaSpec: line.includes("MEGA T2 spec"),
      premarketLast, gapPct, pmHigh, pmLow, high20: Number.isFinite(high20) ? high20 : 0, above20: tok[8] === "Y", atr,
      sector: tok[13] ?? "", sectorPct: /^[+-]?\d/.test(tok[14] ?? "") && Number.isFinite(sectorPct) ? sectorPct : null,
    });
  }
  return { preOpen: header.startsWith("===== Pre-market gap scan"), header, rows };
}

export function readScanGap(date: string): PacketScan | null {
  const file = path.join("docs", "daily", date, "scan-gap.txt");
  if (!fs.existsSync(file)) return null;
  return parseScanGap(fs.readFileSync(file, "utf-8"));
}
