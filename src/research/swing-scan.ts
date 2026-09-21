// Oversold-bounce swing scan (H-BOUNCE, docs/swing-registration-2026-09-21.md).
//
//   npm run scan:swing                    # after the close, or before 09:00 next day
//   npm run scan:swing -- --max-names 800 --min-drop 2.5
//   npm run scan:swing -- --provider schwab
//
// Signals are defined on daily closes, so run after 16:00 ET (today's bar is
// final) or before the next open (same signals). Running during the session
// evaluates the partial bar and says so. For every universe name: close above
// the 200-day average, three consecutive lower closes, three-day decline of
// at least 1.5 ATR(14), 20-day dollar volume at least $30M. Prints the
// breadth count (how many names qualify universe-wide), which the diagnostic
// showed is what separates market-wide panics that bounce from idiosyncratic
// disasters that do not, the SPY-versus-50-day regime, and the candidates
// ranked by drop size with an at-the-money call 14 to 35 days out.
// Entry is the next open; exit on a close above the 5-day average; stop two
// ATR below entry; time limit five sessions. Read-only; never places orders.

import { createLogger, setLogLevel } from "../core/logger.js";
import { etParts } from "../utils/time.js";
import { YahooHistoricalBars } from "../data/yahoo-historical.js";
import { loadUniverse } from "./universe.js";
import { parseProvider, schwabSession, type ProviderChoice } from "./schwab-session.js";
import { pickCboeContract, pickSchwabContract, type ContractPick } from "./contract-pick.js";
import type { Bar } from "../core/types.js";

const log = createLogger("swing-scan");

const MIN_DOLLAR_VOL = 30_000_000;
const BREADTH_GATE = 30;      // qualifying names universe-wide; below this the diagnostic lost money
const BREADTH_STRONG = 75;    // best results

interface Args { maxNames: number; minDrop: number; top: number; chains: boolean; provider: ProviderChoice }

function parseArgs(argv: readonly string[]): Args {
  const out: Args = { maxNames: 0, minDrop: 1.5, top: 15, chains: true, provider: "auto" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--max-names") out.maxNames = Number(argv[++i]);
    else if (a === "--min-drop") out.minDrop = Number(argv[++i]);
    else if (a === "--top") out.top = Number(argv[++i]);
    else if (a === "--no-chains") out.chains = false;
    else if (a === "--provider") out.provider = parseProvider(argv[++i]);
  }
  return out;
}

interface Signal {
  readonly symbol: string;
  readonly date: string;
  readonly close: number;
  readonly dropAtr: number;
  readonly dropPct: number;
  readonly atr: number;
  readonly sma5: number;
  readonly sma200: number;
  readonly dollarVol20: number;
  contract?: ContractPick | null;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  setLogLevel("warn");
  const uni = loadUniverse();
  if (!uni) throw new Error("No universe file; run npm run universe:build first");
  const names = (args.maxNames > 0 ? uni.entries.slice(0, args.maxNames) : uni.entries).map((e) => e.symbol);
  const yahoo = new YahooHistoricalBars();
  const now = Date.now();
  const p = etParts(now);
  const duringSession = p.hour * 60 + p.minute >= 9 * 60 + 30 && p.hour * 60 + p.minute < 16 * 60 && p.dayOfWeek >= 1 && p.dayOfWeek <= 5;
  const startMs = now - 1100 * 86_400_000;
  const session = await schwabSession(args.provider);

  const spy = await yahoo.fetch({ symbol: "SPY", interval: "1d", startMs, endMs: now, includePrePost: false });
  const spyClose = spy.map((b) => b.close);
  const spyAbove50 = spyClose.length >= 50 && spyClose[spyClose.length - 1] > mean(spyClose.slice(-50));

  const signals: Signal[] = [];
  let evaluated = 0;
  let failed = 0;
  const startedAt = Date.now();
  for (let i = 0; i < names.length; i++) {
    try {
      const bars = await yahoo.fetch({ symbol: names[i], interval: "1d", startMs, endMs: now, includePrePost: false });
      const s = evaluate(names[i], bars, args.minDrop);
      evaluated++;
      if (s) signals.push(s);
    } catch { failed++; }
    if ((i + 1) % 400 === 0) process.stdout.write(`  ${i + 1}/${names.length} (${((Date.now() - startedAt) / 60_000).toFixed(1)} min)\n`);
  }
  signals.sort((a, b) => b.dropAtr - a.dropAtr);
  const shown = signals.slice(0, args.top);

  if (args.chains) {
    for (let i = 0; i < shown.length; i++) {
      const s = shown[i];
      shown[i].contract = session.rest ? await pickSchwabContract(session.rest, s.symbol, s.close, "C", 0, now, 14, 35) : await pickCboeContract(s.symbol, s.close, "C", 0, now, 14, 35);
    }
  }

