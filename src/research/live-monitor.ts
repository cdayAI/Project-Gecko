// Live trigger monitor for the day's gap rows (H-GAP-GO rule as registered,
// docs/gap-and-go-registration-2026-09-21.md). Runs on the operator's machine
// through the Schwab vault (real-time quotes and minute bars); falls back to
// Yahoo when no Schwab session exists.
//
//   npm run live                              # rows from docs/daily/<today>/scan-gap.txt, refresh every 30 s
//   npm run live -- --once                    # one snapshot and exit
//   npm run live -- --symbols ONON,ECO --interval 20
//
// Rule per row (long for GAP UP, short for GAP DOWN), exactly as replayed in
// src/backtest/gap-replay.ts: skip if the open is more than 1.5% beyond the
// pre-market extreme; the first 5-minute candle (09:30 included) closing
// beyond the extreme confirms and the entry is the next candle's open; no
// new signal after 11:30; stop on a 5-minute close back through the 09:30
// candle's opposite extreme; half off at 1 ATR, rest at 1.5 ATR; time exit
// 15:45. Every refresh rewrites
// docs/daily/<date>/live.txt so the closing packet carries the day's record.
// Read-only; never places orders.

import * as fs from "node:fs";
import * as path from "node:path";
import { createLogger, setLogLevel } from "../core/logger.js";
import { YahooHistoricalBars } from "../data/yahoo-historical.js";
import type { SchwabRest } from "../brokers/schwab/rest.js";
import { etParts } from "../utils/time.js";
import { schwabSession, parseProvider, type ProviderChoice } from "./schwab-session.js";
import { loadUniverse } from "./universe.js";
import { readScanGap } from "./packet-rows.js";

const log = createLogger("live-monitor");

interface Args { readonly provider: ProviderChoice; readonly once: boolean; readonly interval: number; readonly symbols: readonly string[] | null; readonly date: string }
interface Row { readonly symbol: string; readonly star: boolean; readonly side: "long" | "short"; readonly pmHigh: number; readonly pmLow: number; readonly atr: number; readonly source: string; readonly tier: string; readonly hold: boolean }
interface Minute { readonly ts: number; readonly o: number; readonly h: number; readonly l: number; readonly c: number; readonly v: number }
interface Candle { readonly t: number; o: number; h: number; l: number; c: number; v: number }   // t = candle start, minutes after midnight ET
interface Status { readonly line: string; readonly events: readonly string[] }

const TAPE = ["SPY", "QQQ", "IWM", "SMH", "XBI", "XLF", "XLE", "XLK", "XLV", "XLI", "XLY"] as const;
const YAHOO_TAPE = ["SPY", "QQQ", "IWM", "SMH", "XBI", "XLE"] as const;
const OPEN_MIN = 9 * 60 + 30;
const CLOSE_MIN = 16 * 60;
const TIME_EXIT_MIN = 15 * 60 + 45;
const LAST_SIGNAL_MIN = 11 * 60 + 30;   // as tested: no confirming candle closing after 11:30
const SKIP_PCT = 1.5;

function parseArgs(argv: readonly string[]): Args {
  const out = { provider: "auto" as ProviderChoice, once: false, interval: 30, symbols: null as readonly string[] | null, date: etParts(Date.now()).date };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--provider") out.provider = parseProvider(argv[++i]);
    else if (a === "--once") out.once = true;
    else if (a === "--interval") out.interval = Math.max(10, Number(argv[++i]) || 30);
    else if (a === "--symbols") out.symbols = (argv[++i] ?? "").split(",").map((s) => s.trim().toUpperCase()).filter((s) => s.length > 0);
    else if (a === "--date") out.date = argv[++i] ?? out.date;
  }
  return out;
}

// Rows from the morning packet (shared parser, src/research/packet-rows.ts).
// Mega-cap rows hold to 15:45 (T7); every other row takes half at 1 ATR and
// the rest at 1.5 ATR, as registered.
function loadPacketRows(date: string): Row[] {
  const scan = readScanGap(date);
  if (!scan) return [];
  return scan.rows.map((r) => ({ symbol: r.symbol, star: r.star, side: r.side, pmHigh: r.pmHigh, pmLow: r.pmLow, atr: r.atr, source: `packet ${date}`, tier: r.tier, hold: r.tier === "mega" }));
}

