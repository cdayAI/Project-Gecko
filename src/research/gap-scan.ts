// Pre-market gap scanner for catalyst gap-and-go setups.
//
//   npm run scan:gap                          # whole liquid optionable universe
//   npm run scan:gap -- --max-names 800       # top names by dollar volume
//   npm run scan:gap -- --min-gap 3 --top 15
//   npm run scan:gap -- --symbols AMD,HOOD    # explicit list, stats fetched live
//   npm run scan:gap -- --provider schwab     # Schwab Trader API (thinkorswim data)
//   npm run schwab:check                      # bounded Schwab connectivity check (no screen)
//
// Providers: "auto" (default) uses Schwab when the Windows DPAPI vault or
// SCHWAB_CLIENT_ID/SECRET plus data/oauth-tokens.json are available, otherwise
// Yahoo. Schwab
// batches 100 quotes per request (real-time, with pre-market volume), pulls
// pre-market high/low from extended-hours minute bars for finalists, and
// names the contract from the live chain with Greeks. Strike distance is 0.6
// ATR out of the money, capped at 2.5% of price, so low-volatility names do
// not get near-worthless strikes; expiries prefer the first standard Friday
// between 7 and 21 days out. Yahoo is one 5-minute
// request per name with no pre-market volume; contracts come from Cboe's
// delayed chain.
//
// Run between 08:00 and 09:25 ET. Universe mode reads data/universe/universe.json
// (build it with `npm run universe:build`), pulls one 5-minute request per
// symbol for today's pre-market prints, computes the gap against the prior
// session close, and flags structure from the cached stats (20-day high,
// 52-week high, ATR). Finalists are checked against Cboe's delayed option
// chain to confirm listed options and name the actual contract to load:
// nearest expiry at least 7 days out, listed strike nearest 2.5% out of
// the money, with the chain's last marks (prior-close marks before 09:30).
//
// Read-only. Never places orders. Yahoo pre-market bars carry no volume.

import { createLogger, setLogLevel } from "../core/logger.js";
import type { SchwabRest } from "../brokers/schwab/rest.js";
import { parseProvider, schwabSession, type ProviderChoice } from "./schwab-session.js";
import { pickCboeContract, pickSchwabContract, type ContractPick } from "./contract-pick.js";
import { etParts } from "../utils/time.js";
import { YahooHistoricalBars } from "../data/yahoo-historical.js";
import { loadUniverse, statsFromDaily, type UniverseEntry } from "./universe.js";
import type { Bar } from "../core/types.js";

const log = createLogger("gap-scan");

const FALLBACK_LIST = `AAPL MSFT NVDA AMZN META GOOGL TSLA AVGO AMD NFLX CRM ORCL INTC MU QCOM ARM SMCI DELL
PLTR SNOW CRWD PANW ZS NET DDOG SHOP UBER ABNB COIN HOOD SOFI AFRM UPST PYPL
JPM BAC C WFC GS MS SCHW AXP XOM CVX OXY FCX NEM CLF NUE BA LMT GE CAT DE UNP UPS FDX DAL UAL AAL CCL RCL NCLH
HD LOW TGT WMT COST NKE SBUX MCD CMG DIS WBD ROKU PFE MRK JNJ LLY NVO ABBV AMGN GILD MRNA BNTX CRSP VRTX REGN UNH HIMS
ENPH FSLR PLUG OKLO SMR NNE VST RKLB ASTS LUNR ACHR JOBY SPCX MARA RIOT CLSK IREN WULF CIFR CORZ HUT MSTR
IONQ RGTI QBTS QUBT SOUN BBAI AI U RBLX SNAP PINS DKNG RIVN LCID NIO XPEV LI F GM BABA JD PDD BIDU BILI GME AMC`.split(/\s+/).filter(Boolean);

const TAPE = ["SPY", "QQQ", "IWM", "SMH", "XBI", "XLF", "XLE", "XLK", "XLV", "XLI", "XLY"] as const;
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";

interface Args {
  symbols: readonly string[] | null;   // explicit list overrides the universe file
  minGapPct: number;
  top: number;
  maxNames: number;
  chains: boolean;
  provider: ProviderChoice;
  minPmVolume: number;                 // Schwab only: pre-market shares traded
  checkConnection: boolean;            // Schwab only: probe quotes/history/chain and exit
}

