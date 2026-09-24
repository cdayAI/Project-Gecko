// One read by default; opt-in sequential polling. No chat posting or order API.
import "dotenv/config";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createLogger } from "../../core/logger.js";
import { BenzingaNewsProvider } from "./benzinga.js";
import { NewsLedger } from "./ledger.js";
import { record } from "./normalize.js";
import { parsePollPolicy, runNewsPolling } from "./polling.js";
import { SecNewsProvider } from "./sec.js";
import { XNewsProvider } from "./x.js";
import { YahooNewsProvider } from "./yahoo.js";
import type { NewsProvider } from "./types.js";

const log = createLogger("news-cli");

export function parseNewsCliArgs(values: readonly string[]): Map<string, string> {
  const allowed = new Set(["source", "symbols", "max-age-minutes", "limit", "directory", "ciks", "aliases", "authors", "once", "watch", "interval-ms", "cycles", "max-requests", "health", "help"]);
  const out = new Map<string, string>();
  for (let i = 0; i < values.length; i++) {
    const flag = values[i];
    if (!flag.startsWith("--") || !allowed.has(flag.slice(2)) || out.has(flag.slice(2))) throw new Error("Unknown or duplicate news CLI argument");
    const key = flag.slice(2);
    if (["once", "watch", "health", "help"].includes(key)) { out.set(key, "true"); continue; }
    const value = values[++i];
    if (!value || value.startsWith("--")) throw new Error("News CLI option is missing its value");
    out.set(key, value);
  }
  return out;
}

function objectFile(file: string | undefined): Record<string, unknown> {
  if (!file) return {};
  if (fs.statSync(file).size > 100_000) throw new Error("News configuration mapping exceeds 100 KB");
  const data = record(JSON.parse(fs.readFileSync(file, "utf8")) as unknown);
  if (!data) throw new Error("News configuration mapping must be a JSON object");
  return data;
}

async function main(): Promise<void> {
  const options = parseNewsCliArgs(process.argv.slice(2));
  if (options.has("help")) {
    log.info("News CLI usage", { usage: "--source yahoo|sec|x|benzinga --symbols TSLA,NVDA [--once | --watch --interval-ms 60000] [--cycles N] [--max-requests N] [--max-age-minutes 1440] [--limit 20] [--aliases FILE] [--ciks FILE] [--authors account1,account2] [--directory data/news]; paid --watch requires explicit --cycles or --max-requests; --health reads saved source status without network" });
    return;
  }
  const ledger = new NewsLedger(options.get("directory") ?? "data/news");
  if (options.has("health")) { log.info("Saved news source health", { sources: ledger.readHealth() }); return; }
  const aliases: Record<string, readonly string[]> = {};
  for (const [symbol, value] of Object.entries(objectFile(options.get("aliases")))) {
    if (!Array.isArray(value) || value.some((alias) => typeof alias !== "string" || alias.length < 3 || alias.length > 100)) throw new Error("Aliases must map a ticker to an array of company-name strings");
    aliases[symbol.toUpperCase()] = value as string[];
  }
  let provider: NewsProvider;
  switch (options.get("source") ?? "yahoo") {
    case "yahoo": provider = new YahooNewsProvider(); break;
    case "sec": {
      const mapping: Record<string, string> = {};
      for (const [symbol, cik] of Object.entries(objectFile(options.get("ciks")))) {
        if (typeof cik !== "string" || !/^\d{1,10}$/.test(cik)) throw new Error("CIK mappings must use explicit digit strings");
        mapping[symbol.toUpperCase()] = cik;
      }
      provider = new SecNewsProvider({ userAgent: process.env.SEC_USER_AGENT ?? "", cikBySymbol: mapping });
      break;
    }
    case "x": {
      const fieldSelector = process.env.X_FIELDS_PARAMETER ?? "post.fields";
      if (fieldSelector !== "post.fields" && fieldSelector !== "tweet.fields") throw new Error("Invalid X_FIELDS_PARAMETER");
      provider = new XNewsProvider({ bearerToken: process.env.X_BEARER_TOKEN ?? "", fieldSelector, authors: options.get("authors")?.split(",").map((author) => author.trim()) });
      break;
    }
    case "benzinga": provider = new BenzingaNewsProvider(process.env.BENZINGA_API_KEY ?? ""); break;
    default: throw new Error("News source must be yahoo, sec, x or benzinga");
  }
  const symbols = [...new Set((options.get("symbols") ?? "").split(",").map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))];
  const policy = parsePollPolicy(options, provider.source);
  const controller = new AbortController();
  const shutdown = (): void => { controller.abort(); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    const summary = await runNewsPolling(provider, { symbols, maxAgeMs: Number(options.get("max-age-minutes") ?? "1440") * 60_000,
      limitPerSymbol: Number(options.get("limit") ?? "20"), aliases }, ledger, policy, { signal: controller.signal,
      onCycle: (result, cycle) => { log.info("News ingestion completed", { source: provider.source,
        eventIds: result.events.map((event) => event.id), health: result.health, cycle }); } });
    log.info("News collector stopped", { source: provider.source, ...summary });
    if (summary.reason === "source-failed") process.exitCode = 2;
  } finally {
    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => { log.error("News ingestion failed; check configuration, polling bounds or ledger integrity. Credentials and provider bodies are omitted."); process.exitCode = 1; });
}