function midnightEt(now: number): number {
  const p = etParts(now);
  return now - ((p.hour * 60 + p.minute) * 60_000 + p.second * 1000 + (now % 1000));
}

function minuteOf(ts: number): number {
  const p = etParts(ts);
  return p.hour * 60 + p.minute;
}

async function fetchMinutes(rest: SchwabRest | null, yahoo: YahooHistoricalBars, symbol: string, now: number, extended: boolean): Promise<readonly Minute[]> {
  const start = midnightEt(now) + 4 * 3_600_000;
  if (rest) {
    try {
      const h = await rest.getPriceHistory({ symbol, periodType: "day", frequencyType: "minute", frequency: 1, startDate: start, endDate: now, needExtendedHoursData: extended });
      return h.candles.map((c) => ({ ts: c.datetime, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume }));
    } catch (err) {
      log.warn("Schwab minute bars failed, trying Yahoo", { symbol, error: err instanceof Error ? err.message : String(err) });
    }
  }
  const bars = await yahoo.fetch({ symbol, interval: "1m", startMs: start, endMs: now, includePrePost: extended, cache: false });
  return bars.map((b) => ({ ts: b.timestamp, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume }));
}

// Regular-session 5-minute candles for today, built from minute bars.
function fiveMinute(mins: readonly Minute[], today: string): Candle[] {
  const by = new Map<number, Candle>();
  for (const m of mins) {
    const p = etParts(m.ts);
    const mm = p.hour * 60 + p.minute;
    if (p.date !== today || mm < OPEN_MIN || mm >= CLOSE_MIN) continue;
    const t = OPEN_MIN + Math.floor((mm - OPEN_MIN) / 5) * 5;
    const c = by.get(t);
    if (!c) by.set(t, { t, o: m.o, h: m.h, l: m.l, c: m.c, v: m.v });
    else { c.h = Math.max(c.h, m.h); c.l = Math.min(c.l, m.l); c.c = m.c; c.v += m.v; }
  }
  return [...by.values()].sort((a, b) => a.t - b.t);
}

