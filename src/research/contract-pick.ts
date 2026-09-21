// Option contract selection shared by the research scanners.
//
// Cboe delayed chains (free, prior-close marks outside market hours) or the
// Schwab live chain. Strike is otmPct out of the money (caller decides, e.g.
// 0.6 ATR capped at 2.5% for intraday, 0 for at-the-money swings); never
// in the money when an out-of-the-money strike is listed. Expiry prefers
// the first standard Friday between minDays and maxDays out.

import { createLogger } from "../core/logger.js";
import type { SchwabRest } from "../brokers/schwab/rest.js";
import { etParts } from "../utils/time.js";

const log = createLogger("contract-pick");
const CBOE_CHAIN = "https://cdn.cboe.com/api/global/delayed_quotes/options";
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";

export interface ContractPick {
  readonly code: string;
  readonly expiry: string;
  readonly strike: number;
  readonly right: "C" | "P";
  readonly bid: number;
  readonly ask: number;
  readonly delta: number | null;
  readonly openInterest: number;
}


// Live chain: nearest expiration at least 7 days out, strike nearest 2.5% OTM.
export async function pickSchwabContract(rest: SchwabRest, symbol: string, price: number, right: "C" | "P", otmPct: number, now: number, minDays = 7, maxDays = 45): Promise<ContractPick | null> {
  try {
    const chain = await rest.getOptionChain({
      symbol,
      contractType: right === "C" ? "CALL" : "PUT",
      strikeCount: 12,
      includeUnderlyingQuote: false,
      strategy: "SINGLE",
      fromDate: etParts(now + minDays * 86_400_000).date,
      toDate: etParts(now + maxDays * 86_400_000).date,
    });
    const map = right === "C" ? chain.callExpDateMap : chain.putExpDateMap;
    const expKeys = Object.keys(map).sort();
    if (expKeys.length === 0) return null;
    const fridays = expKeys.filter((k) => isFriday(k.slice(0, 10)));
    const expKey = fridays[0] ?? expKeys[0];
    const target = right === "C" ? price * (1 + otmPct / 100) : price * (1 - otmPct / 100);
    type StrikePick = { strike: number; c: { symbol: string; bid: number; ask: number; delta: number; openInterest: number } };
    let best: StrikePick | null = null;
    let fallback: StrikePick | null = null;
    for (const arr of Object.values(map[expKey])) {
      for (const c of arr) {
        const otm = right === "C" ? c.strikePrice >= price : c.strikePrice <= price;
        if (otm && (!best || Math.abs(c.strikePrice - target) < Math.abs(best.strike - target))) best = { strike: c.strikePrice, c };
        if (!fallback || Math.abs(c.strikePrice - target) < Math.abs(fallback.strike - target)) fallback = { strike: c.strikePrice, c };
      }
    }
    if (!best) best = fallback;
    if (!best) return null;
    return {
      code: best.c.symbol.replace(/\s+/g, ""),
      expiry: expKey.slice(0, 10),
      strike: best.strike,
      right,
      bid: best.c.bid,
      ask: best.c.ask,
      delta: Number.isFinite(best.c.delta) ? best.c.delta : null,
      openInterest: best.c.openInterest,
    };
  } catch (err) {
    log.debug("Schwab chain failed", { symbol, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

interface CboeOption { option: string; bid: number; ask: number; delta?: number; open_interest: number }

// Name the listed contract from Cboe's delayed chain. null when the symbol
// has no chain (not optionable) or the fetch fails.
export async function pickCboeContract(symbol: string, price: number, right: "C" | "P", otmPct: number, now: number, minDays = 7, maxDays = 21): Promise<ContractPick | null> {
  try {
    const resp = await fetch(`${CBOE_CHAIN}/${symbol}.json`, { headers: { "User-Agent": USER_AGENT } });
    if (!resp.ok) return null;
    const json = (await resp.json()) as { data?: { options?: CboeOption[] } };
    const options = json.data?.options ?? [];
    if (options.length === 0) return null;
    const minExpiry = etParts(now + minDays * 86_400_000).date.replace(/-/g, "").slice(2);   // YYMMDD
    const maxExpiry = etParts(now + maxDays * 86_400_000).date.replace(/-/g, "").slice(2);
    const parsed = options.map((o) => {
      const m = o.option.match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);
      return m ? { o, expiry: m[2], right: m[3] as "C" | "P", strike: Number(m[4]) / 1000 } : null;
    }).filter((x): x is NonNullable<typeof x> => x !== null && x.right === right && x.expiry >= minExpiry);
    if (parsed.length === 0) return null;
    const expiries = [...new Set(parsed.map((x) => x.expiry))].sort();
    const fridays = expiries.filter((e) => e <= maxExpiry && isFriday(`20${e.slice(0, 2)}-${e.slice(2, 4)}-${e.slice(4, 6)}`));
    const expiry = fridays[0] ?? expiries[0];
    const target = right === "C" ? price * (1 + otmPct / 100) : price * (1 - otmPct / 100);
    const atExpiry = parsed.filter((x) => x.expiry === expiry);
    const otm = atExpiry.filter((x) => (right === "C" ? x.strike >= price : x.strike <= price));
    const best = (otm.length > 0 ? otm : atExpiry).sort((a, b) => Math.abs(a.strike - target) - Math.abs(b.strike - target))[0];
    return {
      code: best.o.option,
      expiry: `20${expiry.slice(0, 2)}-${expiry.slice(2, 4)}-${expiry.slice(4, 6)}`,
      strike: best.strike,
      right,
      bid: best.o.bid,
      ask: best.o.ask,
      delta: typeof best.o.delta === "number" ? best.o.delta : null,
      openInterest: best.o.open_interest,
    };
  } catch {
    return null;
  }
}


function isFriday(isoDate: string): boolean {
  return new Date(`${isoDate}T12:00:00Z`).getUTCDay() === 5;
}

