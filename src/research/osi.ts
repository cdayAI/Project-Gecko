// OCC option symbol helpers.
//
// Compact form (Webull, Cboe JSON): ROOT + YYMMDD + C|P + strike*1000 (8 digits)
//   e.g. SPY260918P00750000
// Padded 21-char form (Schwab): ROOT padded to 6 with spaces + same tail
//   e.g. "SPY   260918P00750000"

import type { OptionType } from "../core/types.js";

export interface ParsedOsi {
  readonly underlying: string;
  readonly expiration: string;     // YYYY-MM-DD
  readonly optionType: OptionType;
  readonly strike: number;
}

const OSI_RE = /^([A-Z]{1,6})\s*(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/;

export function parseOsi(symbol: string): ParsedOsi | null {
  const m = OSI_RE.exec(symbol.trim().toUpperCase());
  if (!m) return null;
  const [, root, yy, mm, dd, cp, strikeRaw] = m;
  const strike = Number(strikeRaw) / 1000;
  if (!Number.isFinite(strike) || strike <= 0) return null;
  return {
    underlying: root,
    expiration: `20${yy}-${mm}-${dd}`,
    optionType: cp === "C" ? "CALL" : "PUT",
    strike,
  };
}

export function buildCompactOsi(underlying: string, expiration: string, optionType: OptionType, strike: number): string {
  const [y, m, d] = expiration.split("-");
  const tail = `${y.slice(2)}${m}${d}${optionType === "CALL" ? "C" : "P"}${String(Math.round(strike * 1000)).padStart(8, "0")}`;
  return `${underlying.toUpperCase()}${tail}`;
}

export function daysBetween(fromIsoDate: string, toIsoDate: string): number {
  const a = Date.parse(`${fromIsoDate}T00:00:00Z`);
  const b = Date.parse(`${toIsoDate}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}
