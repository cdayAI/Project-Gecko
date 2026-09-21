// Pre-market gap scanner for catalyst gap-and-go setups.
//
//   npm run scan:gap                      # default universe
//   npm run scan:gap -- --min-gap 3       # only gaps >= 3%
//   npm run scan:gap -- --symbols AMD,HOOD
//
// Run between 08:00 and 09:25 ET. For every symbol it pulls today's
// pre-market prints (Yahoo 5m bars incl. pre/post) and the daily history,
// then ranks gaps that are also breaking structure: above the 20-day high,
// near or above the 52-week high, with the sector ETF moving the same way.
// For each candidate it names the option contract to have loaded before
// the open (expiry at least 7 calendar days out, strike about 2.5% out of
// the money) and prints the entry rule. It does not fetch option quotes;
// the operator reads the live quote at 09:30 and applies the cap rule.
//
// Read-only. Never places orders. Yahoo pre-market bars carry no volume, so
// pre-market volume is not a filter here.

import { createLogger, setLogLevel } from "../core/logger.js";
import { etParts } from "../utils/time.js";
import { YahooHistoricalBars } from "../data/yahoo-historical.js";
import type { Bar } from "../core/types.js";

const log = createLogger("gap-scan");

const DEFAULT_UNIVERSE = `SPY QQQ IWM SMH XBI XLF XLE XLK XLV XLI XLY
AAPL MSFT NVDA AMZN META GOOGL TSLA AVGO AMD NFLX CRM ORCL ADBE INTC MU QCOM ARM TSM ASML SMCI DELL HPQ SNDK WDC STX
PLTR SNOW CRWD PANW ZS NET DDOG MDB SHOP UBER ABNB COIN HOOD SOFI AFRM UPST PYPL XYZ V MA
JPM BAC C WFC GS MS SCHW BLK AXP COF KKR
XOM CVX OXY DVN SLB HAL FCX NEM AA CLF NUE STLD
BA LMT RTX NOC GE CAT DE HON UNP UPS FDX DAL UAL AAL LUV CCL RCL NCLH MAR
HD LOW TGT WMT COST NKE SBUX MCD CMG DIS WBD ROKU SPOT LULU
PFE MRK JNJ LLY NVO ABBV BMY AMGN GILD MRNA BNTX CRSP VRTX REGN UNH CVS HIMS TEM ISRG
ENPH FSLR RUN PLUG OKLO SMR NNE CEG VST NRG
RKLB ASTS LUNR ACHR JOBY SPCX
MARA RIOT CLSK IREN WULF CIFR CORZ HUT MSTR
IONQ RGTI QBTS QUBT
SOUN BBAI AI U RBLX SNAP PINS DKNG
RIVN LCID NIO XPEV LI F GM
BABA JD PDD BIDU BILI
GME AMC T VZ TMUS`.split(/\s+/).filter(Boolean);

// Sector proxy per symbol for the confirmation column. Unlisted names use SPY.
const SECTOR: Record<string, string> = Object.fromEntries([
  ...["NVDA", "AMD", "AVGO", "INTC", "MU", "QCOM", "ARM", "TSM", "ASML", "SMCI", "DELL", "HPQ", "SNDK", "WDC", "STX"].map((s) => [s, "SMH"]),
  ...["MRNA", "BNTX", "CRSP", "VRTX", "REGN", "GILD", "AMGN", "HIMS", "TEM"].map((s) => [s, "XBI"]),
  ...["JPM", "BAC", "C", "WFC", "GS", "MS", "SCHW", "BLK", "AXP", "COF", "KKR", "HOOD", "SOFI", "AFRM", "UPST", "PYPL", "XYZ", "V", "MA", "COIN"].map((s) => [s, "XLF"]),
  ...["XOM", "CVX", "OXY", "DVN", "SLB", "HAL"].map((s) => [s, "XLE"]),
  ...["AAPL", "MSFT", "CRM", "ORCL", "ADBE", "PLTR", "SNOW", "CRWD", "PANW", "ZS", "NET", "DDOG", "MDB", "SHOP", "IONQ", "RGTI", "QBTS", "QUBT", "SOUN", "BBAI", "AI", "U"].map((s) => [s, "XLK"]),
  ...["PFE", "MRK", "JNJ", "LLY", "NVO", "ABBV", "BMY", "UNH", "CVS", "ISRG"].map((s) => [s, "XLV"]),
  ...["BA", "LMT", "RTX", "NOC", "GE", "CAT", "DE", "HON", "UNP", "UPS", "FDX", "DAL", "UAL", "AAL", "LUV", "RKLB", "ASTS", "LUNR", "ACHR", "JOBY", "SPCX"].map((s) => [s, "XLI"]),
  ...["AMZN", "TSLA", "HD", "LOW", "TGT", "NKE", "SBUX", "MCD", "CMG", "CCL", "RCL", "NCLH", "MAR", "LULU", "RIVN", "LCID", "NIO", "XPEV", "LI", "F", "GM", "GME", "AMC", "ABNB", "UBER", "DKNG", "RBLX"].map((s) => [s, "XLY"]),
  ...["MARA", "RIOT", "CLSK", "IREN", "WULF", "CIFR", "CORZ", "HUT", "MSTR"].map((s) => [s, "COIN"]),
]);