// A symbol that is not in the packet: pre-market range from extended bars,
// side from the last pre-market print versus the prior close, ATR from the
// universe file.
async function describeExtra(rest: SchwabRest | null, yahoo: YahooHistoricalBars, symbol: string, now: number, today: string): Promise<Row | null> {
  const mins = await fetchMinutes(rest, yahoo, symbol, now, true);
  const pre = mins.filter((m) => etParts(m.ts).date === today && minuteOf(m.ts) < OPEN_MIN);
  if (pre.length === 0) return null;
  let priorClose = 0;
  if (rest) {
    try {
      const q = await rest.getQuotes([symbol]);
      const raw = q[symbol] as { quote?: { closePrice?: number } } | undefined;
      priorClose = raw?.quote?.closePrice ?? 0;
    } catch (err) {
      log.warn("Schwab quote failed", { symbol, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (!(priorClose > 0)) {
    const d = await yahoo.fetch({ symbol, interval: "1d", startMs: now - 7 * 86_400_000, endMs: now, cache: false });
    priorClose = d.filter((b) => etParts(b.timestamp).date < today).pop()?.close ?? 0;
  }
  const atr = loadUniverse()?.entries.find((e) => e.symbol === symbol)?.atr14 ?? 0;
  const last = pre[pre.length - 1].c;
  return {
    symbol, star: false, tier: "extra", hold: false, side: priorClose > 0 && last < priorClose ? "short" : "long",
    pmHigh: Math.max(...pre.map((m) => m.h)), pmLow: Math.min(...pre.map((m) => m.l)), atr,
    source: priorClose > 0 ? `bars (prior close ${priorClose.toFixed(2)})` : "bars (prior close unknown, treated as long)",
  };
}

function hhmm(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

function pct(a: number, b: number): string {
  const v = (a / b - 1) * 100;
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}

// Apply the rule to the completed candles and describe where the row stands.
function evaluate(row: Row, candles: readonly Candle[], nowMin: number): Status {
  const long = row.side === "long";
  const ext = long ? row.pmHigh : row.pmLow;
  const done = candles.filter((c) => c.t + 5 <= nowMin);
  const last = candles[candles.length - 1];
  if (!last) return { line: "no regular-session prints yet", events: [] };
  const open = candles[0].o;
  if (long ? open > ext * (1 + SKIP_PCT / 100) : open < ext * (1 - SKIP_PCT / 100)) {
    return { line: `SKIPPED: opened ${open.toFixed(2)}, more than ${SKIP_PCT}% beyond the pre-market ${long ? "high" : "low"} ${ext.toFixed(2)}`, events: [] };
  }
  const first = done.find((c) => c.t === OPEN_MIN) ?? candles[0];
  const stopRef = long ? first.l : first.h;
  const events: string[] = [];
  let entry: { price: number; t: number } | null = null;
  let half = false;
  let exit: { price: number; t: number; reason: string } | null = null;
  const t1 = (e: number): number => (long ? e + row.atr : e - row.atr);
  const t2 = (e: number): number => (long ? e + 1.5 * row.atr : e - 1.5 * row.atr);
  for (let i = 0; i < done.length; i++) {
    const c = done[i];
    if (!entry) {
      if (c.t + 5 > LAST_SIGNAL_MIN) break;   // as tested: no new signal after 11:30
      if (long ? c.c > ext : c.c < ext) {
        // As tested: the 09:30 candle can confirm; entry at the next candle's open.
        const next = candles.find((x) => x.t === c.t + 5);
        const price = next ? next.o : c.c;
        entry = { price, t: c.t + 5 };
        events.push(`${hhmm(c.t + 5)} ENTRY ${row.side} ${price.toFixed(2)} (${hhmm(c.t)} candle closed ${c.c.toFixed(2)}, ${long ? "above" : "below"} ${ext.toFixed(2)}); stop ${stopRef.toFixed(2)} on a 5m close; ${row.hold ? "hold to 15:45" : `T1 ${t1(price).toFixed(2)} T2 ${t2(price).toFixed(2)}`}`);
      }
      continue;
    }
    if (long ? c.c < stopRef : c.c > stopRef) { exit = { price: c.c, t: c.t + 5, reason: "stop" }; events.push(`${hhmm(c.t + 5)} STOP ${c.c.toFixed(2)} (5m close through ${stopRef.toFixed(2)})`); break; }
    if (!row.hold && !half && (long ? c.h >= t1(entry.price) : c.l <= t1(entry.price))) { half = true; events.push(`${hhmm(c.t)} HALF ${t1(entry.price).toFixed(2)} (1 ATR)`); }
    if (!row.hold && half && (long ? c.h >= t2(entry.price) : c.l <= t2(entry.price))) { exit = { price: t2(entry.price), t: c.t + 5, reason: "target2" }; events.push(`${hhmm(c.t)} REST ${exit.price.toFixed(2)} (1.5 ATR)`); break; }
    if (c.t + 5 >= TIME_EXIT_MIN) { exit = { price: c.c, t: c.t + 5, reason: "time" }; events.push(`${hhmm(c.t + 5)} TIME EXIT ${c.c.toFixed(2)}`); break; }
  }
  const move = (p: number, e: number): number => ((long ? p - e : e - p) / e) * 100;
  if (!entry) {
    const away = pct(long ? ext : last.c, long ? last.c : ext);
    return { line: `WAITING for a 5m close ${long ? "above" : "below"} ${ext.toFixed(2)} (last ${last.c.toFixed(2)}, ${away} away); stop ref ${stopRef.toFixed(2)}; ${row.hold ? "hold to 15:45 once in" : `targets ${long ? "+" : "-"}${row.atr.toFixed(2)} half, ${long ? "+" : "-"}${(1.5 * row.atr).toFixed(2)} rest`}`, events };
  }
  if (!exit) {
    const open1 = move(last.c, entry.price);
    const pnl = half ? 0.5 * move(t1(entry.price), entry.price) + 0.5 * open1 : open1;
    return { line: `IN ${row.side} from ${entry.price.toFixed(2)} at ${hhmm(entry.t)}; stop ${stopRef.toFixed(2)} (5m close); ${row.hold ? "hold to 15:45" : `T1 ${t1(entry.price).toFixed(2)}${half ? " taken" : ""}; T2 ${t2(entry.price).toFixed(2)}`}; last ${last.c.toFixed(2)} ${open1 >= 0 ? "+" : ""}${open1.toFixed(2)}% (position ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}%)`, events };
  }
  const pnl = half ? 0.5 * move(t1(entry.price), entry.price) + 0.5 * move(exit.price, entry.price) : move(exit.price, entry.price);
  return { line: `DONE (${exit.reason}) ${row.side} ${entry.price.toFixed(2)} -> ${exit.price.toFixed(2)} at ${hhmm(exit.t)}: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}%${half ? " incl. half at T1" : ""}`, events };
}

async function tapeLine(rest: SchwabRest | null, yahoo: YahooHistoricalBars, now: number, today: string): Promise<string> {
  const out: string[] = [];
  if (rest) {
    try {
      const quotes = await rest.getQuotes([...TAPE]);
      for (const etf of TAPE) {
        const raw = quotes[etf] as { quote?: { lastPrice?: number; closePrice?: number } } | undefined;
        const last = raw?.quote?.lastPrice ?? 0; const prior = raw?.quote?.closePrice ?? 0;
        if (last > 0 && prior > 0) out.push(`${etf} ${pct(last, prior)}`);
      }
      return out.join("  ");
    } catch (err) {
      log.warn("Schwab tape quotes failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }
  for (const etf of YAHOO_TAPE) {
    try {
      const d = await yahoo.fetch({ symbol: etf, interval: "1d", startMs: now - 7 * 86_400_000, endMs: now, cache: false });
      const prior = d.filter((b) => etParts(b.timestamp).date < today).pop();
      const mins = await fetchMinutes(null, yahoo, etf, now, false);
      const last = mins.filter((m) => etParts(m.ts).date === today && minuteOf(m.ts) >= OPEN_MIN).pop();
      if (prior && last) out.push(`${etf} ${pct(last.c, prior.close)}`);
    } catch (err) {
      log.warn("Yahoo tape failed", { etf, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out.join("  ");
}

async function snapshot(rest: SchwabRest | null, yahoo: YahooHistoricalBars, rows: readonly Row[], providerName: string, date: string): Promise<string> {
  const now = Date.now();
  const p = etParts(now);
  const nowMin = p.hour * 60 + p.minute;
  const lines: string[] = [`===== Live monitor ${p.date} ${hhmm(nowMin)} ET (${providerName}) =====`, `Tape: ${await tapeLine(rest, yahoo, now, p.date)}`, ""];
  for (const row of rows) {
    try {
      // The rule's extreme is the whole pre-market through 09:30, not the packet's snapshot:
      // recompute it from today's extended-hours bars and fall back to the packet when there are none.
      const mins = await fetchMinutes(rest, yahoo, row.symbol, now, true);
      const pre = mins.filter((m) => etParts(m.ts).date === p.date && minuteOf(m.ts) < OPEN_MIN);
      const eff: Row = pre.length ? { ...row, pmHigh: Math.max(...pre.map((m) => m.h)), pmLow: Math.min(...pre.map((m) => m.l)) } : row;
      const moved = Math.abs(eff.pmHigh / row.pmHigh - 1) > 0.002 || Math.abs(eff.pmLow / row.pmLow - 1) > 0.002;
      const candles = fiveMinute(mins, p.date);
      const st = evaluate(eff, candles, nowMin);
      const last = candles[candles.length - 1];
      lines.push(`${row.star ? "*" : " "}${row.symbol.padEnd(5)} ${row.side.padEnd(5)} PM ${eff.pmHigh.toFixed(2)}/${eff.pmLow.toFixed(2)}${moved ? ` (packet ${row.pmHigh.toFixed(2)}/${row.pmLow.toFixed(2)})` : ""}  ATR ${row.atr.toFixed(2)}  open ${candles[0]?.o.toFixed(2) ?? "n/a"}  last ${last ? `${last.c.toFixed(2)} ${hhmm(last.t)}${last.t + 5 > nowMin ? " (forming)" : ""}` : "n/a"}`);
      lines.push(`       ${row.star ? "" : row.tier === "mega" ? "[mega-cap, T2/T8, store validation pending] " : "[watch row, paper only] "}${st.line}`);
      for (const e of st.events) lines.push(`       ${e}`);
      const tail = candles.slice(-4).map((c) => `${hhmm(c.t)} O ${c.o.toFixed(2)} H ${c.h.toFixed(2)} L ${c.l.toFixed(2)} C ${c.c.toFixed(2)} ${(c.v / 1000).toFixed(0)}k${c.t + 5 > nowMin ? " (forming)" : ""}`);
      if (tail.length) lines.push(`       ${tail.join(" | ")}`);
      lines.push("");
    } catch (err) {
      lines.push(`${row.symbol}: ${err instanceof Error ? err.message : String(err)}`, "");
    }
  }
  lines.push(`Rule as tested: skip if the open is >${SKIP_PCT}% beyond the PM extreme; the first 5m candle (09:30 included) closing beyond it confirms, entry at the next candle's open, no new signal after 11:30; stop on a 5m close through the 09:30 candle's opposite extreme; half at 1 ATR, rest at 1.5 ATR; time exit 15:45. Rows: ${rows.map((r) => `${r.symbol} (${r.source})`).join(", ")}.`);
  const text = lines.join("\n") + "\n";
  try {
    const dir = path.join("docs", "daily", date);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "live.txt"), text);
  } catch (err) {
    log.warn("live.txt write failed", { error: err instanceof Error ? err.message : String(err) });
  }
  return text;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  setLogLevel("warn");
  const yahoo = new YahooHistoricalBars();
  const session = await schwabSession(args.provider);
  const rest = session.rest;
  const providerName = rest ? `schwab, ${session.reason}` : `yahoo, ${session.reason}`;
  const now = Date.now();
  const today = etParts(now).date;

  let rows = loadPacketRows(args.date);
  if (args.symbols) {
    const want = new Set(args.symbols);
    const fromPacket = rows.filter((r) => want.has(r.symbol));
    const extra: Row[] = [];
    for (const s of args.symbols) {
      if (fromPacket.some((r) => r.symbol === s)) continue;
      const r = await describeExtra(rest, yahoo, s, now, today);
      if (r) extra.push(r); else process.stdout.write(`${s}: no pre-market prints found, skipped\n`);
    }
    rows = [...fromPacket, ...extra];
  }
  if (rows.length === 0) {
    process.stdout.write(`No rows: no docs/daily/${args.date}/scan-gap.txt with gap rows, and no --symbols. Run the morning packet first or pass --symbols.\n`);
    return;
  }
  rows = [...rows].sort((a, b) => Number(b.star) - Number(a.star));
  process.stdout.write(`Watching ${rows.length} rows: ${rows.map((r) => `${r.star ? "*" : ""}${r.symbol}`).join(", ")}${args.once ? "" : `; refresh every ${args.interval}s, Ctrl+C to stop`}\n`);

  for (;;) {
    try {
      process.stdout.write("\n" + await snapshot(rest, yahoo, rows, providerName, args.date));
    } catch (err) {
      process.stdout.write(`snapshot failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    if (args.once) break;
    const m = minuteOf(Date.now());
    if (m >= CLOSE_MIN + 5) { process.stdout.write("Session over; final snapshot written.\n"); break; }
    await new Promise((r) => setTimeout(r, args.interval * 1000));
  }
}

main().catch((err) => {
  process.stderr.write(`live-monitor failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
