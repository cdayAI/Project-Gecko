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


// Live chain: the most liquid contract (open interest, then spread, then
// distance to the target strike) across every expiry between minDays and
// maxDays out, strikes within 6% of the target on either side of the money.
// The
// request asks for every strike (range ALL): a strikeCount window is centred
// on Schwab's own underlying price, which before the open is still the prior
// close, so on 2026-09-22 a 30% gapper (VKTX, pre-market 39.06) came back
// with strikes 27.5 to 33 and the picker named a deep in-the-money call.
export async function pickSchwabContract(rest: SchwabRest, symbol: string, price: number, right: "C" | "P", otmPct: number, now: number, minDays = 7, maxDays = 45): Promise<ContractPick | null> {
  try {
    const chain = await rest.getOptionChain({
      symbol,
      contractType: right === "C" ? "CALL" : "PUT",
      range: "ALL",
      includeUnderlyingQuote: false,
      strategy: "SINGLE",
      fromDate: etParts(now + minDays * 86_400_000).date,
      toDate: etParts(now + maxDays * 86_400_000).date,
    });
    const map = right === "C" ? chain.callExpDateMap : chain.putExpDateMap;
    const expKeys = Object.keys(map).sort();
    if (expKeys.length === 0) return null;
    const target = right === "C" ? price * (1 + otmPct / 100) : price * (1 - otmPct / 100);
    // Liquidity first across every expiry in the window (see pickCboeContract).
    type StrikePick = { strike: number; expKey: string; c: { symbol: string; bid: number; ask: number; delta: number; openInterest: number } };
    const all: StrikePick[] = [];
    for (const expKey of expKeys) for (const arr of Object.values(map[expKey])) for (const c of arr) all.push({ strike: c.strikePrice, expKey, c });
    const near = all.filter((x) => Math.abs(x.strike - target) <= price * 0.06);
    const pool = near.length > 0 ? near : all;
    const spread = (x: StrikePick): number => { const mid = (x.c.bid + x.c.ask) / 2; return mid > 0 && x.c.bid > 0 ? (x.c.ask - x.c.bid) / mid : 9; };
    const score = (x: StrikePick): number => x.c.openInterest / (1 + ((x.strike - target) / (0.02 * price)) ** 2);
    const best = [...pool].sort((a, b) =>
      Number(b.c.openInterest > 0 && b.c.bid > 0) - Number(a.c.openInterest > 0 && a.c.bid > 0)
      || score(b) - score(a)
      || spread(a) - spread(b)
      || Math.abs(a.strike - target) - Math.abs(b.strike - target))[0];
    if (!best) return null;
    return {
      code: best.c.symbol.replace(/\s+/g, ""),
      expiry: best.expKey.slice(0, 10),
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
// has no chain (not optionable) or the fetch fails. Liquidity first: among
// every expiry in the window, strikes within 6% of the price of the target,
// on either side of the money, are ranked by open interest discounted by
// distance (a strike 2% of the price from the target counts half), then by
// the bid/ask spread; contracts with no open interest or no bid lose to any
// that have them. A listed contract with open
// interest beats the nearest Friday with none (2026-09-24: the first Friday
// VKTX put had OI 0 while the October monthly held 820).
export async function pickCboeContract(symbol: string, price: number, right: "C" | "P", otmPct: number, now: number, minDays = 7, maxDays = 45): Promise<ContractPick | null> {
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
    }).filter((x): x is NonNullable<typeof x> => x !== null && x.right === right && x.expiry >= minExpiry && x.expiry <= maxExpiry);
    if (parsed.length === 0) return null;
    const target = right === "C" ? price * (1 + otmPct / 100) : price * (1 - otmPct / 100);
    // Either side of the money within 6% of the target: after a gap the liquid strikes are often in the money
    // (2026-09-24: MGM's out-of-the-money puts had OI 12 to 49; the in-the-money 34 put 154).
    const near = parsed.filter((x) => Math.abs(x.strike - target) <= price * 0.06);
    const pool = near.length > 0 ? near : parsed;
    const spread = (x: typeof parsed[number]): number => { const mid = (x.o.bid + x.o.ask) / 2; return mid > 0 && x.o.bid > 0 ? (x.o.ask - x.o.bid) / mid : 9; };
    // Open interest discounted by distance from the target (a strike 2% of the price away counts half).
    const score = (x: typeof parsed[number]): number => x.o.open_interest / (1 + ((x.strike - target) / (0.02 * price)) ** 2);
    const best = [...pool].sort((a, b) =>
      Number(b.o.open_interest > 0 && b.o.bid > 0) - Number(a.o.open_interest > 0 && a.o.bid > 0)
      || score(b) - score(a)
      || spread(a) - spread(b)
      || Math.abs(a.strike - target) - Math.abs(b.strike - target))[0];
    return {
      code: best.o.option,
      expiry: `20${best.expiry.slice(0, 2)}-${best.expiry.slice(2, 4)}-${best.expiry.slice(4, 6)}`,
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

