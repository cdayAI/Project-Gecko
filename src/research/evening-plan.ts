// Night list for the next session, one command after 20:00 ET:
//
//   npm run evening -- --provider schwab --push
//   npm run evening -- --no-jev --no-swing --symbols VKTX,ONON --provider yahoo   # test
//
// Tier 1, gap candidates for the 08:50 validation: after-hours movers, names
// reporting earnings after today's close or before the next open (Nasdaq
// calendar), and continuation names (big day, closed near the high, above
// the 20-day high), each with its levels (close, the +10% star level, the
// 20-day high, ATR targets, sector), the contract the rule would use at
// tonight's marks, headlines and Jev's read. Tier 2, the bounce book
// (scan:swing, both breadth gates). Tier 3 is whatever 5-10% gaps the
// morning finds: paper rows. Also carries today's monitor record.
// Writes docs/daily/<next session>/plan.md and plan.json (the morning packet
// marks each candidate CONFIRMED / GAPPED / NO GAP / NEW) and pushes
// docs/daily and docs/log to codex/daily-<next session> (--push).
// Read-only; never places orders.

import * as fs from "node:fs";
import * as path from "node:path";
import { createLogger, setLogLevel } from "../core/logger.js";
import { YahooHistoricalBars } from "../data/yahoo-historical.js";
import type { SchwabRest } from "../brokers/schwab/rest.js";
import type { SchwabQuote } from "../brokers/schwab/types.js";
import { etParts } from "../utils/time.js";
import { EconomicCalendar } from "../intelligence/economic-calendar.js";
import { parseProvider, schwabSession, type ProviderChoice } from "./schwab-session.js";
import { pickCboeContract, pickSchwabContract, type ContractPick } from "./contract-pick.js";
import { SECTOR_ETFS, sectorFor } from "./sectors.js";
import { loadUniverse, type UniverseEntry } from "./universe.js";
import { fetchEarnings, type EarningsRow } from "./earnings-calendar.js";
import { collectNews, jevLabels, pushDocs, renderNews, run, runJev } from "./packet-utils.js";
import type { PlanCandidate, PlanFile } from "./plan-types.js";

const log = createLogger("evening-plan");

interface Args { provider: ProviderChoice; push: boolean; jev: boolean; swing: boolean; chains: boolean; minAh: number; minDay: number; top: number; jevRequests: number; maxNames: number; symbols: readonly string[] | null; forDate: string | null }
interface Snap { readonly symbol: string; readonly close: number; readonly closeSource: "regular" | "last"; readonly dayPct: number | null; readonly ahLast: number | null; readonly ahPct: number | null; readonly ahVol: number | null; readonly open: number | null; readonly high: number | null; readonly low: number | null }
interface Row extends PlanCandidate { readonly dayPct: number | null; readonly ahVol: number | null; readonly dollarVol20: number | null; readonly sectorDayPct: number | null; contract: string; headlines: number; topHeadline: string; jev: string; readonly score: number }

const AH_MIN_VOLUME = 20_000;
const MINUTE_CLOSE = 16 * 60;
const MINUTE_OPEN = 9 * 60 + 30;
const MAX_ROWS = 30;

function parseArgs(argv: readonly string[]): Args {
  const out: Args = { provider: "auto", push: false, jev: true, swing: true, chains: true, minAh: 3, minDay: 8, top: 12, jevRequests: 12, maxNames: 1500, symbols: null, forDate: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--provider") out.provider = parseProvider(argv[++i]);
    else if (a === "--push") out.push = true;
    else if (a === "--no-jev") out.jev = false;
    else if (a === "--no-swing") out.swing = false;
    else if (a === "--no-chains") out.chains = false;
    else if (a === "--min-ah") out.minAh = Number(argv[++i]) || 3;
    else if (a === "--min-day") out.minDay = Number(argv[++i]) || 8;
    else if (a === "--top") out.top = Number(argv[++i]) || 12;
    else if (a === "--jev-requests") out.jevRequests = Number(argv[++i]) || 12;
    else if (a === "--max-names") out.maxNames = Number(argv[++i]) || 1500;
    else if (a === "--symbols") out.symbols = (argv[++i] ?? "").split(",").map((s) => s.trim().toUpperCase()).filter((s) => s.length > 0);
    else if (a === "--for") out.forDate = argv[++i] ?? null;
  }
  return out;
}