function parseArgs(argv: readonly string[]): Args {
  // Default minimum gap 5%: the registered tests found 3 to 5% gaps lost money.
  const out: Args = { symbols: null, minGapPct: 5, top: 12, maxNames: 1500, chains: true, provider: "auto", minPmVolume: 25_000, checkConnection: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--symbols") out.symbols = (argv[++i] ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    else if (a === "--min-gap") out.minGapPct = Number(argv[++i]);
    else if (a === "--top") out.top = Number(argv[++i]);
    else if (a === "--max-names") out.maxNames = Number(argv[++i]);
    else if (a === "--no-chains") out.chains = false;
    else if (a === "--provider") out.provider = parseProvider(argv[++i]);
    else if (a === "--min-pm-volume") out.minPmVolume = Number(argv[++i]);
    else if (a === "--check-connection") out.checkConnection = true;
  }
  return out;
}

interface Stats {
  readonly high20: number;
  readonly low20: number;
  readonly high252: number;
  readonly atr14: number;
  readonly avgDollarVol20: number;
}

interface Candidate {
  readonly symbol: string;
  readonly premarketLast: number;
  readonly premarketHigh: number;
  readonly premarketLow: number;
  readonly priorClose: number;
  readonly gapPct: number;
  readonly pmVolume: number | null;    // Schwab only
  readonly stats: Stats;
  readonly aboveHigh20: boolean;
  readonly above52w: boolean;
  readonly belowLow20: boolean;
  readonly score: number;
  contract?: ContractPick | null;    // filled for finalists; null = no listed options found
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  setLogLevel("warn");
  const yahoo = new YahooHistoricalBars();
  const now = Date.now();
  const today = etParts(now).date;

  // Universe: explicit list, else the built file, else the fallback list.
  let names: readonly string[];
  const cachedStats = new Map<string, Stats>();
  let source: string;
  if (args.symbols) {
    names = args.symbols; source = "cli list";
  } else {
    const uni = loadUniverse();
    if (uni) {
      const entries = uni.entries.slice(0, args.maxNames);
      names = entries.map((e) => e.symbol);
      for (const e of entries) cachedStats.set(e.symbol, pickStats(e));
      source = `universe file (${uni.entries.length} names, built ${uni.builtAt.slice(0, 16)}Z, using top ${entries.length} by dollar volume)`;
    } else {
      names = FALLBACK_LIST; source = "fallback list (run npm run universe:build)";
    }
  }

  // Data source.
  const session = await schwabSession(args.provider);
  const schwab = session.rest;
  if (args.checkConnection) {
    if (!schwab) throw new Error(`Connection check needs a Schwab session: ${session.reason}`);
    await checkSchwabConnection(schwab);
    return;
  }
  const providerName = schwab ? `schwab (real-time batch quotes; ${session.reason})` : `yahoo (5m bars, no pre-market volume) because ${session.reason}`;

  const startedAt = Date.now();
  const rows: Candidate[] = [];
  let failed = 0;
  let noPrints = 0;
  let thin = 0;
  const tape: string[] = [];

  const gaps = new Map<string, Gap>();
  if (schwab) {
    const all = [...TAPE, ...names];
    const got = await schwabGaps(schwab, all, today);
    for (const [k, v] of got) gaps.set(k, v);
  } else {
    for (const etf of TAPE) { const g = await gapFor(yahoo, etf, today, now); if (g) gaps.set(etf, g); }
  }
  for (const etf of TAPE) { const g = gaps.get(etf); if (g) tape.push(`${etf} ${g.gapPct >= 0 ? "+" : ""}${g.gapPct.toFixed(2)}%`); }

