// Earnings calendar from Nasdaq's public JSON endpoint (no key). Shape
// verified 2026-09-22: data.rows[] with symbol, name, time
// ("time-pre-market" | "time-after-hours" | "time-not-supplied"),
// marketCap, epsForecast, noOfEsts, fiscalQuarterEnding. Cached per date
// under data/earnings/ for 12 hours. Names outside the universe are
// filtered by the caller.

import * as fs from "node:fs";
import * as path from "node:path";
import { createLogger } from "../core/logger.js";
import { fetchWithRetry } from "../utils/retry.js";

const log = createLogger("earnings-calendar");
const URL_BASE = "https://api.nasdaq.com/api/calendar/earnings";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const CACHE_DIR = path.join("data", "earnings");
const CACHE_TTL_MS = 12 * 3_600_000;

export interface EarningsRow {
  readonly symbol: string;
  readonly name: string;
  readonly time: "pre-market" | "after-hours" | "unknown";
  readonly epsForecast: string;
  readonly marketCap: string;
}

interface NasdaqRow { symbol?: unknown; name?: unknown; time?: unknown; epsForecast?: unknown; marketCap?: unknown }

export async function fetchEarnings(date: string): Promise<readonly EarningsRow[]> {
  const cache = path.join(CACHE_DIR, `${date}.json`);
  try {
    if (fs.existsSync(cache) && Date.now() - fs.statSync(cache).mtimeMs < CACHE_TTL_MS) {
      return JSON.parse(fs.readFileSync(cache, "utf-8")) as EarningsRow[];
    }
  } catch (err) {
    log.warn("Earnings cache read failed", { date, error: msg(err) });
  }
  try {
    const resp = await fetchWithRetry(`${URL_BASE}?date=${date}`, { headers: { "User-Agent": USER_AGENT, Accept: "application/json", "Accept-Language": "en-US,en;q=0.9" } });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = (await resp.json()) as { data?: { rows?: unknown } };
    const raw = json.data?.rows;
    if (!Array.isArray(raw)) {
      log.warn("Earnings calendar: unexpected shape", { date, keys: Object.keys(json.data ?? {}) });
      return [];
    }
    const rows: EarningsRow[] = [];
    for (const r of raw as NasdaqRow[]) {
      if (typeof r.symbol !== "string" || r.symbol.length === 0) continue;
      const t = typeof r.time === "string" ? r.time : "";
      rows.push({
        symbol: r.symbol.toUpperCase(),
        name: typeof r.name === "string" ? r.name : "",
        time: t === "time-pre-market" ? "pre-market" : t === "time-after-hours" ? "after-hours" : "unknown",
        epsForecast: typeof r.epsForecast === "string" ? r.epsForecast : "",
        marketCap: typeof r.marketCap === "string" ? r.marketCap : "",
      });
    }
    try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(cache, JSON.stringify(rows)); } catch (err) { log.warn("Earnings cache write failed", { error: msg(err) }); }
    log.info("Earnings calendar fetched", { date, rows: rows.length });
    return rows;
  } catch (err) {
    log.warn("Earnings calendar fetch failed", { date, error: msg(err) });
    return [];
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