function nextSession(today: string): string {
  const d = new Date(`${today}T12:00:00Z`);
  do { d.setUTCDate(d.getUTCDate() + 1); } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}

function minuteOfEt(ts: number): number {
  const p = etParts(ts);
  return p.hour * 60 + p.minute;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

// Schwab quote after the bell: the regular block carries the 16:00 close,
// the extended block the last after-hours print. Both are documented; when
// the regular block is missing the last print stands in and the plan says so.
function parseSchwabSnap(symbol: string, q: SchwabQuote, today: string): Snap | null {
  const quote = q.quote;
  if (!quote) return null;
  const reg = q.regular;
  const ext = q.extended;
  let close = 0;
  let closeSource: "regular" | "last" = "last";
  let dayPct: number | null = null;
  if (reg && typeof reg.regularMarketTradeTime === "number" && etParts(reg.regularMarketTradeTime).date === today && typeof reg.regularMarketLastPrice === "number" && reg.regularMarketLastPrice > 0) {
    close = reg.regularMarketLastPrice; closeSource = "regular";
    dayPct = typeof reg.regularMarketPercentChange === "number" ? reg.regularMarketPercentChange : null;
  } else if (typeof quote.tradeTime === "number" && etParts(quote.tradeTime).date === today && quote.lastPrice > 0) {
    close = quote.lastPrice;
    dayPct = typeof quote.netPercentChange === "number" ? quote.netPercentChange : null;
  } else return null;
  let ahLast: number | null = null;
  let ahVol: number | null = null;
  if (ext && typeof ext.tradeTime === "number" && etParts(ext.tradeTime).date === today && minuteOfEt(ext.tradeTime) >= MINUTE_CLOSE && typeof ext.lastPrice === "number" && ext.lastPrice > 0) {
    ahLast = ext.lastPrice;
    ahVol = typeof ext.totalVolume === "number" ? ext.totalVolume : null;
  }
  return { symbol, close, closeSource, dayPct, ahLast, ahPct: ahLast !== null ? (ahLast / close - 1) * 100 : null, ahVol, open: num(quote.openPrice), high: num(quote.highPrice), low: num(quote.lowPrice) };
}

async function schwabSnaps(rest: SchwabRest, symbols: readonly string[], today: string): Promise<{ snaps: Map<string, Snap>; missingRegular: number; sampleKeys: string }> {
  const snaps = new Map<string, Snap>();
  let missingRegular = 0;
  let sampleKeys = "";
  for (let i = 0; i < symbols.length; i += 100) {
    const chunk = symbols.slice(i, i + 100);
    let batch: Record<string, SchwabQuote>;
    try {
      batch = await rest.getQuotes(chunk);
    } catch (err) {
      log.warn("Schwab quote batch failed", { count: chunk.length, error: msg(err) });
      continue;
    }
    for (const [sym, q] of Object.entries(batch)) {
      const s = parseSchwabSnap(sym.toUpperCase(), q, today);
      if (!s) continue;
      if (s.closeSource === "last") { missingRegular++; if (!sampleKeys) sampleKeys = Object.keys(q).join(","); }
      snaps.set(sym.toUpperCase(), s);
    }
  }
  return { snaps, missingRegular, sampleKeys };
}

// Yahoo fallback (test runs, or no vault): minute bars with extended hours.
async function yahooSnap(yahoo: YahooHistoricalBars, symbol: string, today: string, now: number): Promise<Snap | null> {
  const p = etParts(now);
  const midnight = now - ((p.hour * 60 + p.minute) * 60_000 + p.second * 1000 + (now % 1000));
  const bars = await yahoo.fetch({ symbol, interval: "1m", startMs: midnight + 4 * 3_600_000, endMs: now, includePrePost: true, cache: false });
  const todays = bars.filter((b) => etParts(b.timestamp).date === today);
  const reg = todays.filter((b) => { const m = minuteOfEt(b.timestamp); return m >= MINUTE_OPEN && m < MINUTE_CLOSE; });
  const ah = todays.filter((b) => minuteOfEt(b.timestamp) >= MINUTE_CLOSE);
  if (reg.length === 0) return null;
  const close = reg[reg.length - 1].close;
  const daily = await yahoo.fetch({ symbol, interval: "1d", startMs: now - 7 * 86_400_000, endMs: now, cache: false });
  const prev = daily.filter((b) => etParts(b.timestamp).date < today).pop()?.close ?? null;
  const ahLast = ah.length ? ah[ah.length - 1].close : null;
  return {
    symbol, close, closeSource: "regular", dayPct: prev ? (close / prev - 1) * 100 : null,
    ahLast, ahPct: ahLast !== null ? (ahLast / close - 1) * 100 : null, ahVol: ah.length ? ah.reduce((a, b) => a + b.volume, 0) : null,
    open: reg[0].open, high: Math.max(...reg.map((b) => b.high)), low: Math.min(...reg.map((b) => b.low)),
  };
}

function fmtContract(c: ContractPick | null): string {
  if (!c) return "no listed contract";
  return `${c.code} ${c.expiry} ${c.strike}${c.right} ${c.bid.toFixed(2)}/${c.ask.toFixed(2)}${c.delta !== null ? ` d${c.delta.toFixed(2)}` : ""} oi ${c.openInterest}${c.openInterest < 50 ? " THIN" : ""}`;
}

function pct(v: number | null, digits = 2): string {
  return v === null ? "n/a" : `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`;
}

function money(v: number | null): string {
  return v === null ? "n/a" : v.toFixed(2);
}

function vol(v: number | null): string {
  return v === null ? "n/a" : v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : `${Math.round(v / 1000)}k`;
}

// Today's monitor record: each row's header and status line from live.txt.
function monitorRecord(today: string): string[] {
  const f = path.join("docs", "daily", today, "live.txt");
  if (!fs.existsSync(f)) return ["no monitor record for today (npm run live was not running)"];
  const lines = fs.readFileSync(f, "utf-8").split("\n");
  const out: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (/^\s{7}(\[watch row, paper only\] )?(WAITING|IN |DONE|SKIPPED|no regular)/.test(lines[i])) out.push(`${lines[i - 1].trim().split(/\s{2,}/)[0]}: ${lines[i].trim()}`);
  }
  const stamp = (lines[0].match(/^===== Live monitor (.*) =====$/) ?? ["", ""])[1];
  return out.length ? [`as of ${stamp}`, ...out] : ["monitor record empty"];
}

