// Data qualification only. DATA_PASS is not permission to trade, a check of
// account approval/buying power, or evidence of strategy edge.
import type { OptionQuote, UnderlyingSnapshot } from "./types.js";
import { parseOsi } from "./osi.js";
export interface QuoteQualityConfig {
  readonly maxAgeMs: number;
  readonly maxSkewMs: number;
  readonly maxSpreadFraction: number;
  readonly maxSpreadAbsolute: number;
  readonly futureToleranceMs: number;
}
export interface QuoteQualityResult {
  readonly status: "DATA_PASS" | "DATA_BLOCK";
  readonly reasons: string[];
}
const DEFAULTS: QuoteQualityConfig = Object.freeze({ maxAgeMs: 5000, maxSkewMs: 2000,
  maxSpreadFraction: 0.05, maxSpreadAbsolute: 0.10, futureToleranceMs: 500 });
function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
function timestamp(value: unknown): value is number { return positive(value) && Number.isSafeInteger(value); }
function checkTime(value: unknown, label: string, now: number, maxAge: number, tolerance: number, reasons: string[]): void {
  if (!timestamp(value)) reasons.push(`${label}:missing_or_invalid_timestamp`);
  else if (value - now > tolerance) reasons.push(`${label}:future_timestamp`);
  else if (now - value > maxAge) reasons.push(`${label}:stale`);
}
function checkQuote(quote: UnderlyingSnapshot | OptionQuote, label: string, cfg: QuoteQualityConfig, reasons: string[]): void {
  if (!positive(quote.bid) || !positive(quote.ask)) reasons.push(`${label}:invalid_bid_ask`);
  else if (quote.ask < quote.bid) reasons.push(`${label}:crossed`);
  else {
    const spread = quote.ask - quote.bid;
    const midpoint = quote.ask / 2 + quote.bid / 2;
    const epsilon = Number.EPSILON * Math.max(1, quote.ask, quote.bid) * 4;
    if (spread - cfg.maxSpreadAbsolute > epsilon) reasons.push(`${label}:spread_absolute`);
    if (spread / midpoint - cfg.maxSpreadFraction > Number.EPSILON * 4) reasons.push(`${label}:spread_fraction`);
  }
  if (!positive(quote.bidSize) || !positive(quote.askSize)) reasons.push(`${label}:missing_or_invalid_size`);
}
export function evaluateQuotePair(underlying: UnderlyingSnapshot, option: OptionQuote, nowMs: number,
  config: Partial<QuoteQualityConfig> = {}): QuoteQualityResult {
  const reasons: string[] = [];
  if (!config || typeof config !== "object" || Array.isArray(config)) return { status: "DATA_BLOCK", reasons: ["invalid_config"] };
  const cfg = { ...DEFAULTS, ...config };
  for (const key of Object.keys(DEFAULTS) as (keyof QuoteQualityConfig)[]) {
    if (!positive(cfg[key])) reasons.push(`config:${key}:invalid`);
  }
  if (!timestamp(nowMs)) reasons.push("invalid_as_of_timestamp");
  if (!underlying || typeof underlying !== "object" || !option || typeof option !== "object") reasons.push("missing_quote_pair");
  if (reasons.length) return { status: "DATA_BLOCK", reasons };
  const parsed = typeof option.osiSymbol === "string" ? parseOsi(option.osiSymbol) : null;
  if (!parsed || parsed.underlying !== underlying.symbol || option.underlying !== underlying.symbol
    || !Number.isFinite(Date.parse(parsed.expiration))
    || new Date(parsed.expiration).toISOString().slice(0, 10) !== parsed.expiration
    || parsed.expiration !== option.expiration || parsed.strike !== option.strike || parsed.optionType !== option.optionType) reasons.push("contract:identity_mismatch");
  if (option.contractVerified !== true || option.contractStandard !== true || option.contractMultiplier !== 100) reasons.push("contract:standard_100_not_verified");
  if (option.provenance?.delayMinutes !== 0 || option.provenance?.delayed === true
    || option.provenance?.delayStatus === "delayed") reasons.push("option:delay_unknown_or_nonzero");
  if (underlying.provenance?.delayed === true || underlying.provenance?.delayStatus === "delayed"
    || (underlying.provenance?.delayMinutes !== undefined && underlying.provenance.delayMinutes !== 0)) reasons.push("underlying:delayed");
  checkQuote(underlying, "underlying", cfg, reasons);
  checkQuote(option, "option", cfg, reasons);
  checkTime(underlying.quoteTime, "underlying_quote", nowMs, cfg.maxAgeMs, cfg.futureToleranceMs, reasons);
  checkTime(option.quoteTime, "option_quote", nowMs, cfg.maxAgeMs, cfg.futureToleranceMs, reasons);
  if (!positive(underlying.last)) reasons.push("underlying:invalid_last");
  // The last trade can be stale independently of an updated NBBO.
  checkTime(underlying.lastTradeTime, "underlying_last_trade", nowMs, 5000, cfg.futureToleranceMs, reasons);
  if (timestamp(underlying.quoteTime) && timestamp(option.quoteTime)
    && Math.abs(underlying.quoteTime - option.quoteTime) > cfg.maxSkewMs) reasons.push("pair:quote_time_skew");
  return { status: reasons.length ? "DATA_BLOCK" : "DATA_PASS", reasons };
}
