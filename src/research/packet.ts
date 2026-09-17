// Research packet assembly, scoring, rendering, persistence.

import * as fs from "node:fs";
import * as path from "node:path";
import { createLogger } from "../core/logger.js";
import { appendJsonl } from "../utils/persistence.js";
import { etParts, isAfterHours, isPremarket, isRegularSession } from "../utils/time.js";
import { CatalystGatherer } from "./catalysts.js";
import { computeDailyStats } from "./indicators.js";
import { analyzeChain } from "./options-analyzer.js";
import type { MarketDataProvider } from "./providers/provider.js";
import type { Candidate, CandidateFlags, ResearchBudget, ResearchPacket } from "./types.js";

const log = createLogger("research-packet");

const RESEARCH_DIR = path.join("data", "research");

export interface BuildOptions {
  readonly symbols: readonly string[];
  readonly universeSource: string;
  readonly budget: ResearchBudget;
  readonly includeChains: boolean;
  readonly includeNews: boolean;
  readonly maxCandidates: number;
  readonly chainDaysAhead: number;       // expiration window from today
  readonly strikesAroundSpot: number;
}

export async function buildPacket(provider: MarketDataProvider, opts: BuildOptions): Promise<ResearchPacket> {
  const errors: string[] = [];
  const now = Date.now();
  const et = etParts(now);
  const today = et.date;
  const symbols = [...new Set(opts.symbols.map((s) => s.trim().toUpperCase()).filter((s) => s.length > 0))];

  const snapshots = await provider.getSnapshots(symbols);
  const missing = symbols.filter((s) => !snapshots.some((x) => x.symbol === s));
  if (missing.length > 0) errors.push(`no snapshot for: ${missing.join(", ")}`);

  const gatherer = new CatalystGatherer(provider, opts.includeNews);
  const candidates: Candidate[] = [];
  const concurrency = 4;
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < snapshots.length) {
      const snap = snapshots[cursor++];
      try {
        candidates.push(await buildCandidate(provider, gatherer, snap.symbol, snap, today, opts));
      } catch (err) {
        errors.push(`${snap.symbol}: ${errMsg(err)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  candidates.sort((a, b) => b.score - a.score);
  const kept = candidates.slice(0, opts.maxCandidates);
  const packet: ResearchPacket = {
    id: `${today}-${String(et.hour).padStart(2, "0")}${String(et.minute).padStart(2, "0")}-${Math.random().toString(36).slice(2, 7)}`,
    generatedAt: new Date(now).toISOString(),
    generatedAtEt: `${et.date} ${String(et.hour).padStart(2, "0")}:${String(et.minute).padStart(2, "0")} ET`,
    session: isRegularSession(now) ? "regular" : isPremarket(now) ? "premarket" : isAfterHours(now) ? "afterhours" : "closed",
    budget: opts.budget,
    providers: [provider.name],
    universeSource: opts.universeSource,
    universeSize: symbols.length,
    candidates: kept,
    errors,
  };
  return packet;
}

async function buildCandidate(
  provider: MarketDataProvider,
  gatherer: CatalystGatherer,
  symbol: string,
  snapshot: Candidate["snapshot"],
  today: string,
  opts: BuildOptions,
): Promise<Candidate> {
  const warnings: string[] = [];
  if (snapshot.provenance.delayed) warnings.push(`quotes delayed (${snapshot.provenance.source})`);

  const bars = await provider.getDailyBars(symbol, 400);
  const stats = computeDailyStats(snapshot, bars, today, { source: snapshot.provenance.source, capturedAt: Date.now(), delayed: snapshot.provenance.delayed, note: `${bars.length} daily bars` });
  if (!stats) warnings.push("insufficient daily bars for statistics");

  const catalysts = await gatherer.gather(symbol, today);

  let chain: Candidate["chain"] = null;
  let structures: Candidate["structures"] = [];
  if (opts.includeChains) {
    const to = new Date(Date.parse(`${today}T00:00:00Z`) + opts.chainDaysAhead * 86_400_000).toISOString().slice(0, 10);
    chain = await provider.getOptionChain({ underlying: symbol, fromDate: today, toDate: to, strikesAroundSpot: opts.strikesAroundSpot });
    if (chain) {
      if (chain.provenance.delayed) warnings.push(`option quotes delayed (${chain.provenance.source}); re-check live before entry`);
      // After-hours moves leave option marks stranded at the 4pm close.
      if (snapshot.regularClose !== undefined && snapshot.regularClose > 0) {
        const drift = ((snapshot.last - snapshot.regularClose) / snapshot.regularClose) * 100;
        if (Math.abs(drift) >= 1) warnings.push(`underlying is ${drift.toFixed(1)}% away from the regular-session close; option marks below predate that move and will reprice at the open`);
      }
      structures = analyzeChain(chain, opts.budget, { todayIsoDate: today, atr: stats?.atr14 ?? 0, minDte: 1, maxDte: opts.chainDaysAhead, maxStructures: 16 });
      if (structures.length > 0 && structures.every((s) => s.contractsForBudget === 0)) warnings.push("no listed structure fits the per-trade risk budget at one contract");
    } else {
      warnings.push("no option chain available from provider");
    }
  }

  const earningsWithin5 = catalysts.nextEarningsDate !== null && daysAhead(today, catalysts.nextEarningsDate) <= 5;
  const flags: CandidateFlags = {
    gapper: Math.abs(stats?.gapPct ?? 0) >= 2,
    highRelativeVolume: (stats?.relativeVolume ?? 0) >= 2,
    nearFiftyTwoWeekHigh: (stats?.fiftyTwoWeekPositionPct ?? -1) >= 95,
    nearFiftyTwoWeekLow: stats?.fiftyTwoWeekPositionPct !== null && stats !== null && stats.fiftyTwoWeekPositionPct <= 5,
    aboveSma20: stats !== null && snapshot.last > stats.sma20,
    aboveSma50: stats !== null && snapshot.last > stats.sma50,
    earningsWithin5Days: earningsWithin5,
    macroEventToday: catalysts.macroEventsToday.length > 0,
  };
  if (earningsWithin5) warnings.push(`earnings ${catalysts.nextEarningsDate}: event risk and IV crush apply`);
  if (flags.macroEventToday) warnings.push(`macro release today: ${catalysts.macroEventsToday.join(", ")}`);

  const { score, reasons } = scoreCandidate(snapshot, stats, catalysts, structures);
  return { symbol, snapshot, stats, catalysts, flags, chain, structures, score, scoreReasons: reasons, warnings };
}

// Mechanical attention score. It ranks what deserves a human look first;
// it is not a probability and not a trade signal.
function scoreCandidate(snapshot: Candidate["snapshot"], stats: Candidate["stats"], catalysts: Candidate["catalysts"], structures: Candidate["structures"]): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const move = Math.abs(snapshot.changePct);
  if (move >= 1) { const pts = Math.min(25, move * 5); score += pts; reasons.push(`day move ${snapshot.changePct.toFixed(2)}% (+${pts.toFixed(0)})`); }
  if (stats) {
    if (stats.relativeVolume >= 1.5) { const pts = Math.min(20, (stats.relativeVolume - 1) * 10); score += pts; reasons.push(`relative volume ${stats.relativeVolume.toFixed(2)}x (+${pts.toFixed(0)})`); }
    if (Math.abs(stats.gapPct) >= 2) { score += 10; reasons.push(`gap ${stats.gapPct.toFixed(2)}% (+10)`); }
    if (stats.fiftyTwoWeekPositionPct !== null && (stats.fiftyTwoWeekPositionPct >= 95 || stats.fiftyTwoWeekPositionPct <= 5)) { score += 10; reasons.push(`at 52-week extreme (${stats.fiftyTwoWeekPositionPct.toFixed(0)}%) (+10)`); }
    if (stats.atrPct >= 2) { score += 5; reasons.push(`ATR ${stats.atrPct.toFixed(1)}% of price (+5)`); }
  }
  if (catalysts) {
    const dayAgo = Date.now() - 24 * 3600 * 1000;
    const fresh = catalysts.headlines.filter((h) => h.publishedAt >= dayAgo).length;
    if (fresh > 0) { const pts = Math.min(15, fresh * 3); score += pts; reasons.push(`${fresh} headline(s) in last 24h (+${pts})`); }
  }
  const fits = structures.filter((s) => s.contractsForBudget > 0 && s.spreadCostPct <= 15);
  if (fits.length > 0) { score += 15; reasons.push(`${fits.length} structure(s) fit budget with spread drag <= 15% (+15)`); }
  else if (structures.length > 0) { reasons.push("no structure fits budget at acceptable spread (+0)"); }
  return { score: Math.round(Math.min(100, score)), reasons };
}

function daysAhead(today: string, date: string): number {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

// ----- Persistence -----

export function persistPacket(packet: ResearchPacket): { jsonPath: string; mdPath: string } {
  const dir = path.join(RESEARCH_DIR, packet.generatedAtEt.slice(0, 10));
  fs.mkdirSync(dir, { recursive: true });
  const jsonPath = path.join(dir, `${packet.id}.json`);
  const mdPath = path.join(dir, `${packet.id}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(packet, null, 2), "utf-8");
  fs.writeFileSync(mdPath, renderMarkdown(packet), "utf-8");
  appendJsonl(path.join(RESEARCH_DIR, "packets.jsonl"), {
    id: packet.id, generatedAt: packet.generatedAt, session: packet.session, providers: packet.providers,
    universeSize: packet.universeSize, candidates: packet.candidates.map((c) => ({ symbol: c.symbol, score: c.score })), errors: packet.errors.length,
  });
  log.info("Research packet written", { jsonPath, mdPath, candidates: packet.candidates.length, errors: packet.errors.length });
  return { jsonPath, mdPath };
}

// ----- Rendering -----

export function renderMarkdown(p: ResearchPacket): string {
  const L: string[] = [];
  L.push(`# Research packet ${p.id}`);
  L.push("");
  L.push(`Generated ${p.generatedAtEt} (${p.session} session). Providers: ${p.providers.join(", ")}. Universe: ${p.universeSource} (${p.universeSize} symbols).`);
  L.push(`Budget: equity $${p.budget.accountEquity.toFixed(0)}, max risk per trade ${p.budget.maxRiskPerTradePct}% = $${p.budget.maxRiskPerTradeUsd.toFixed(0)}.`);
  L.push("");
  L.push("Scores rank attention, not probability. Every price below carries its source and delay flag; delayed quotes are not entry prices.");
  L.push("");
  if (p.errors.length > 0) {
    L.push("## Errors");
    for (const e of p.errors) L.push(`- ${e}`);
    L.push("");
  }
  L.push("## Ranking");
  L.push("");
  L.push("| # | Symbol | Score | Last | Day % | RVol | Gap % | 52w pos | Source | Delayed |");
  L.push("|---|---|---|---|---|---|---|---|---|---|");
  p.candidates.forEach((c, i) => {
    L.push(`| ${i + 1} | ${c.symbol} | ${c.score} | ${c.snapshot.last.toFixed(2)} | ${c.snapshot.changePct.toFixed(2)} | ${c.stats ? c.stats.relativeVolume.toFixed(2) : "n/a"} | ${c.stats ? c.stats.gapPct.toFixed(2) : "n/a"} | ${c.stats?.fiftyTwoWeekPositionPct !== null && c.stats?.fiftyTwoWeekPositionPct !== undefined ? c.stats.fiftyTwoWeekPositionPct.toFixed(0) + "%" : "n/a"} | ${c.snapshot.provenance.source} | ${c.snapshot.provenance.delayed ? "yes" : "no"} |`);
  });
  L.push("");
  for (const c of p.candidates) {
    L.push(`## ${c.symbol}`);
    L.push("");
    const s = c.snapshot;
    L.push(`Last ${s.last.toFixed(2)} (bid ${s.bid.toFixed(2)} / ask ${s.ask.toFixed(2)}), open ${s.open.toFixed(2)}, high ${s.high.toFixed(2)}, low ${s.low.toFixed(2)}, prev close ${s.prevClose.toFixed(2)}, volume ${s.volume.toLocaleString("en-US")}.`);
    if (s.extendedLast !== undefined) L.push(`Extended-hours last ${s.extendedLast.toFixed(2)} (${(s.extendedChangePct ?? 0).toFixed(2)}% vs prev close).`);
    if (s.regularClose !== undefined) L.push(`Regular-session close ${s.regularClose.toFixed(2)}.`);
    L.push(`Source: ${s.provenance.source}, captured ${new Date(s.provenance.capturedAt).toISOString()}${s.provenance.sourceTimestamp ? `, source time ${new Date(s.provenance.sourceTimestamp).toISOString()}` : ""}${s.provenance.delayed ? ", DELAYED" : ""}${s.provenance.note ? ` (${s.provenance.note})` : ""}.`);
    L.push("");
    if (c.stats) {
      const t = c.stats;
      L.push(`Stats over ${t.bars} daily bars: ATR14 ${t.atr14.toFixed(2)} (${t.atrPct.toFixed(2)}%), SMA20 ${t.sma20.toFixed(2)}, SMA50 ${t.sma50.toFixed(2)}, 20d high ${t.high20.toFixed(2)}, 20d low ${t.low20.toFixed(2)}, avg vol 20d ${Math.round(t.avgVolume20).toLocaleString("en-US")}, rvol ${t.relativeVolume.toFixed(2)}x, gap ${t.gapPct.toFixed(2)}%, range position ${t.rangePositionPct.toFixed(0)}%.`);
      L.push("");
    }
    L.push(`Score ${c.score}: ${c.scoreReasons.join("; ") || "no scoring factors"}.`);
    const f = c.flags;
    const on = Object.entries(f).filter(([, v]) => v).map(([k]) => k);
    L.push(`Flags: ${on.length > 0 ? on.join(", ") : "none"}.`);
    if (c.warnings.length > 0) { L.push(""); L.push("Warnings:"); for (const w of c.warnings) L.push(`- ${w}`); }
    L.push("");
    if (c.catalysts) {
      const k = c.catalysts;
      L.push(`Next earnings: ${k.nextEarningsDate ?? "unknown"}${k.earningsProvenance ? ` (${k.earningsProvenance.note})` : ""}. Macro today: ${k.macroEventsToday.join(", ") || "none"}. Next 5 days: ${k.macroEventsNext5Days.map((e) => `${e.type} ${e.date}`).join(", ") || "none"}.`);
      if (k.headlines.length > 0) {
        L.push("");
        L.push("Headlines:");
        for (const h of k.headlines.slice(0, 8)) L.push(`- ${new Date(h.publishedAt).toISOString().slice(0, 16).replace("T", " ")}Z ${h.publisher ? `[${h.publisher}] ` : ""}${h.title}${h.url ? ` (${h.url})` : ""}`);
      }
      L.push("");
    }
    if (c.chain) {
      L.push(`Option chain: ${c.chain.contracts.length} contracts across ${c.chain.expirations.join(", ")}; source ${c.chain.provenance.source}${c.chain.provenance.delayed ? " (DELAYED)" : ""}${c.chain.provenance.note ? `, ${c.chain.provenance.note}` : ""}.`);
      L.push("");
      if (c.structures.length > 0) {
        L.push("| Structure | Exp (DTE) | Legs | Debit mid | Debit ask | Max loss | Max gain | Reward:risk | Breakeven | Spread drag | Net delta | Theta/day | Fits budget |");
        L.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
        for (const st of c.structures) {
          L.push(`| ${st.kind} | ${st.expiration} (${st.daysToExpiration}) | ${st.legs.map((l) => `${l.optionType[0]}${l.strike} ${l.bid.toFixed(2)}/${l.ask.toFixed(2)} oi ${l.openInterest}`).join(" ; ")} | ${st.debitMid.toFixed(2)} | ${st.debitAsk.toFixed(2)} | $${st.maxLossPerContract.toFixed(0)} | ${st.maxGainPerContract === null ? "uncapped" : `$${st.maxGainPerContract.toFixed(0)}`} | ${st.rewardToRisk === null ? "n/a" : st.rewardToRisk.toFixed(2)} | ${st.breakeven.toFixed(2)} | ${st.spreadCostPct.toFixed(0)}% | ${st.netDelta === null ? "n/a" : st.netDelta.toFixed(2)} | ${st.netTheta === null ? "n/a" : `$${st.netTheta.toFixed(0)}`} | ${st.contractsForBudget > 0 ? `${st.contractsForBudget}x` : "no"} |`);
        }
        const flagged = c.structures.flatMap((st) => st.liquidityFlags);
        if (flagged.length > 0) { L.push(""); L.push("Liquidity flags:"); for (const fl of [...new Set(flagged)].slice(0, 12)) L.push(`- ${fl}`); }
        L.push("");
      }
    }
  }
  L.push("This packet is evidence, not a recommendation. A trade needs a trigger, an invalidation, a time exit, and live quotes at entry.");
  L.push("");
  return L.join("\n");
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