function swingSummary(out: string): string[] {
  const lines = out.split("\n");
  const head = lines.filter((l) => l.startsWith("Breadth:") || l.startsWith("Breadth-30 tier") || l.startsWith("SPY regime:"));
  const start = lines.findIndex((l) => l.startsWith("Candidates ranked"));
  const end = lines.findIndex((l, i) => i > start && l.startsWith("Rules"));
  const table = start >= 0 ? lines.slice(start, end > start ? end : undefined).filter((l) => l.trim().length > 0) : [];
  return [...head, "", "```", ...table, "```"];
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function round4(v: number): number {
  return Math.round(v * 10_000) / 10_000;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  setLogLevel("warn");
  const now = Date.now();
  const p = etParts(now);
  const today = p.date;
  const forDate = args.forDate ?? nextSession(today);
  const stamp = `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
  const say = (s: string): void => { process.stdout.write(s + "\n"); };
  const yahoo = new YahooHistoricalBars();
  const session = await schwabSession(args.provider);
  const rest = session.rest;
  const providerName = rest ? `schwab (${session.reason})` : `yahoo (${session.reason})`;
  const dir = path.join("docs", "daily", forDate);
  fs.mkdirSync(dir, { recursive: true });

  // Universe and levels.
  const uni = loadUniverse();
  const entries = new Map<string, UniverseEntry>();
  for (const e of uni?.entries.slice(0, args.maxNames) ?? []) entries.set(e.symbol, e);
  const names = args.symbols ?? [...entries.keys()];
  const universeNote = uni ? `${uni.entries.length} names in the universe, ${args.symbols ? "explicit list" : `top ${names.length} by dollar volume`}; levels from the build ${uni.builtAt.slice(0, 16)}Z` : "no universe file (run npm run universe:build); levels unavailable";

  // Snapshots: close, after-hours print, day range.
  say(`[1/6] quotes for ${names.length + SECTOR_ETFS.length} symbols (${providerName})`);
  const snaps = new Map<string, Snap>();
  const notes: string[] = [];
  if (rest) {
    const r = await schwabSnaps(rest, [...SECTOR_ETFS, ...names], today);
    for (const [k, v] of r.snaps) snaps.set(k, v);
    if (r.missingRegular > 0) notes.push(`${r.missingRegular} quotes had no regular block (close taken from the last print; keys: ${r.sampleKeys})`);
  } else {
    if (names.length > 60) say(`      Yahoo fallback over ${names.length} names is slow (about ${Math.round(names.length * 0.9 / 60)} min)`);
    for (const s of [...SECTOR_ETFS, ...names]) {
      try { const snap = await yahooSnap(yahoo, s, today, now); if (snap) snaps.set(s, snap); } catch (err) { log.warn("Yahoo snapshot failed", { symbol: s, error: msg(err) }); }
    }
  }
  const tape = SECTOR_ETFS.map((etf) => { const s = snaps.get(etf); return s ? `${etf} ${pct(s.dayPct)}${s.ahPct !== null ? ` (AH ${pct(s.ahPct)})` : ""}` : `${etf} n/a`; }).join("  ");
  if (snaps.size === 0) notes.push("no quotes with a trade today; the market may not have traded (holiday) or the session failed");

  // Scheduled catalysts.
  say("[2/6] earnings calendar and macro");
  const erToday = (await fetchEarnings(today)).filter((r) => r.time === "after-hours" && (args.symbols ? names.includes(r.symbol) : entries.has(r.symbol)));
  const erNext = (await fetchEarnings(forDate)).filter((r) => args.symbols ? names.includes(r.symbol) : entries.has(r.symbol));
  const erBmo = erNext.filter((r) => r.time === "pre-market");
  const erUnknown = erNext.filter((r) => r.time === "unknown");
  const macro = new EconomicCalendar().eventsOn(forDate);

  // Candidates.
  const tags = new Map<string, Set<string>>();
  const tag = (s: string, t: string): void => { const cur = tags.get(s) ?? new Set<string>(); cur.add(t); tags.set(s, cur); };
  for (const s of names) {
    const snap = snaps.get(s);
    if (!snap) continue;
    if (snap.ahPct !== null && Math.abs(snap.ahPct) >= args.minAh && (snap.ahVol === null || snap.ahVol >= AH_MIN_VOLUME)) tag(s, snap.ahPct > 0 ? "AH+" : "AH-");
    const e = entries.get(s);
    if (snap.dayPct !== null && snap.high !== null && snap.low !== null && snap.high > snap.low) {
      const pos = (snap.close - snap.low) / (snap.high - snap.low);
      if (snap.dayPct >= args.minDay && pos >= 0.75 && (!e || snap.close > e.high20)) tag(s, "CONT+");
      if (snap.dayPct <= -args.minDay && pos <= 0.25 && (!e || snap.close < e.low20)) tag(s, "CONT-");
    }
  }
  for (const r of erToday) tag(r.symbol, "ER-AMC");
  for (const r of erBmo) tag(r.symbol, "ER-BMO");
  for (const r of erUnknown) tag(r.symbol, "ER?");

  const rows: Row[] = [];
  for (const [s, t] of tags) {
    const snap = snaps.get(s);
    const e = entries.get(s) ?? null;
    if (!snap) continue;   // earnings name without a trade today (halted or delisted); skip
    const list = [...t].sort();
    const bull = list.some((x) => x === "AH+" || x === "CONT+");
    const bear = list.some((x) => x === "AH-" || x === "CONT-");
    const side: Row["side"] = bull && !bear ? "long" : bear && !bull ? "short" : "either";
    const sector = sectorFor(s);
    const score = (list.some((x) => x.startsWith("AH")) ? 1000 + Math.abs(snap.ahPct ?? 0) : 0) + (list.some((x) => x.startsWith("ER")) ? 500 + (list.includes("ER-BMO") ? 10 : 0) : 0) + (list.some((x) => x.startsWith("CONT")) ? 100 + Math.abs(snap.dayPct ?? 0) : 0);
    rows.push({
      symbol: s, tags: list, side, close: snap.close, ahLast: snap.ahLast, ahPct: snap.ahPct,
      starLevel: side === "short" ? snap.close * 0.9 : snap.close * 1.1,
      high20: e ? e.high20 : null, atr: e ? e.atr14 : null, sector,
      dayPct: snap.dayPct, ahVol: snap.ahVol, dollarVol20: e ? e.avgDollarVol20 : null,
      sectorDayPct: snaps.get(sector)?.dayPct ?? null, contract: "", headlines: 0, topHeadline: "", jev: "", score,
    });
  }
  rows.sort((a, b) => b.score - a.score);
  const kept = rows.slice(0, MAX_ROWS);

  // Contracts at tonight's marks.
  say(`[3/6] contracts for ${kept.length} candidates${args.chains ? "" : " skipped (--no-chains)"}`);
  if (args.chains) {
    for (const r of kept) {
      const price = r.ahLast ?? r.close;
      const right = r.side === "short" ? "P" : "C";
      const otm = r.atr ? Math.min(2.5, 0.6 * (r.atr / price) * 100) : 2.5;
      try {
        r.contract = fmtContract(rest ? await pickSchwabContract(rest, r.symbol, price, right, otm, now) : await pickCboeContract(r.symbol, price, right, otm, now));
      } catch (err) {
        r.contract = `chain failed: ${msg(err)}`;
      }
    }
  }

  // Headlines and Jev.
  const newsSymbols = kept.slice(0, args.top).map((r) => r.symbol);
  say(`[4/6] news for ${newsSymbols.length} candidates: ${newsSymbols.join(",") || "(none)"}`);
  const news = collectNews(newsSymbols);
  if (!news.ok) notes.push("news collector exited with an error");
  fs.writeFileSync(path.join(dir, "plan-news.md"), renderNews(forDate, newsSymbols, news.events));
  for (const r of kept) {
    const mine = news.events.filter((e) => (e.symbols ?? []).includes(r.symbol));
    r.headlines = mine.length;
    r.topHeadline = mine[0]?.title ? mine[0].title.slice(0, 90) : "";
  }
  say("[5/6] jev");
  const jevFile = path.join(dir, "plan-jev.md");
  const jevNote = !args.jev ? "skipped (--no-jev)" : newsSymbols.length === 0 ? "skipped (no candidates)" : runJev(args.jevRequests, jevFile);
  say(`      ${jevNote}`);
  const labels = jevLabels(jevFile);
  for (const r of kept) r.jev = labels.get(r.symbol) ?? "";

  // Swing book.
  let swingLines: string[] = ["skipped (--no-swing)"];
  if (args.swing) {
    say("[6/6] scan:swing (about 12 minutes over the universe)");
    const swing = run("npm", ["run", "scan:swing", "--", "--top", "10", "--provider", args.provider]);
    fs.writeFileSync(path.join(dir, "plan-swing.txt"), swing.out);
    swingLines = swing.ok ? swingSummary(swing.out) : ["scan:swing exited with an error; see plan-swing.txt"];
  } else say("[6/6] scan:swing skipped (--no-swing)");

  // Plan files.
  const header = [
    `# Night list for ${forDate} (built ${today} ${stamp} ET)`,
    ``,
    `Provider: ${providerName}. ${universeNote}.`,
    `Tape today: ${tape}`,
    `Macro on ${forDate}: ${macro.length ? macro.map((m) => `${m.type} (${m.impact})`).join(", ") : "none"}`,
    `Earnings in the universe: after today's close ${erToday.length ? erToday.map((r) => r.symbol).join(", ") : "none"}; before the open on ${forDate}: ${erBmo.length ? erBmo.map((r) => r.symbol).join(", ") : "none"}${erUnknown.length ? `; time not supplied: ${erUnknown.map((r) => r.symbol).join(", ")}` : ""}`,
    ...(notes.length ? [`Notes: ${notes.join("; ")}`] : []),
    ``,
    `Today's monitor record:`,
    ...monitorRecord(today).map((l) => `- ${l}`),
    ``,
  ];
  const tier1 = [
    `## Tier 1: gap candidates for the 08:50 validation (${kept.length})`,
    ``,
    `A row becomes a star in the morning only if all four hold: pre-market last at or beyond the star level (close +10%, or -10% for a short), above the 20-day high, its sector ETF green pre-market, and a catalyst you can name. Entry is never before 09:35: the first 5-minute close beyond the pre-market extreme; stop on a 5-minute close through the 09:30 candle's opposite extreme; half at 1 ATR, rest at 1.5 ATR; out by 15:45. Contract marks are tonight's close and options do not trade pre-market: re-price at 09:30 and pay at most 10% over the live mid. Tags: AH after-hours mover, ER-AMC reports tonight, ER-BMO reports before the open, ER? time not supplied, CONT continuation (big day, closed near the extreme, through the 20-day level).`,
    ``,
    `| Sym | Tags | Side | Close | AH last | AH % | AH vol | Day % | Star level | 20d high | ATR (T1 / T2) | Sector today | Contract (tonight's marks) | Headlines | Jev | Top headline |`,
    `|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|---|---:|---|---|`,
    ...kept.map((r) => `| ${r.symbol} | ${r.tags.join(" ")} | ${r.side} | ${money(r.close)} | ${money(r.ahLast)} | ${pct(r.ahPct)} | ${vol(r.ahVol)} | ${pct(r.dayPct)} | ${r.starLevel.toFixed(2)} | ${money(r.high20)}${r.high20 !== null ? ((r.ahLast ?? r.close) > r.high20 ? " (above)" : " (below)") : ""} | ${r.atr !== null ? `${r.atr.toFixed(2)} (+${r.atr.toFixed(2)} / +${(1.5 * r.atr).toFixed(2)})` : "n/a"} | ${r.sector} ${pct(r.sectorDayPct)} | ${r.contract || "n/a"} | ${r.headlines} | ${r.jev || ""} | ${r.topHeadline.replace(/\|/g, "/")} |`),
    ...(kept.length === 0 ? ["", "No candidates tonight: no after-hours mover beyond the threshold, no earnings in the universe, no continuation name. The morning scan still runs; anything it finds is NEW."] : []),
    ``,
  ];
  const tier2 = [`## Tier 2: bounce book (H-BOUNCE-WR, final for ${forDate})`, ``, ...swingLines, ``,
    `Rule: enter at the open; exit on the first close at or above entry +1%; stop on a close 2 ATR below entry; out after 5 sessions. Strict gate (breadth >= 75 and SPY below its 50-day): 75% win in validation, 5 to 10 entries on an active day, about one active day a month. Breadth-30 tier: more days, +0.40%/trade, lower win rate. Stock, or a deep in-the-money call.`, ``];
  const tier3 = [`## Tier 3: paper rows`, ``, `The 5-10% gap rows the morning scan finds are paper only: 42-46% win and negative in the tests. They are logged as watched, never sized.`, ``];
  const morning = [`## Morning`, ``, `08:50 ET: npm run morning. It validates this list (CONFIRMED / GAPPED / NO GAP / NEW), pushes the packet to codex/daily-${forDate}, and starts the monitor at 09:30.`, ``, `Files: plan-news.md${fs.existsSync(jevFile) ? ", plan-jev.md" : ""}${args.swing ? ", plan-swing.txt" : ""}; today's monitor record in docs/daily/${today}/live.txt`, ``];
  fs.writeFileSync(path.join(dir, "plan.md"), [...header, ...tier1, ...tier2, ...tier3, ...morning].join("\n"));
  const plan: PlanFile = {
    for: forDate, builtAt: new Date(now).toISOString(), provider: providerName,
    candidates: kept.map((r): PlanCandidate => ({ symbol: r.symbol, tags: r.tags, side: r.side, close: round4(r.close), ahLast: r.ahLast === null ? null : round4(r.ahLast), ahPct: r.ahPct === null ? null : round4(r.ahPct), starLevel: round4(r.starLevel), high20: r.high20 === null ? null : round4(r.high20), atr: r.atr === null ? null : round4(r.atr), sector: r.sector })),
  };
  fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify(plan, null, 2));
  say(`night list written: ${dir}/plan.md (${kept.length} candidates)`);

  if (args.push) say(pushDocs(`codex/daily-${forDate}`, `Night list for ${forDate} (${today} ${stamp} ET)`));
}

main().catch((err) => {
  process.stderr.write(`evening-plan failed: ${msg(err)}\n`);
  process.exit(1);
});