  for (let i = 0; i < names.length; i++) {
    const symbol = names[i];
    try {
      const g = schwab ? gaps.get(symbol) ?? null : await gapFor(yahoo, symbol, today, now);
      if (!g) { noPrints++; continue; }
      if (schwab && g.pmVolume !== null && g.pmVolume < args.minPmVolume) { thin++; continue; }
      let stats = cachedStats.get(symbol);
      if (!stats) {
        const daily = await yahoo.fetch({ symbol, interval: "1d", startMs: now - 400 * 86_400_000, endMs: now, includePrePost: false });
        const s = statsFromDaily(symbol, daily, today);
        if (!s) continue;
        stats = pickStats(s);
      }
      if (Math.abs(g.gapPct) < args.minGapPct) continue;
      const aboveHigh20 = g.premarketLast > stats.high20;
      const above52w = g.premarketLast > stats.high252;
      const belowLow20 = g.premarketLast < stats.low20;
      const structure = g.gapPct > 0 ? (aboveHigh20 ? 3 : 0) + (above52w ? 4 : 0) : (belowLow20 ? 3 : 0);
      rows.push({ symbol, ...g, stats, aboveHigh20, above52w, belowLow20, score: Math.abs(g.gapPct) + structure });
    } catch {
      failed++;
    }
    if (!schwab && (i + 1) % 300 === 0) process.stdout.write(`  scanned ${i + 1}/${names.length} (${((Date.now() - startedAt) / 60_000).toFixed(1)} min)\n`);
  }

  // Tiers from the registered tests: only 10%+ gaps held out of sample.
  const TRADE_GAP = 10;
  const tier = (list: Candidate[]): Candidate[] => [...list.filter((r) => Math.abs(r.gapPct) >= TRADE_GAP), ...list.filter((r) => Math.abs(r.gapPct) < TRADE_GAP)];
  const ups = tier(rows.filter((r) => r.gapPct > 0).sort((a, b) => b.score - a.score)).slice(0, args.top);
  const downs = tier(rows.filter((r) => r.gapPct < 0).sort((a, b) => b.score - a.score)).slice(0, args.top);

  // Finalists: Schwab quotes carry no pre-market high/low, so fill those from
  // extended-hours minute bars; then name the contract.
  for (const list of [ups, downs]) {
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      if (schwab) {
        const range = await premarketRange(schwab, yahoo, r.symbol, today, now);
        if (range) list[i] = { ...r, premarketHigh: range.high, premarketLow: range.low };
      }
      if (args.chains) {
        const right = list === ups ? "C" : "P";
        const otmPct = Math.min(2.5, 0.6 * (r.stats.atr14 / r.premarketLast) * 100);
        list[i].contract = schwab ? await pickSchwabContract(schwab, r.symbol, r.premarketLast, right, otmPct, now) : await pickCboeContract(r.symbol, r.premarketLast, right, otmPct, now);
      }
    }
  }

  const p = etParts(now);
  process.stdout.write(`\n===== Pre-market gap scan ${today} ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")} ET =====\n`);
  process.stdout.write(`Source: ${source}\nProvider: ${providerName}\n`);
  process.stdout.write(`Tape: ${tape.join("  ")}\n`);
  process.stdout.write(`Scanned ${names.length}: ${rows.length} gaps >= ${args.minGapPct}%, ${noPrints} without pre-market prints${schwab ? `, ${thin} below ${args.minPmVolume.toLocaleString()} pre-market shares` : ""}, ${failed} failed, ${((Date.now() - startedAt) / 60_000).toFixed(1)} min\n`);
  printTable(`GAP UP: TRADE CANDIDATES (gap >= ${TRADE_GAP}%, the only bucket positive out of sample)`, ups.filter((r) => r.gapPct >= TRADE_GAP));
  printTable("GAP UP: WATCH ONLY (5-10%; coin flip in the tests, needs a catalyst and 52w structure)", ups.filter((r) => r.gapPct < TRADE_GAP));
  printTable(`GAP DOWN: TRADE CANDIDATES (gap <= -${TRADE_GAP}%)`, downs.filter((r) => r.gapPct <= -TRADE_GAP));
  printTable("GAP DOWN: WATCH ONLY (-5 to -10%)", downs.filter((r) => r.gapPct > -TRADE_GAP));
  process.stdout.write(`\nEntry rule (H-GAP-GO as registered; see docs/gap-and-go-registration-2026-09-21.md): no pre-market orders. Enter on the first 5-minute candle that CLOSES beyond the pre-market extreme (earliest 09:35). Stop: 5-minute close back through the 09:30 candle's opposite extreme. Targets: 1 ATR (half), 1.5 ATR (rest). Time exit 15:45. Skip if the open is more than 1.5% beyond the pre-market extreme. Trade the 10%+ tier only (about 55-63% win on the stock, PF 1.5-1.8 in both test windows); the tests could not raise that win rate with tighter targets, time exits, wider stops or sector confirmation without losing money out of sample, so do not improvise those.\n`);
  process.stdout.write(schwab
    ? `Option marks are live from Schwab. Pay at most 10% over the mid at entry. Max loss is the full premium; the stop lives on the stock.\n\n`
    : `Option marks shown are the chain's last marks (prior close before 09:30). Read the live quote at 09:30 and pay at most 10% over that mid. Max loss is the full premium; the stop lives on the stock.\n\n`);
}