  const asOf = signals[0]?.date ?? spy.length ? etParts(spy[spy.length - 1].timestamp).date : "n/a";
  const breadth = signals.length;
  const verdict = breadth >= BREADTH_STRONG ? "TRADE (strong panic breadth)" : breadth >= BREADTH_GATE ? "TRADE (breadth gate met)" : "STAND ASIDE (breadth below gate; the diagnostic lost money on these days)";
  process.stdout.write(`\n===== Oversold-bounce swing scan, bars through ${asOf} =====\n`);
  if (duringSession) process.stdout.write(`WARNING: run during the session; today's bar is partial. Re-run after 16:00 ET for final signals.\n`);
  process.stdout.write(`Evaluated ${evaluated} names (${failed} failed), ${((Date.now() - startedAt) / 60_000).toFixed(1)} min. Contracts via ${session.rest ? `Schwab live chain (${session.reason})` : "Cboe delayed chain (closing marks)"}.\n`);
  process.stdout.write(`Breadth: ${breadth} qualifying names  ->  ${verdict}\n`);
  process.stdout.write(`SPY regime: ${spyAbove50 ? "above" : "below"} its 50-day (the diagnostic did better below: +0.68%/trade vs +0.07%).\n`);
  process.stdout.write(`\nCandidates ranked by drop size (largest first; 2.5+ ATR did best on breadth days):\n`);
  process.stdout.write(`  ${"Sym".padEnd(6)}${"Close".padStart(9)}${"Drop ATR".padStart(9)}${"3d %".padStart(8)}${"ATR".padStart(8)}${"SMA5 (target ref)".padStart(18)}${"Stop ref (close-2ATR)".padStart(22)}${"$vol20".padStart(8)}  Contract (ATM call, 14-35d)\n`);
  for (const s of shown) {
    const c = s.contract;
    const contract = c === undefined ? "(chains off)" : c === null ? "no listed options" : `${c.code}  ${c.expiry} ${c.strike}C  ${c.bid.toFixed(2)}/${c.ask.toFixed(2)}${c.delta !== null ? ` d${c.delta.toFixed(2)}` : ""} oi ${c.openInterest}${c.openInterest < 50 ? " THIN" : ""}`;
    process.stdout.write(`  ${s.symbol.padEnd(6)}${s.close.toFixed(2).padStart(9)}${s.dropAtr.toFixed(2).padStart(9)}${s.dropPct.toFixed(1).padStart(8)}${s.atr.toFixed(2).padStart(8)}${s.sma5.toFixed(2).padStart(18)}${(s.close - 2 * s.atr).toFixed(2).padStart(22)}${(s.dollarVol20 / 1e6).toFixed(0).padStart(7)}M  ${contract}\n`);
  }
  if (signals.length > shown.length) process.stdout.write(`  ... ${signals.length - shown.length} more (use --top to show)\n`);
  process.stdout.write(`\nRules (H-BOUNCE as tested): enter at the next open; exit on the first close above the 5-day average; stop on a close 2 ATR below entry; out after 5 sessions regardless. Trade only when breadth is at or above ${BREADTH_GATE}; prefer drops of 2.5 ATR or more. Average edge is small and frequent (about +0.4%/trade on a 5-slot book on breadth days, 65% win): this is a stock strategy first; the option is optional and must be at-the-money with a tight spread.\n\n`);
}

function evaluate(symbol: string, bars: readonly Bar[], minDrop: number): Signal | null {
  if (bars.length < 210) return null;
  const b = [...bars].sort((x, y) => x.timestamp - y.timestamp);
  const n = b.length;
  const c = b.map((x) => x.close);
  const t = n - 1;
  const dollarVol20 = mean(b.slice(-20).map((x) => x.close * x.volume));
  if (dollarVol20 < MIN_DOLLAR_VOL) return null;
  const sma200 = mean(c.slice(-200));
  if (!(c[t] > sma200)) return null;
  if (!(c[t] < c[t - 1] && c[t - 1] < c[t - 2] && c[t - 2] < c[t - 3])) return null;
  const tr: number[] = [];
  for (let i = t - 13; i <= t; i++) tr.push(Math.max(b[i].high - b[i].low, Math.abs(b[i].high - c[i - 1]), Math.abs(b[i].low - c[i - 1])));
  const atr = mean(tr);
  const drop = c[t - 3] - c[t];
  if (!(atr > 0) || drop < minDrop * atr) return null;
  return { symbol, date: etParts(b[t].timestamp).date, close: c[t], dropAtr: drop / atr, dropPct: (c[t] / c[t - 3] - 1) * 100, atr, sma5: mean(c.slice(-5)), sma200, dollarVol20 };
}

function mean(a: readonly number[]): number { return a.reduce((s, x) => s + x, 0) / (a.length || 1); }

main().catch((err) => { process.stderr.write(`FATAL: ${err instanceof Error ? err.message : String(err)}\n`); process.exit(1); });