interface Args {
  symbols: readonly string[];
  minGapPct: number;
  top: number;
}

function parseArgs(argv: readonly string[]): Args {
  const out: Args = { symbols: DEFAULT_UNIVERSE, minGapPct: 2.5, top: 12 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--symbols") out.symbols = (argv[++i] ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    else if (a === "--min-gap") out.minGapPct = Number(argv[++i]);
    else if (a === "--top") out.top = Number(argv[++i]);
  }
  return out;
}

interface Candidate {
  readonly symbol: string;
  readonly premarketLast: number;
  readonly premarketHigh: number;
  readonly premarketLow: number;
  readonly priorClose: number;
  readonly gapPct: number;
  readonly high20: number;
  readonly high252: number;
  readonly aboveHigh20: boolean;
  readonly above52w: boolean;
  readonly atr: number;
  readonly atrPct: number;
  readonly sector: string;
  readonly sectorGapPct: number | null;
  readonly score: number;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  setLogLevel("warn");
  const yahoo = new YahooHistoricalBars();
  const now = Date.now();
  const today = etParts(now).date;

  const sectorGap = new Map<string, number>();
  const rows: Candidate[] = [];
  const failed: string[] = [];

  // Sector ETFs first so their gaps are available for the confirmation column.
  const ordered = [...new Set([...["SPY", "QQQ", "IWM", "SMH", "XBI", "XLF", "XLE", "XLK", "XLV", "XLI", "XLY", "COIN"], ...args.symbols])];