function pickStats(e: { high20: number; low20: number; high252: number; atr14: number; avgDollarVol20: number }): Stats {
  return { high20: e.high20, low20: e.low20, high252: e.high252, atr14: e.atr14, avgDollarVol20: e.avgDollarVol20 };
}

interface Gap {
  readonly premarketLast: number;
  readonly premarketHigh: number;
  readonly premarketLow: number;
  readonly priorClose: number;
  readonly gapPct: number;
  readonly pmVolume: number | null;
}

// One 5-minute request: today's pre-market prints plus the prior session's
// close (last bar at or before 16:00 ET on the most recent earlier date).
async function gapFor(yahoo: YahooHistoricalBars, symbol: string, today: string, now: number): Promise<Gap | null> {
  const bars = await yahoo.fetch({ symbol, interval: "5m", startMs: now - 5 * 86_400_000, endMs: now, includePrePost: true, cache: false });
  const todays = bars.filter((b) => etParts(b.timestamp).date === today);
  if (todays.length === 0) return null;
  const prior = bars.filter((b) => { const p = etParts(b.timestamp); return p.date < today && p.hour * 60 + p.minute <= 16 * 60 && p.hour * 60 + p.minute >= 9 * 60 + 30; });
  if (prior.length === 0) return null;
  const priorClose = prior[prior.length - 1].close;
  const last = todays[todays.length - 1].close;
  return {
    premarketLast: last,
    premarketHigh: Math.max(...todays.map((b) => b.high)),
    premarketLow: Math.min(...todays.map((b) => b.low)),
    priorClose,
    gapPct: (last / priorClose - 1) * 100,
    pmVolume: null,
  };
}

// ----- Schwab path -----

interface SchwabQuoteFields {
  readonly lastPrice?: number; readonly closePrice?: number; readonly totalVolume?: number; readonly tradeTime?: number;
}
// Before the open, the regular quote's totalVolume is the pre-market volume
// when no extended block is present.
function beforeOpenEt(now: number): boolean {
  const p = etParts(now);
  return p.hour * 60 + p.minute < 9 * 60 + 30;
}
interface SchwabExtended {
  readonly lastPrice?: number; readonly totalVolume?: number; readonly tradeTime?: number;
}

