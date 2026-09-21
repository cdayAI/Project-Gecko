// Pre-market gap scanner for catalyst gap-and-go setups.
//
//   npm run scan:gap                          # whole liquid optionable universe
//   npm run scan:gap -- --max-names 800       # top names by dollar volume
//   npm run scan:gap -- --min-gap 3 --top 15
//   npm run scan:gap -- --symbols AMD,HOOD    # explicit list, stats fetched live
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
const CBOE_CHAIN = "https://cdn.cboe.com/api/global/delayed_quotes/options";
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";

interface Args {
  symbols: readonly string[] | null;   // explicit list overrides the universe file
  minGapPct: number;
  top: number;
  maxNames: number;
  chains: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const out: Args = { symbols: null, minGapPct: 2.5, top: 12, maxNames: 1500, chains: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--symbols") out.symbols = (argv[++i] ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    else if (a === "--min-gap") out.minGapPct = Number(argv[++i]);
    else if (a === "--top") out.top = Number(argv[++i]);
    else if (a === "--max-names") out.maxNames = Number(argv[++i]);
    else if (a === "--no-chains") out.chains = false;
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
  readonly stats: Stats;
  readonly aboveHigh20: boolean;
  readonly above52w: boolean;
  readonly belowLow20: boolean;
  readonly score: number;
  contract?: ContractPick | null;    // filled for finalists; null = no listed options found
}

interface ContractPick {
  readonly code: string;
  readonly expiry: string;
  readonly strike: number;
  readonly right: "C" | "P";
  readonly bid: number;
  readonly ask: number;
  readonly delta: number | null;
  readonly openInterest: number;
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

  // Sector tape first.
  const tape: string[] = [];
  for (const etf of TAPE) {
    const g = await gapFor(yahoo, etf, today, now);
    if (g) tape.push(`${etf} ${g.gapPct >= 0 ? "+" : ""}${g.gapPct.toFixed(2)}%`);
  }

  const rows: Candidate[] = [];
  let failed = 0;
  let noPrints = 0;
  const startedAt = Date.now();
  for (let i = 0; i < names.length; i++) {
    const symbol = names[i];
    try {
      const g = await gapFor(yahoo, symbol, today, now);
      if (!g) { noPrints++; continue; }
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
    if ((i + 1) % 300 === 0) process.stdout.write(`  scanned ${i + 1}/${names.length} (${((Date.now() - startedAt) / 60_000).toFixed(1)} min)\n`);
  }

  const ups = rows.filter((r) => r.gapPct > 0).sort((a, b) => b.score - a.score).slice(0, args.top);
  const downs = rows.filter((r) => r.gapPct < 0).sort((a, b) => b.score - a.score).slice(0, args.top);

  if (args.chains) {
    for (const r of ups) r.contract = await pickContract(r.symbol, r.premarketLast, "C", now);
    for (const r of downs) r.contract = await pickContract(r.symbol, r.premarketLast, "P", now);
  }

  const p = etParts(now);
  process.stdout.write(`\n===== Pre-market gap scan ${today} ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")} ET =====\n`);
  process.stdout.write(`Source: ${source}\n`);
  process.stdout.write(`Tape: ${tape.join("  ")}\n`);
  process.stdout.write(`Scanned ${names.length}: ${rows.length} gaps >= ${args.minGapPct}%, ${noPrints} without pre-market prints, ${failed} failed, ${((Date.now() - startedAt) / 60_000).toFixed(1)} min\n`);
  printTable("GAP UP (long candidates)", ups);
  printTable("GAP DOWN (put candidates)", downs);
  process.stdout.write(`\nEntry rule (catalyst gap through prior highs/lows): no pre-market orders. Enter on the first 5-minute candle that CLOSES beyond the pre-market extreme (earliest 09:35), sector ETF confirming. Stop: 5-minute close back through the 09:30 candle's opposite extreme. Targets: 1 ATR (half), 1.5 ATR (rest). Time exit 15:45. Skip if the open is more than 1.5% beyond the pre-market extreme or the sector ETF disagrees at 09:35.\n`);
  process.stdout.write(`Option marks shown are the chain's last marks (prior close before 09:30). Read the live quote at 09:30 and pay at most 10% over that mid. Max loss is the full premium; the stop lives on the stock.\n\n`);
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
  };
}

interface CboeOption { option: string; bid: number; ask: number; delta?: number; open_interest: number }

// Name the listed contract from Cboe's delayed chain. null when the symbol
// has no chain (not optionable) or the fetch fails.
async function pickContract(symbol: string, price: number, right: "C" | "P", now: number): Promise<ContractPick | null> {
  try {
    const resp = await fetch(`${CBOE_CHAIN}/${symbol}.json`, { headers: { "User-Agent": USER_AGENT } });
    if (!resp.ok) return null;
    const json = (await resp.json()) as { data?: { options?: CboeOption[] } };
    const options = json.data?.options ?? [];
    if (options.length === 0) return null;
    const minExpiry = etParts(now + 7 * 86_400_000).date.replace(/-/g, "").slice(2);   // YYMMDD
    const parsed = options.map((o) => {
      const m = o.option.match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);
      return m ? { o, expiry: m[2], right: m[3] as "C" | "P", strike: Number(m[4]) / 1000 } : null;
    }).filter((x): x is NonNullable<typeof x> => x !== null && x.right === right && x.expiry >= minExpiry);
    if (parsed.length === 0) return null;
    const expiry = [...new Set(parsed.map((x) => x.expiry))].sort()[0];
    const target = right === "C" ? price * 1.025 : price * 0.975;
    const best = parsed.filter((x) => x.expiry === expiry).sort((a, b) => Math.abs(a.strike - target) - Math.abs(b.strike - target))[0];
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

function printTable(title: string, rows: readonly Candidate[]): void {
  process.stdout.write(`\n${title}\n`);
  if (rows.length === 0) { process.stdout.write("  none\n"); return; }
  process.stdout.write(`  ${"Sym".padEnd(6)}${"Pre-mkt".padStart(9)}${"Gap%".padStart(8)}${"PM high".padStart(9)}${"PM low".padStart(9)}${"20d hi".padStart(9)}${"52w hi".padStart(9)} >20d >52w <20dLo ${"ATR".padStart(7)} ${"$vol20".padStart(7)}  Contract (last marks)\n`);
  for (const r of rows) {
    const c = r.contract;
    const contract = c === undefined ? "(chains off)" : c === null ? "no listed options" : `${c.code}  ${c.expiry} ${c.strike}${c.right}  ${c.bid.toFixed(2)}/${c.ask.toFixed(2)}${c.delta !== null ? ` d${c.delta.toFixed(2)}` : ""} oi ${c.openInterest}`;
    process.stdout.write(`  ${r.symbol.padEnd(6)}${r.premarketLast.toFixed(2).padStart(9)}${((r.gapPct >= 0 ? "+" : "") + r.gapPct.toFixed(2)).padStart(8)}${r.premarketHigh.toFixed(2).padStart(9)}${r.premarketLow.toFixed(2).padStart(9)}${r.stats.high20.toFixed(2).padStart(9)}${r.stats.high252.toFixed(2).padStart(9)}  ${r.aboveHigh20 ? "Y" : "-"}    ${r.above52w ? "Y" : "-"}    ${r.belowLow20 ? "Y" : "-"}   ${r.stats.atr14.toFixed(2).padStart(7)} ${(r.stats.avgDollarVol20 / 1e6).toFixed(0).padStart(6)}M  ${contract}\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`FATAL: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
