// Research engine CLI.
//
//   npm run research -- --symbols SPY,QQQ,LEN
//   npm run research -- --universe movers --provider webull
//   npm run research -- --symbols SPY --no-chains --no-news
//
// Flags:
//   --provider cboe|webull|schwab   (default RESEARCH_PROVIDER or cboe)
//   --symbols A,B,C                 explicit universe
//   --universe watchlist|movers|both  (default watchlist; movers needs a provider that supports it)
//   --equity 5000                    account equity for sizing (default RESEARCH_ACCOUNT_EQUITY)
//   --risk-pct 2                     max risk per trade in percent (default RESEARCH_MAX_RISK_PCT)
//   --max 10                         max candidates in the packet
//   --days-ahead 45                  expiration window for chains
//   --no-chains  --no-news
//
// Reads only. Never places orders.

import * as fs from "node:fs";
import { loadConfig } from "../core/config.js";
import { createLogger, setLogLevel } from "../core/logger.js";
import { buildPacket, persistPacket } from "./packet.js";
import { createResearchProvider } from "./providers/factory.js";
import type { MarketDataProvider } from "./providers/provider.js";

const log = createLogger("research-cli");

const WATCHLIST_FILE = "data/watchlist.txt";
const DEFAULT_UNIVERSE: readonly string[] = ["SPY", "QQQ", "IWM"];

interface Args {
  readonly provider?: string;
  readonly symbols?: string;
  readonly universe: "watchlist" | "movers" | "both";
  readonly equity?: number;
  readonly riskPct?: number;
  readonly max: number;
  readonly daysAhead: number;
  readonly chains: boolean;
  readonly news: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const has = (name: string): boolean => argv.includes(`--${name}`);
  const universeRaw = get("universe") ?? "watchlist";
  if (universeRaw !== "watchlist" && universeRaw !== "movers" && universeRaw !== "both") {
    throw new Error(`--universe must be watchlist, movers, or both (got ${universeRaw})`);
  }
  const numOr = (v: string | undefined): number | undefined => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`Expected a number, got ${v}`);
    return n;
  };
  return {
    provider: get("provider"),
    symbols: get("symbols"),
    universe: universeRaw,
    equity: numOr(get("equity")),
    riskPct: numOr(get("risk-pct")),
    max: numOr(get("max")) ?? 10,
    daysAhead: numOr(get("days-ahead")) ?? 45,
    chains: !has("no-chains"),
    news: !has("no-news"),
  };
}

function loadWatchlist(): readonly string[] {
  try {
    if (fs.existsSync(WATCHLIST_FILE)) {
      const lines = fs.readFileSync(WATCHLIST_FILE, "utf-8").split("\n").map((s) => s.trim()).filter((s) => s.length > 0 && !s.startsWith("#")).map((s) => s.toUpperCase());
      if (lines.length > 0) return lines;
    }
  } catch (err) {
    log.warn("Failed to read watchlist", { error: err instanceof Error ? err.message : String(err) });
  }
  return DEFAULT_UNIVERSE;
}

async function resolveUniverse(provider: MarketDataProvider, args: Args): Promise<{ symbols: string[]; source: string }> {
  if (args.symbols) return { symbols: args.symbols.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean), source: "cli --symbols" };
  const out = new Set<string>();
  const sources: string[] = [];
  if (args.universe === "watchlist" || args.universe === "both") {
    for (const s of loadWatchlist()) out.add(s);
    sources.push(fs.existsSync(WATCHLIST_FILE) ? WATCHLIST_FILE : "built-in default");
  }
  if (args.universe === "movers" || args.universe === "both") {
    const kinds = ["gainers", "losers", "most-active"] as const;
    let added = 0;
    for (const k of kinds) {
      const rows = await provider.getMovers(k, 25);
      // Filter out sub-$5 and sub-$1M-cap names when the provider reports cap.
      for (const r of rows) {
        if (r.last < 5) continue;
        if (r.marketCap !== undefined && r.marketCap < 300_000_000) continue;
        out.add(r.symbol);
        added += 1;
      }
    }
    sources.push(`${provider.name} movers (${added})`);
    if (added === 0) log.warn("Provider returned no movers; universe is watchlist only", { provider: provider.name });
  }
  return { symbols: [...out], source: sources.join(" + ") };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  setLogLevel(config.logLevel);
  const provider = createResearchProvider(config, args.provider);
  const equity = args.equity ?? config.researchAccountEquity;
  const riskPct = args.riskPct ?? config.researchMaxRiskPct;
  const budget = { accountEquity: equity, maxRiskPerTradePct: riskPct, maxRiskPerTradeUsd: (equity * riskPct) / 100 };
  log.info("Research run starting", { provider: provider.name, universe: args.universe, equity, riskPct, chains: args.chains, news: args.news });

  const { symbols, source } = await resolveUniverse(provider, args);
  if (symbols.length === 0) throw new Error("Universe is empty");

  const packet = await buildPacket(provider, {
    symbols,
    universeSource: source,
    budget,
    includeChains: args.chains,
    includeNews: args.news,
    maxCandidates: args.max,
    chainDaysAhead: args.daysAhead,
    strikesAroundSpot: 12,
  });
  const paths = persistPacket(packet);
  process.stdout.write(JSON.stringify({ component: "research-cli", packet: packet.id, candidates: packet.candidates.map((c) => ({ symbol: c.symbol, score: c.score })), errors: packet.errors, ...paths }) + "\n");
}

main().catch((err) => {
  process.stderr.write(`FATAL: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