// Batch quotes, 100 per request. Pre-market last comes from the extended
// block when it carries a trade from today; the prior close is closePrice.
async function schwabGaps(rest: SchwabRest, symbols: readonly string[], today: string): Promise<Map<string, Gap>> {
  const out = new Map<string, Gap>();
  const preOpen = beforeOpenEt(Date.now());
  for (let i = 0; i < symbols.length; i += 100) {
    const chunk = symbols.slice(i, i + 100);
    let batch: Record<string, unknown>;
    try {
      batch = await rest.getQuotes(chunk);
    } catch (err) {
      log.warn("Schwab quote batch failed", { count: chunk.length, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    for (const [sym, raw] of Object.entries(batch)) {
      const q = raw as { quote?: SchwabQuoteFields; extended?: SchwabExtended };
      const quote = q.quote ?? {};
      const ext = q.extended;
      const priorClose = quote.closePrice ?? 0;
      if (!(priorClose > 0)) continue;
      const extIsToday = ext?.tradeTime !== undefined && etParts(ext.tradeTime).date === today;
      const last = extIsToday && ext?.lastPrice && ext.lastPrice > 0 ? ext.lastPrice : quote.lastPrice ?? 0;
      if (!(last > 0)) continue;
      out.set(sym.toUpperCase(), {
        premarketLast: last,
        premarketHigh: last,      // refined for finalists from minute bars
        premarketLow: last,
        priorClose,
        gapPct: (last / priorClose - 1) * 100,
        // Unknown stays null so the volume floor is not applied blindly.
        pmVolume: preOpen
          ? (typeof ext?.totalVolume === "number" || typeof quote.totalVolume === "number"
            ? Math.max(extIsToday ? ext?.totalVolume ?? 0 : 0, quote.totalVolume ?? 0)
            : null)
          : extIsToday && typeof ext?.totalVolume === "number" && ext.totalVolume > 0 ? ext.totalVolume : null,
      });
    }
  }
  return out;
}

// Pre-market high/low for a finalist: Schwab extended-hours minute bars for
// today (explicit window from 04:00 ET), falling back to Yahoo's 5-minute
// pre/post bars when Schwab returns none.
async function premarketRange(rest: SchwabRest, yahoo: YahooHistoricalBars, symbol: string, today: string, now: number): Promise<{ high: number; low: number; source: string } | null> {
  const p = etParts(now);
  const midnightEt = now - ((p.hour * 60 + p.minute) * 60_000 + p.second * 1000 + (now % 1000));
  const startDate = midnightEt + 4 * 3_600_000;
  try {
    const h = await rest.getPriceHistory({ symbol, periodType: "day", frequencyType: "minute", frequency: 1, startDate, endDate: now, needExtendedHoursData: true });
    const pre = h.candles.filter((c) => { const q = etParts(c.datetime); return q.date === today && q.hour * 60 + q.minute < 9 * 60 + 30; });
    if (pre.length > 0) return { high: Math.max(...pre.map((c) => c.high)), low: Math.min(...pre.map((c) => c.low)), source: "schwab" };
    log.debug("Schwab returned no pre-market candles", { symbol, candles: h.candles.length });
  } catch (err) {
    log.debug("Schwab minute bars failed", { symbol, error: err instanceof Error ? err.message : String(err) });
  }
  try {
    const bars = await yahoo.fetch({ symbol, interval: "5m", startMs: now - 2 * 86_400_000, endMs: now, includePrePost: true, cache: false });
    const pre = bars.filter((b) => { const q = etParts(b.timestamp); return q.date === today && q.hour * 60 + q.minute < 9 * 60 + 30; });
    if (pre.length > 0) return { high: Math.max(...pre.map((b) => b.high)), low: Math.min(...pre.map((b) => b.low)), source: "yahoo" };
  } catch {
    // fall through
  }
  return null;
}

// Bounded connectivity probe: SPY/QQQ quotes, one day of SPY minute history
// with extended hours, and a small SPY chain. No screen, no Yahoo, no orders.
async function checkSchwabConnection(rest: SchwabRest): Promise<void> {
  const startedAt = Date.now();
  const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
  const quotes = await rest.getQuotes(["SPY", "QQQ"]);
  for (const symbol of ["SPY", "QQQ"]) {
    const q = quotes[symbol];
    if (!q?.quote || !positive(q.quote.bidPrice) || !positive(q.quote.askPrice) || !positive(q.quote.lastPrice)) throw new Error(`Schwab connection check: missing ${symbol} quote`);
  }
  const history = await rest.getPriceHistory({ symbol: "SPY", periodType: "day", period: 1, frequencyType: "minute", frequency: 1, needExtendedHoursData: true });
  const usable = history.candles.filter((c) => positive(c.datetime) && [c.open, c.high, c.low, c.close].every(positive));
  const preMarket = usable.filter((c) => { const q = etParts(c.datetime); return q.hour * 60 + q.minute < 9 * 60 + 30; }).length;
  if (usable.length === 0) throw new Error("Schwab connection check: missing SPY history");
  const chain = await rest.getOptionChain({ symbol: "SPY", contractType: "ALL", strikeCount: 2, strategy: "SINGLE", fromDate: etParts(startedAt + 7 * 86_400_000).date, toDate: etParts(startedAt + 45 * 86_400_000).date });
  const contracts = [chain.callExpDateMap, chain.putExpDateMap].flatMap((m) => Object.values(m ?? {})).flatMap((strikes) => Object.values(strikes ?? {})).flat().filter((c) => positive(c.strikePrice) && positive(c.ask));
  if (contracts.length === 0) throw new Error("Schwab connection check: missing SPY option contracts");
  const quoteChecks = ["SPY", "QQQ"].map((symbol) => {
    const q = quotes[symbol];
    const t = q.quote.quoteTime;
    const ext = (q as { extended?: { totalVolume?: number; tradeTime?: number } }).extended;
    return { symbol, quoteTimeUtc: positive(t) ? new Date(t).toISOString() : null, ageSeconds: positive(t) ? Math.round((Date.now() - t) / 1000) : null, extendedBlock: ext !== undefined, extendedVolume: ext?.totalVolume ?? null };
  });
  process.stdout.write(`${JSON.stringify({
    status: "CONNECTED", checkedAtUtc: new Date().toISOString(), scope: "market-data-only",
    quotes: quoteChecks, history: { symbol: history.symbol, usableCandles: usable.length, preMarketCandles: preMarket },
    chain: { symbol: chain.symbol, reportedContracts: chain.numberOfContracts, usableContracts: contracts.length, isDelayed: typeof chain.isDelayed === "boolean" ? chain.isDelayed : null },
    qualification: "Connectivity only; no screening, orders or trade qualification.",
  }, null, 2)}\n`);
}

// Historical base rates from the registered gap-and-go test (docs/gap-and-go-
// registration-2026-09-21.md, 392 trades, Jul 24 to Sep 18 2026, 5 bps/side),
// shown per row so the operator sees which bucket a candidate belongs to.
// Descriptive, not a probability for the specific trade.
function historicalBucket(r: Candidate): string {
  const g = Math.abs(r.gapPct);
  const base = g >= 10 ? "gap10%+: 63% win, +1.06%/trade (n=74)" : g >= 5 ? "gap5-10%: 49% win, +0.12% (n=144)" : "gap3-5%: 40% win, -0.16% (n=174, lost)";
  return base + (r.gapPct > 0 && r.above52w ? "; long above 52w high: 65% win (n=34)" : "");
}

function printTable(title: string, rows: readonly Candidate[]): void {
  process.stdout.write(`\n${title}\n`);
  if (rows.length === 0) { process.stdout.write("  none\n"); return; }
  process.stdout.write(`  ${"Sym".padEnd(6)}${"Pre-mkt".padStart(9)}${"Gap%".padStart(8)}${"PM vol".padStart(8)}${"PM high".padStart(9)}${"PM low".padStart(9)}${"20d hi".padStart(9)}${"52w hi".padStart(9)} >20d >52w <20dLo ${"ATR".padStart(7)} ${"$vol20".padStart(7)}  Contract  |  historical bucket\n`);
  for (const r of rows) {
    const c = r.contract;
    const contract = c === undefined ? "(chains off)" : c === null ? "no listed options" : `${c.code}  ${c.expiry} ${c.strike}${c.right}  ${c.bid.toFixed(2)}/${c.ask.toFixed(2)}${c.delta !== null ? ` d${c.delta.toFixed(2)}` : ""} oi ${c.openInterest}${c.openInterest < 50 ? " THIN" : ""}`;
    const pmv = r.pmVolume === null ? "n/a" : r.pmVolume >= 1e6 ? (r.pmVolume / 1e6).toFixed(1) + "M" : (r.pmVolume / 1e3).toFixed(0) + "k";
    process.stdout.write(`  ${r.symbol.padEnd(6)}${r.premarketLast.toFixed(2).padStart(9)}${((r.gapPct >= 0 ? "+" : "") + r.gapPct.toFixed(2)).padStart(8)}${pmv.padStart(8)}${r.premarketHigh.toFixed(2).padStart(9)}${r.premarketLow.toFixed(2).padStart(9)}${r.stats.high20.toFixed(2).padStart(9)}${r.stats.high252.toFixed(2).padStart(9)}  ${r.aboveHigh20 ? "Y" : "-"}    ${r.above52w ? "Y" : "-"}    ${r.belowLow20 ? "Y" : "-"}   ${r.stats.atr14.toFixed(2).padStart(7)} ${(r.stats.avgDollarVol20 / 1e6).toFixed(0).padStart(6)}M  ${contract}  |  ${historicalBucket(r)}\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`FATAL: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
