// Scorecard: every call the morning packet made, replayed after the close
// with the tested rule and written down as paper records, so the operator
// judges the system by its record before any money goes in.
//
//   npm run score                                  # today's packet (the evening command runs this)
//   npm run score -- --date 2026-09-22 --provider yahoo
//
// Reads docs/daily/<date>/scan-gap.txt, which must be a pre-market run. Each
// row is a call: star, large, watch or mega-cap tier; long for a gap up,
// short for a gap down; pre-market high, low and ATR exactly as the packet
// printed them. The session's 5-minute bars (Schwab through the vault, else
// Yahoo) are replayed with src/backtest/gap-replay.ts: skip if the open is
// more than 1.5% beyond the extreme; the first 5-minute candle (09:30
// included) closing beyond it confirms, entry at the next candle's open, no
// signal after 11:30; stop on a 5-minute close through the 09:30 candle's
// opposite extreme; half at 1 ATR and the rest at 1.5 ATR, except mega-cap
// rows, which hold to 15:45 (T7); time exit 15:45. No slippage: these are the
// rule's prices, so real fills can be measured against them.
//
// Writes docs/log/auto/<date>.jsonl (triggered calls; npm run log -- report
// reads them) and docs/daily/<date>/score.md (every call, triggered or not,
// plus the running record). Re-scoring a date rewrites both. Read-only;
// never places orders.

import * as fs from "node:fs";
import * as path from "node:path";
import { createLogger, setLogLevel } from "../core/logger.js";
import type { Bar } from "../core/types.js";
import { YahooHistoricalBars } from "../data/yahoo-historical.js";
import type { SchwabRest } from "../brokers/schwab/rest.js";
import { etParts } from "../utils/time.js";
import { parseProvider, schwabSession, type ProviderChoice } from "./schwab-session.js";
import { readScanGap, type PacketRow } from "./packet-rows.js";
import { jevLabels } from "./packet-utils.js";
import { simulate, OPEN_CHASE_PCT, type ExitMode, type GapGoTrade } from "../backtest/gap-replay.js";
import type { TradeRecord } from "./trade-log.js";

const log = createLogger("scorecard");
const AUTO_DIR = path.join("docs", "log", "auto");
const OPEN_MIN = 9 * 60 + 30;
const CLOSE_MIN = 16 * 60;
const LAST_SIGNAL_MIN = 11 * 60 + 30;
const BLOCK_USD = 1000;

interface Args { readonly date: string; readonly provider: ProviderChoice }
type Outcome =
  | { readonly kind: "trade"; readonly t: GapGoTrade; readonly alt: GapGoTrade | null; readonly mode: ExitMode }
  | { readonly kind: "skipped"; readonly open: number }
  | { readonly kind: "no trigger"; readonly high: number; readonly low: number; readonly close: number }
  | { readonly kind: "invalid"; readonly detail: string }
  | { readonly kind: "no bars"; readonly detail: string };

function parseArgs(argv: readonly string[]): Args {
  let date = etParts(Date.now()).date;
  let provider: ProviderChoice = "auto";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--date") date = argv[++i] ?? date;
    else if (argv[i] === "--provider") provider = parseProvider(argv[++i]);
  }
  return { date, provider };
}

// Epoch ms for a wall-clock ET time on a date (EDT or EST).
function etMs(date: string, hhmm: string): number {
  for (const off of ["-04:00", "-05:00"]) {
    const t = Date.parse(`${date}T${hhmm}:00${off}`);
    const p = etParts(t);
    if (p.date === date && `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}` === hhmm) return t;
  }
  return Date.parse(`${date}T${hhmm}:00-05:00`);
}

function minuteOf(ts: number): number {
  const p = etParts(ts);
  return p.hour * 60 + p.minute;
}

