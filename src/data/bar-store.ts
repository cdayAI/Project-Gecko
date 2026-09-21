// On-disk store of intraday bars pulled from Schwab (npm run history:pull),
// keyed by symbol under data/history/5m/. Backtests read the store when a
// symbol is present and fall back to Yahoo's 60-day window otherwise.

import * as fs from "node:fs";
import * as path from "node:path";
import type { Bar } from "../core/types.js";

export const STORE_DIR = path.join("data", "history", "5m");

export function storePath(symbol: string): string {
  return path.join(STORE_DIR, `${symbol.toUpperCase()}.json`);
}

export function loadStoredIntraday(symbol: string): Bar[] | null {
  try {
    const p = storePath(symbol);
    if (!fs.existsSync(p)) return null;
    const rows = JSON.parse(fs.readFileSync(p, "utf-8")) as Bar[];
    return Array.isArray(rows) && rows.length > 0 ? rows : null;
  } catch {
    return null;
  }
}

export function saveStoredIntraday(symbol: string, bars: readonly Bar[]): void {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  const sorted = [...bars].sort((a, b) => a.timestamp - b.timestamp);
  fs.writeFileSync(storePath(symbol), JSON.stringify(sorted));
}

export function mergeBars(a: readonly Bar[], b: readonly Bar[]): Bar[] {
  const byTs = new Map<number, Bar>();
  for (const x of a) byTs.set(x.timestamp, x);
  for (const x of b) byTs.set(x.timestamp, x);
  return [...byTs.values()].sort((x, y) => x.timestamp - y.timestamp);
}