  for (const symbol of ordered) {
    try {
      const intraday = await yahoo.fetch({ symbol, interval: "5m", startMs: now - 3 * 86_400_000, endMs: now, includePrePost: true, cache: false });
      const daily = await yahoo.fetch({ symbol, interval: "1d", startMs: now - 400 * 86_400_000, endMs: now, includePrePost: false });
      const pre = intraday.filter((b) => etParts(b.timestamp).date === today);
      const priorDaily = daily.filter((b) => etParts(b.timestamp).date < today);
      if (priorDaily.length < 30) continue;
      const priorClose = priorDaily[priorDaily.length - 1].close;
      const last = pre.length > 0 ? pre[pre.length - 1].close : priorClose;
      const gapPct = (last / priorClose - 1) * 100;
      if (["SPY", "QQQ", "IWM", "SMH", "XBI", "XLF", "XLE", "XLK", "XLV", "XLI", "XLY", "COIN"].includes(symbol)) sectorGap.set(symbol, gapPct);
      if (!args.symbols.includes(symbol)) continue;
      if (pre.length === 0) continue;

      const high20 = Math.max(...priorDaily.slice(-20).map((b) => b.high));
      const high252 = Math.max(...priorDaily.slice(-252).map((b) => b.high));
      const atr = averageTrueRange(priorDaily, 14);
      const sector = SECTOR[symbol] ?? "SPY";
      const sectorGapPct = sectorGap.get(sector) ?? null;
      const premarketHigh = Math.max(...pre.map((b) => b.high));
      const premarketLow = Math.min(...pre.map((b) => b.low));
      const aboveHigh20 = last > high20;
      const above52w = last > high252;
      const score = Math.abs(gapPct)
        + (aboveHigh20 ? 3 : 0)
        + (above52w ? 4 : 0)
        + (sectorGapPct !== null && Math.sign(sectorGapPct) === Math.sign(gapPct) && Math.abs(sectorGapPct) >= 0.5 ? 2 : 0);
      rows.push({ symbol, premarketLast: last, premarketHigh, premarketLow, priorClose, gapPct, high20, high252, aboveHigh20, above52w, atr, atrPct: atr / last * 100, sector, sectorGapPct, score });
    } catch (err) {
      failed.push(symbol);
      log.debug("Symbol failed", { symbol, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const ups = rows.filter((r) => r.gapPct >= args.minGapPct).sort((a, b) => b.score - a.score).slice(0, args.top);
  const downs = rows.filter((r) => r.gapPct <= -args.minGapPct).sort((a, b) => b.score - a.score).slice(0, args.top);

  const p = etParts(now);
  process.stdout.write(`\n===== Pre-market gap scan ${today} ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")} ET =====\n`);
  process.stdout.write(`Sector tape: ${[...sectorGap.entries()].map(([k, v]) => `${k} ${v >= 0 ? "+" : ""}${v.toFixed(2)}%`).join("  ")}\n`);
  process.stdout.write(`Universe ${args.symbols.length}, priced ${rows.length}, failed ${failed.length}${failed.length ? ` (${failed.join(",")})` : ""}, min gap ${args.minGapPct}%\n`);

  printTable("GAP UP (long candidates)", ups, "C");
  printTable("GAP DOWN (put candidates)", downs, "P");

  process.stdout.write(`\nEntry rule (catalyst gap above prior highs): no pre-market orders. Enter on the first 5-minute candle that CLOSES above the pre-market high (earliest 09:35), with the sector ETF green. Stop: 5-minute close below the 09:30 candle low. Targets: +1 ATR (half), +1.5 ATR (rest). Time exit 15:45. Skip if the stock opens more than 1.5% above its pre-market high (already chased) or if the sector ETF is red at 09:35.\n`);
  process.stdout.write(`Option: contract named per row (expiry >= 7 days, strike ~2.5% OTM). Read the live quote at 09:30; pay at most 10% over that mid. Max loss is the full premium; plan the stop on the stock, not the option.\n\n`);
}

function printTable(title: string, rows: readonly Candidate[], right: "C" | "P"): void {
  process.stdout.write(`\n${title}\n`);
  if (rows.length === 0) { process.stdout.write("  none\n"); return; }
  process.stdout.write(`  ${"Sym".padEnd(6)}${"Pre-mkt".padStart(9)}${"Gap%".padStart(8)}${"PM high".padStart(9)}${"PM low".padStart(9)}${"20d hi".padStart(9)}${"52w hi".padStart(9)}  >20d  >52w  ${"Sector".padEnd(12)}${"ATR%".padStart(6)}  Contract to load\n`);
  for (const r of rows) {
    const sec = `${r.sector} ${r.sectorGapPct === null ? "n/a" : (r.sectorGapPct >= 0 ? "+" : "") + r.sectorGapPct.toFixed(1) + "%"}`;
    const strike = roundStrike(right === "C" ? r.premarketLast * 1.025 : r.premarketLast * 0.975, r.premarketLast);
    const expiry = nextExpiry(Date.now(), 7);
    process.stdout.write(`  ${r.symbol.padEnd(6)}${r.premarketLast.toFixed(2).padStart(9)}${((r.gapPct >= 0 ? "+" : "") + r.gapPct.toFixed(2)).padStart(8)}${r.premarketHigh.toFixed(2).padStart(9)}${r.premarketLow.toFixed(2).padStart(9)}${r.high20.toFixed(2).padStart(9)}${r.high252.toFixed(2).padStart(9)}  ${r.aboveHigh20 ? " Y " : " - "}   ${r.above52w ? " Y " : " - "}   ${sec.padEnd(12)}${r.atrPct.toFixed(1).padStart(6)}  ${expiry} ${strike}${right}  (stop ref: 09:30 low; targets +${r.atr.toFixed(2)} / +${(r.atr * 1.5).toFixed(2)})\n`);
  }
}

function averageTrueRange(bars: readonly Bar[], n: number): number {
  const tr: number[] = [];
  for (let i = bars.length - n; i < bars.length; i++) {
    const prev = bars[i - 1].close;
    tr.push(Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - prev), Math.abs(bars[i].low - prev)));
  }
  return tr.reduce((s, x) => s + x, 0) / tr.length;
}

// Listed strike increments by price: $0.50 under $25, $1 under $200, $2.50 under $500 for
// most names, $5 above. Good enough to name the contract; the operator confirms on the chain.
function roundStrike(target: number, price: number): number {
  const inc = price < 25 ? 0.5 : price < 200 ? 1 : price < 500 ? 2.5 : 5;
  return Math.round(target / inc) * inc;
}

// Next Friday at least minDays out, as YYYY-MM-DD in ET.
function nextExpiry(nowMs: number, minDays: number): string {
  for (let d = minDays; d < minDays + 8; d++) {
    const p = etParts(nowMs + d * 86_400_000);
    if (p.dayOfWeek === 5) return p.date;
  }
  return etParts(nowMs + (minDays + 7) * 86_400_000).date;
}

main().catch((err) => {
  process.stderr.write(`FATAL: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