async function fetchBars(rest: SchwabRest | null, yahoo: YahooHistoricalBars, symbol: string, date: string): Promise<{ bars: Bar[]; source: string }> {
  const start = etMs(date, "04:00");
  const end = etMs(date, "20:00");
  if (rest) {
    try {
      const h = await rest.getPriceHistory({ symbol, periodType: "day", frequencyType: "minute", frequency: 5, startDate: start, endDate: end, needExtendedHoursData: true });
      const bars = h.candles.map((c): Bar => ({ symbol, timestamp: c.datetime, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
      if (bars.length > 0) return { bars, source: "schwab" };
    } catch (err) {
      log.warn("Schwab bars failed, trying Yahoo", { symbol, date, error: err instanceof Error ? err.message : String(err) });
    }
  }
  const bars = await yahoo.fetch({ symbol, interval: "5m", startMs: start, endMs: end, includePrePost: true, cache: false });
  return { bars: [...bars], source: "yahoo" };
}

// The rule's extreme is the whole pre-market through 09:30; the packet printed a snapshot.
function effectiveRow(row: PacketRow, bars: readonly Bar[], date: string): PacketRow {
  const pre = bars.filter((b) => etParts(b.timestamp).date === date && minuteOf(b.timestamp) < OPEN_MIN);
  return pre.length ? { ...row, pmHigh: Math.max(...pre.map((b) => b.high)), pmLow: Math.min(...pre.map((b) => b.low)) } : row;
}

function scoreRow(row: PacketRow, bars: readonly Bar[], date: string): Outcome {
  const rth = bars.filter((b) => { const m = minuteOf(b.timestamp); return etParts(b.timestamp).date === date && m >= OPEN_MIN && m < CLOSE_MIN; }).sort((a, b) => a.timestamp - b.timestamp);
  if (rth.length < 3) return { kind: "no bars", detail: `${rth.length} regular-session bars` };
  const long = row.side === "long";
  const open = rth[0].open;
  if (long ? open > row.pmHigh * (1 + OPEN_CHASE_PCT / 100) : open < row.pmLow * (1 - OPEN_CHASE_PCT / 100)) return { kind: "skipped", open };
  const mode: ExitMode = row.tier === "mega" ? "hold" : "targets";
  const dir = long ? "LONG" : "SHORT";
  const t = simulate(row.symbol, date, dir, row.gapPct, false, rth, row.pmHigh, row.pmLow, row.atr, 0, mode);
  if (t) return { kind: "trade", t, alt: simulate(row.symbol, date, dir, row.gapPct, false, rth, row.pmHigh, row.pmLow, row.atr, 0, mode === "hold" ? "targets" : "hold"), mode };
  const confirmed = rth.some((b) => minuteOf(b.timestamp) <= LAST_SIGNAL_MIN && (long ? b.close > row.pmHigh : b.close < row.pmLow));
  if (confirmed) return { kind: "invalid", detail: `confirmed, but the stop (09:30 ${long ? "low" : "high"}) was not ${long ? "below" : "above"} the entry` };
  return { kind: "no trigger", high: Math.max(...rth.map((b) => b.high)), low: Math.min(...rth.map((b) => b.low)), close: rth[rth.length - 1].close };
}

// Catalyst as the packet saw it: Jev's label and the newest headline.
function catalystFor(date: string, symbol: string): string {
  const dir = path.join("docs", "daily", date);
  const label = jevLabels(path.join(dir, "jev.md")).get(symbol) ?? "";
  let headline = "";
  const news = path.join(dir, "news.md");
  if (fs.existsSync(news)) {
    const lines = fs.readFileSync(news, "utf-8").split("\n");
    const i = lines.findIndex((l) => l.startsWith(`## ${symbol} (`));
    const first = i >= 0 ? lines[i + 1] ?? "" : "";
    const m = first.match(/^- \S+ \[[^\]]*\] (.*?)(?: \(https?:\/\/\S+\))?$/);
    if (m) headline = m[1].slice(0, 110);
  }
  return headline ? `${label ? `${label}: ` : ""}${headline}` : "";
}

function r4(v: number): number {
  return Math.round(v * 10_000) / 10_000;
}

function pct(v: number): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function toRecord(row: PacketRow, o: Extract<Outcome, { kind: "trade" }>, date: string, catalyst: string, barsSource: string, packetTime: string): TradeRecord {
  const t = o.t;
  const sign = row.side === "long" ? 1 : -1;
  const blended = t.exits.reduce((s, e) => s + e.fraction * e.price, 0);
  const last = t.exits[t.exits.length - 1];
  const reason = last.reason === "eod" ? "time" : last.reason;
  return {
    id: `auto-${date}-${row.symbol}`,
    loggedAt: new Date().toISOString(),
    date, symbol: row.symbol, side: row.side, source: "gap", tier: row.tier,
    gapPct: Math.round(row.gapPct * 100) / 100,
    sector: `${row.sector} ${row.sectorPct === null ? "n/a" : `${row.sectorPct >= 0 ? "+" : ""}${row.sectorPct.toFixed(1)}%`}`,
    catalyst, taken: false, instrument: "stock",
    qty: r4(BLOCK_USD / t.entry),
    entry: r4(t.entry), entryTime: t.entryTime, stop: r4(t.stop),
    target1: o.mode === "targets" ? r4(t.entry + sign * row.atr) : undefined,
    target2: o.mode === "targets" ? r4(t.entry + sign * 1.5 * row.atr) : undefined,
    exit: r4(blended), exitTime: last.time,
    exitReason: reason === "target1" || reason === "target2" || reason === "stop" || reason === "time" ? reason : "manual",
    notes: `auto: rule replay of the ${packetTime} packet, ${o.mode === "hold" ? "hold to 15:45 (mega-cap, T7)" : "half at 1 ATR, rest at 1.5 ATR"}; exits ${t.exits.map((e) => `${Math.round(e.fraction * 100)}% ${e.reason} ${e.time} @ ${e.price.toFixed(2)}`).join(", ")}; the other exit would have made ${o.alt ? pct(o.alt.returnPct) : "n/a"}; bars ${barsSource}`,
  };
}

interface Agg { n: number; wins: number; sum: number; gw: number; gl: number }
function agg(rets: readonly number[]): Agg {
  const a: Agg = { n: 0, wins: 0, sum: 0, gw: 0, gl: 0 };
  for (const r of rets) { a.n++; a.sum += r; if (r > 0) { a.wins++; a.gw += r; } else a.gl -= r; }
  return a;
}
function aggLine(label: string, a: Agg): string {
  if (a.n === 0) return `- ${label}: none yet`;
  return `- ${label}: ${a.n} trades, ${a.wins} won (${(a.wins / a.n * 100).toFixed(0)}%), ${pct(a.sum / a.n)} per trade, PF ${(a.gl > 0 ? a.gw / a.gl : 99).toFixed(2)}, ${a.sum >= 0 ? "+" : "-"}$${Math.abs(a.sum * BLOCK_USD / 100).toFixed(0)} at $${BLOCK_USD} per trade`;
}

function recordReturn(r: TradeRecord): number | null {
  if (r.entry === undefined || r.exit === undefined || !(r.entry > 0)) return null;
  return (r.exit / r.entry - 1) * (r.side === "short" ? -1 : 1) * 100;
}

function runningRecord(): string[] {
  if (!fs.existsSync(AUTO_DIR)) return ["- none yet"];
  const files = fs.readdirSync(AUTO_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  const recs = files.flatMap((f) => fs.readFileSync(path.join(AUTO_DIR, f), "utf-8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as TradeRecord));
  const rets = (rs: readonly TradeRecord[]): number[] => rs.map(recordReturn).filter((x): x is number => x !== null);
  return [
    `Sessions scored: ${files.length} (${files.map((f) => f.slice(0, 10)).join(", ")})`,
    aggLine("all triggered calls", agg(rets(recs))),
    aggLine("star (the tested spec)", agg(rets(recs.filter((r) => r.tier === "star")))),
    aggLine("mega-cap (T2/T8, store validation pending)", agg(rets(recs.filter((r) => r.tier === "mega")))),
    aggLine("large, not star", agg(rets(recs.filter((r) => r.tier === "large")))),
    aggLine("watch (5-10%, no edge in the tests)", agg(rets(recs.filter((r) => r.tier === "watch")))),
  ];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  setLogLevel("warn");
  const scan = readScanGap(args.date);
  if (!scan) { process.stdout.write(`No packet for ${args.date} (docs/daily/${args.date}/scan-gap.txt); nothing to score.\n`); return; }
  if (!scan.preOpen) { process.stdout.write(`The ${args.date} scan is an after-open recap (${scan.header}); only pre-market packets are scored.\n`); return; }
  const packetTime = (scan.header.match(/(\d{2}:\d{2}) ET/) ?? ["", "morning"])[1];
  const yahoo = new YahooHistoricalBars();
  const session = await schwabSession(args.provider);

  const records: TradeRecord[] = [];
  const table: string[] = ["| Sym | Tier | Side | Trigger | Result | Entry | Exit | Return | Catalyst in the packet |", "|---|---|---|---|---|---:|---:|---:|---|"];
  let triggered = 0;
  let barsSource = "";
  for (const packetRow of scan.rows) {
    const long = packetRow.side === "long";
    const catalyst = catalystFor(args.date, packetRow.symbol);
    let row = packetRow;
    let o: Outcome;
    try {
      const got = await fetchBars(session.rest, yahoo, packetRow.symbol, args.date);
      barsSource = got.source;
      row = effectiveRow(packetRow, got.bars, args.date);
      o = scoreRow(row, got.bars, args.date);
      if (o.kind === "trade") { triggered++; records.push(toRecord(row, o, args.date, catalyst, got.source, packetTime)); }
    } catch (err) {
      o = { kind: "no bars", detail: err instanceof Error ? err.message : String(err) };
    }
    const trigger = `5m close ${long ? ">" : "<"} ${(long ? row.pmHigh : row.pmLow).toFixed(2)}`;
    const cat = catalyst ? catalyst.replace(/\|/g, "/").slice(0, 70) : "none in the packet";
    if (o.kind === "trade") {
      const last = o.t.exits[o.t.exits.length - 1];
      const how = o.t.exits.map((e) => `${e.reason} ${e.time}`).join(", ");
      table.push(`| ${row.symbol} | ${row.tier} | ${row.side} | ${trigger} | ${how}${o.mode === "hold" ? " (hold)" : ""} | ${o.t.entry.toFixed(2)} ${o.t.entryTime} | ${(o.t.exits.reduce((s, e) => s + e.fraction * e.price, 0)).toFixed(2)} ${last.time} | ${pct(o.t.returnPct)} | ${cat} |`);
    } else if (o.kind === "no trigger") {
      table.push(`| ${row.symbol} | ${row.tier} | ${row.side} | ${trigger} | no trigger (day ${o.low.toFixed(2)} to ${o.high.toFixed(2)}, close ${o.close.toFixed(2)}) | | | | ${cat} |`);
    } else if (o.kind === "skipped") {
      table.push(`| ${row.symbol} | ${row.tier} | ${row.side} | ${trigger} | skipped: opened ${o.open.toFixed(2)}, more than ${OPEN_CHASE_PCT}% beyond the extreme | | | | ${cat} |`);
    } else {
      table.push(`| ${row.symbol} | ${row.tier} | ${row.side} | ${trigger} | ${o.kind}: ${o.detail} | | | | ${cat} |`);
    }
  }

  fs.mkdirSync(AUTO_DIR, { recursive: true });
  const autoFile = path.join(AUTO_DIR, `${args.date}.jsonl`);
  fs.writeFileSync(autoFile, records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : ""));

  const rets = records.map(recordReturn).filter((x): x is number => x !== null);
  const today = agg(rets);
  const lines = [
    `# Scorecard ${args.date}: the ${packetTime} ET packet replayed with the tested rule (paper)`,
    ``,
    `Bars: ${barsSource || "none"}. Prices are the rule's, without slippage; star, large and watch rows take half at 1 ATR and the rest at 1.5 ATR, mega-cap rows hold to 15:45. Returns are on the stock.`,
    ``,
    ...table,
    ``,
    `Today: ${scan.rows.length} calls, ${triggered} triggered. ${aggLine("triggered calls", today).slice(2)}.`,
    ``,
    `## Running record (every scored session)`,
    ``,
    ...runningRecord(),
    ``,
  ];
  const text = lines.join("\n");
  const outDir = path.join("docs", "daily", args.date);
  fs.writeFileSync(path.join(outDir, "score.md"), text);
  process.stdout.write(text + `\nwritten: ${autoFile} (${records.length} records), ${path.join(outDir, "score.md")}\n`);
}

main().catch((err) => {
  process.stderr.write(`scorecard failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
