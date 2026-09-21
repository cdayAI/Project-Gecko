// Exact-contract research shortlist. No plan activation, orders, automatic
// directional thesis, fill assumptions, or probability-of-profit estimates.
import { evaluateQuotePair } from "../research/quote-quality.js";
import type { Candidate, Headline, OptionQuote, ResearchPacket } from "../research/types.js";
import { etDate } from "../utils/time.js";

export type PickerDirection = "LONG" | "SHORT" | "BOTH" | "NONE";
export interface OptionsPickerConfig {
  readonly planningEquity: number;
  readonly maxDebitUsd: number;
  readonly maxFullLossUsd: number;
  readonly quantity: number;
  readonly feePerContractPerSide: number;
  readonly minDte: number;
  readonly maxDte: number;
  readonly minAbsDelta: number;
  readonly maxAbsDelta: number;
  readonly minVolume: number;
  readonly minOpenInterest: number;
  readonly maxResults: number;
  readonly direction: PickerDirection;
  readonly directions: Readonly<Record<string, PickerDirection>>;
}
export interface PickedOption {
  readonly rank: number;
  readonly symbol: string;
  readonly contract: string;
  readonly direction: "LONG" | "SHORT";
  readonly expiration: string;
  readonly strike: number;
  readonly daysToExpiration: number;
  readonly dataStatus: "DATA_PASS";
  readonly selectionScore: number;
  readonly reasons: readonly string[];
  readonly countercase: readonly string[];
  readonly evidence: readonly Headline[];
  readonly bid: number;
  readonly ask: number;
  readonly delta: number;
  readonly iv: number | null;
  readonly volume: number;
  readonly openInterest: number;
  readonly quoteTime: number;
  readonly underlyingQuoteTime: number;
  readonly underlyingLastTradeTime: number;
  readonly dataValidUntil: number;
  readonly quantity: number;
  readonly premiumDebitUsd: number;
  readonly fullLossUsd: number;
  readonly assumedRoundTripFeesUsd: number;
  readonly plannedStopRiskUsd: null;
  readonly probabilityOfProfit: null;
  readonly stockComparison: {
    readonly approximateDeltaShares: number;
    readonly approximateStockNotionalUsd: number;
    readonly rationale: readonly string[];
  };
}
export interface UnderlyingPickerDecision {
  readonly symbol: string;
  readonly status: "SELECTED" | "REJECTED";
  readonly selectedContract: string | null;
  readonly examinedContracts: number;
  readonly qualifiedContracts: number;
  readonly codes: readonly string[];
  readonly rejectionCounts: Readonly<Record<string, number>>;
  readonly qualitySamples: readonly { contract: string; reasons: readonly string[] }[];
}
export interface OptionsPickerReport {
  readonly mode: "CURRENT_RESEARCH" | "HISTORICAL_RESEARCH";
  readonly asOfMs: number;
  readonly generatedAt: number;
  readonly packetId: string | null;
  readonly config: OptionsPickerConfig;
  readonly picks: readonly PickedOption[];
  readonly decisions: readonly UnderlyingPickerDecision[];
  readonly limitations: readonly string[];
}

const DEFAULTS: OptionsPickerConfig = Object.freeze({ planningEquity: 5000,
  maxDebitUsd: 250, maxFullLossUsd: 250, quantity: 1, feePerContractPerSide: 0.10,
  minDte: 1, maxDte: 45, minAbsDelta: 0.35, maxAbsDelta: 0.65,
  minVolume: 100, minOpenInterest: 100, maxResults: 5, direction: "BOTH", directions: Object.freeze({}) });
const DIRECTIONS: readonly PickerDirection[] = ["LONG", "SHORT", "BOTH", "NONE"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function positiveInteger(value: unknown): value is number { return finite(value) && Number.isSafeInteger(value) && value > 0; }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : []; }
function validatedConfig(input: Partial<OptionsPickerConfig>): OptionsPickerConfig {
  if (!isRecord(input)) throw new Error("Picker configuration must be an object");
  const cfg: OptionsPickerConfig = { ...DEFAULTS, ...input };
  for (const key of ["planningEquity", "maxDebitUsd", "maxFullLossUsd", "minAbsDelta", "maxAbsDelta"] as const) {
    if (!finite(cfg[key]) || cfg[key] <= 0) throw new Error(`Invalid picker ${key}`);
  }
  for (const key of ["quantity", "minDte", "maxDte", "maxResults"] as const) {
    if (!positiveInteger(cfg[key])) throw new Error(`Invalid picker ${key}`);
  }
  for (const key of ["feePerContractPerSide", "minVolume", "minOpenInterest"] as const) {
    if (!finite(cfg[key]) || cfg[key] < 0) throw new Error(`Invalid picker ${key}`);
  }
  if (cfg.maxDebitUsd > cfg.planningEquity || cfg.maxFullLossUsd > cfg.planningEquity || cfg.maxDebitUsd > cfg.maxFullLossUsd
    || cfg.quantity > 10 || cfg.maxResults > 5 || cfg.minDte > cfg.maxDte || cfg.maxDte > 45
    || cfg.minAbsDelta < 0.35 || cfg.maxAbsDelta > 0.65 || cfg.minAbsDelta > cfg.maxAbsDelta) throw new Error("Picker limits outside bounded research constraints");
  if (!DIRECTIONS.includes(cfg.direction) || !isRecord(cfg.directions)
    || Object.entries(cfg.directions).some(([symbol, direction]) => !/^[A-Z]{1,6}$/.test(symbol) || !DIRECTIONS.includes(direction))) {
    throw new Error("Invalid picker direction selector");
  }
  return { ...cfg, directions: { ...cfg.directions } };
}
function dateOrdinal(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value ? ms / 86_400_000 : null;
}
function availableEvidence(candidate: Candidate, asOf: number): Headline[] {
  const catalyst = candidate.catalysts;
  if (!catalyst || !Array.isArray(catalyst.headlines)) return [];
  const received = catalyst.headlinesProvenance?.capturedAt;
  if (!positiveInteger(received) || received > asOf) return [];
  return catalyst.headlines.filter((h) => {
    if (!h || typeof h.title !== "string" || !h.title.trim() || typeof h.publisher !== "string" || !h.publisher.trim()
      || !positiveInteger(h.publishedAt) || h.publishedAt > asOf || !h.url) return false;
    try { return ["https:", "http:"].includes(new URL(h.url).protocol); } catch { return false; }
  }).slice(0, 5);
}

/** One exact single-leg long option per root, at most five roots. The defaults
 * are research constraints, not empirically optimized strategy parameters.
 * Explicit historical asOf is allowed for replay; never treated as current.
 */
export function pickOptions(input: readonly Candidate[] | ResearchPacket,
  config: Partial<OptionsPickerConfig> = {}, asOfMs = Date.now()): OptionsPickerReport {
  const generatedAt = Date.now();
  if (!positiveInteger(asOfMs) || asOfMs > generatedAt) throw new Error("Picker asOf must be a positive integer no later than now");
  const cfg = validatedConfig(config);
  const packet = Array.isArray(input) ? null : input as ResearchPacket;
  const candidates: readonly Candidate[] = Array.isArray(input) ? input as Candidate[] : packet?.candidates ?? [];
  if (!Array.isArray(candidates) || candidates.length > 200) throw new Error("Picker expects at most 200 candidate roots");
  if (packet && (!isRecord(packet) || !Array.isArray(packet.candidates))) throw new Error("Malformed research packet");
  const packetTime = packet ? Date.parse(packet.generatedAt) : null;
  const packetTimeInvalid = packet !== null && (!finite(packetTime) || packetTime > asOfMs);
  const counts = new Map<string, number>();
  for (const candidate of candidates) if (candidate && typeof candidate.symbol === "string") counts.set(candidate.symbol, (counts.get(candidate.symbol) ?? 0) + 1);
  const decisions: UnderlyingPickerDecision[] = [];
  const possible: PickedOption[] = [];
  const today = dateOrdinal(etDate(asOfMs))!;
  for (const candidate of candidates) {
    const symbol = candidate && typeof candidate.symbol === "string" ? candidate.symbol : "UNKNOWN";
    const rejectionCounts: Record<string, number> = {};
    const qualitySamples: { contract: string; reasons: readonly string[] }[] = [];
    const reject = (code: string): void => { rejectionCounts[code] = (rejectionCounts[code] ?? 0) + 1; };
    const qualified: PickedOption[] = [];
    let examined = 0;
    if (packetTimeInvalid) reject("PACKET_TIME_INVALID_OR_FUTURE");
    else if (!candidate || !/^[A-Z]{1,6}$/.test(symbol) || candidate.snapshot?.symbol !== symbol) reject("MALFORMED_CANDIDATE");
    else if ((counts.get(symbol) ?? 0) > 1) reject("DUPLICATE_UNDERLYING");
    else if (!candidate.chain || !Array.isArray(candidate.chain.contracts) || candidate.chain.contracts.length === 0) reject("NO_OPTION_DATA");
    else if (candidate.chain.underlying !== symbol || candidate.chain.contracts.length > 2000) reject("INVALID_OR_UNBOUNDED_CHAIN");
    else if (!positiveInteger(candidate.snapshot.provenance?.capturedAt) || candidate.snapshot.provenance.capturedAt > asOfMs
      || !positiveInteger(candidate.chain.provenance?.capturedAt) || candidate.chain.provenance.capturedAt > asOfMs) reject("RECEIPT_TIME_INVALID_OR_FUTURE");
    else {
      const direction = cfg.directions[symbol] ?? cfg.direction;
      const seen = new Set<string>();
      const duplicateContracts = new Set<string>();
      for (const q of candidate.chain.contracts) {
        if (q && typeof q.osiSymbol === "string") { if (seen.has(q.osiSymbol)) duplicateContracts.add(q.osiSymbol); seen.add(q.osiSymbol); }
      }
      for (const q of candidate.chain.contracts) {
        examined++;
        if (!q || typeof q.osiSymbol !== "string") { reject("MALFORMED_OPTION"); continue; }
        if (duplicateContracts.has(q.osiSymbol)) { reject("DUPLICATE_CONTRACT"); continue; }
        if (direction === "NONE" || (direction === "LONG" && q.optionType !== "CALL") || (direction === "SHORT" && q.optionType !== "PUT")) { reject("DIRECTION_EXCLUDED"); continue; }
        const expiration = typeof q.expiration === "string" ? dateOrdinal(q.expiration) : null;
        const dte = expiration === null ? NaN : expiration - today;
        if (!Number.isSafeInteger(dte) || dte < cfg.minDte || dte > cfg.maxDte) { reject("DTE_OUT_OF_RANGE"); continue; }
        const quality = evaluateQuotePair(candidate.snapshot, q, asOfMs);
        if (quality.status !== "DATA_PASS") {
          reject("DATA_QUALITY_BLOCK");
          if (qualitySamples.length < 10) qualitySamples.push({ contract: q.osiSymbol, reasons: quality.reasons });
          continue;
        }
        if (!positiveInteger(q.provenance?.capturedAt) || q.provenance.capturedAt > asOfMs) { reject("RECEIPT_TIME_INVALID_OR_FUTURE"); continue; }
        if (!finite(q.delta) || (q.optionType === "CALL" ? q.delta <= 0 : q.delta >= 0)) { reject("DELTA_MISSING_OR_INVALID_SIGN"); continue; }
        if (Math.abs(q.delta) < cfg.minAbsDelta || Math.abs(q.delta) > cfg.maxAbsDelta) { reject("DELTA_OUT_OF_RANGE"); continue; }
        if (!finite(q.volume) || q.volume < cfg.minVolume || !finite(q.openInterest) || q.openInterest < cfg.minOpenInterest) { reject("VOLUME_OR_OPEN_INTEREST_INSUFFICIENT"); continue; }
        const debit = q.ask * 100 * cfg.quantity;
        const fees = 2 * cfg.feePerContractPerSide * cfg.quantity;
        if (!Number.isFinite(debit + fees) || debit > cfg.maxDebitUsd || debit + fees > cfg.maxFullLossUsd) { reject("NOT_AFFORDABLE"); continue; }
        qualified.push(makePick(candidate, q, dte, debit, fees, cfg, asOfMs));
      }
    }
    qualified.sort(comparePicks);
    if (qualified[0]) possible.push(qualified[0]);
    const codes = qualified.length ? [] : Object.keys(rejectionCounts);
    if (!qualified.length && rejectionCounts.NOT_AFFORDABLE) codes.push("NO_AFFORDABLE_CONTRACT");
    decisions.push({ symbol, status: "REJECTED", selectedContract: null, examinedContracts: examined,
      qualifiedContracts: qualified.length, codes, rejectionCounts, qualitySamples });
  }
  possible.sort(comparePicks);
  const picks = possible.slice(0, cfg.maxResults).map((pick, index) => ({ ...pick, rank: index + 1 }));
  const selected = new Map(picks.map((pick) => [pick.symbol, pick.contract]));
  return { mode: generatedAt - asOfMs > 5000 ? "HISTORICAL_RESEARCH" : "CURRENT_RESEARCH", asOfMs, generatedAt,
    packetId: packet && typeof packet.id === "string" ? packet.id : null, config: cfg, picks,
    decisions: decisions.map((decision) => selected.has(decision.symbol) ? { ...decision, status: "SELECTED", selectedContract: selected.get(decision.symbol)! }
      : decision.qualifiedContracts ? { ...decision, codes: ["RANK_CUTOFF"] } : decision),
    limitations: ["Research shortlist only. Ranking is not strategy edge, a win probability, or trade authorization.",
      "Planning equity does not establish funded buying power or options approval. Picks are alternatives, not a portfolio allocation.",
      "Only candidate.snapshot supplies the underlying quote; cached chain underlyingPrice/underlyingSnapshot cannot repair a stale pair.",
      "Contract universe may be bounded or incomplete. No 0DTE, spreads, stock execution, automatic plan activation, or orders.",
      "Fees are explicit planning assumptions; quote sizes do not guarantee fills. Feed coverage and separate Greek/OI timestamps remain unverified.",
      "Before any trade: current quotes, attributed catalyst/countercase, underlying trigger, invalidation, stop, target, time exit and account-level risk review are still required."] };
}

function comparePicks(a: PickedOption, b: PickedOption): number {
  return b.selectionScore - a.selectionScore || a.fullLossUsd - b.fullLossUsd || a.symbol.localeCompare(b.symbol) || a.contract.localeCompare(b.contract);
}
function makePick(candidate: Candidate, q: OptionQuote, dte: number, debit: number, fees: number,
  cfg: OptionsPickerConfig, asOf: number): PickedOption {
  const delta = q.delta!;
  const spreadFraction = (q.ask - q.bid) / ((q.ask + q.bid) / 2);
  const score = 45 * (1 - Math.min(1, spreadFraction / .05))
    + 25 * Math.max(0, 1 - Math.abs(Math.abs(delta) - .5) / .15)
    + 15 * Math.min(1, Math.log1p(q.volume) / Math.log1p(1000))
    + 15 * Math.min(1, Math.log1p(q.openInterest) / Math.log1p(5000));
  const evidence = availableEvidence(candidate, asOf);
  const countercase = [...strings(candidate.warnings)];
  if (!evidence.length) countercase.push("No attributed, timestamped headline available as of this evaluation; catalyst thesis is unverified.");
  if (!candidate.chain?.completeness?.quotesComplete) countercase.push("Option snapshot coverage is incomplete or unverified.");
  countercase.push("Historical IV rank and realized-volatility comparison are unavailable; this IV cannot establish whether premium is expensive.");
  if (finite(q.iv) && q.iv >= .75) countercase.push("Absolute IV is at least 75% annualized; volatility contraction can offset a correct directional move.");
  if (!finite(q.iv) || q.iv <= 0) countercase.push("Implied volatility is unavailable or invalid.");
  const earningsReceived = candidate.catalysts?.earningsProvenance?.capturedAt;
  if (candidate.catalysts?.nextEarningsDate && positiveInteger(earningsReceived) && earningsReceived <= asOf) countercase.push(`Source reports earnings ${candidate.catalysts.nextEarningsDate}; verify timing and event exposure before entry.`);
  else countercase.push("Next earnings date is unknown; absence of an event has not been established.");
  const approximateDeltaShares = Math.abs(delta) * 100 * cfg.quantity;
  return { rank: 0, symbol: candidate.symbol, contract: q.osiSymbol, direction: q.optionType === "CALL" ? "LONG" : "SHORT",
    expiration: q.expiration, strike: q.strike, daysToExpiration: dte, dataStatus: "DATA_PASS",
    selectionScore: Math.round(score * 100) / 100,
    reasons: [`Observed standard multiplier-100 contract; ${dte} calendar days to expiry.`,
      `Bid/ask spread ${(spreadFraction * 100).toFixed(2)}% of midpoint; delta ${delta.toFixed(3)}.`,
      `Reported volume ${q.volume}, open interest ${q.openInterest}; one spread/delta/liquidity score, not expected return.`,
      `Ask-based premium $${debit.toFixed(2)} plus assumed round-trip fees $${fees.toFixed(2)} fits the configured full-loss cap.`,
      ...strings(candidate.scoreReasons).map((reason) => `Source attention rationale (unvalidated): ${reason}`)],
    countercase, evidence, bid: q.bid, ask: q.ask, delta, iv: finite(q.iv) && q.iv > 0 ? q.iv : null,
    volume: q.volume, openInterest: q.openInterest, quoteTime: q.quoteTime!, underlyingQuoteTime: candidate.snapshot.quoteTime!,
    underlyingLastTradeTime: candidate.snapshot.lastTradeTime!,
    dataValidUntil: Math.min(asOf + 2000, q.quoteTime! + 5000, candidate.snapshot.quoteTime! + 5000, candidate.snapshot.lastTradeTime! + 5000),
    quantity: cfg.quantity, premiumDebitUsd: debit, fullLossUsd: debit + fees, assumedRoundTripFeesUsd: fees,
    plannedStopRiskUsd: null, probabilityOfProfit: null,
    stockComparison: { approximateDeltaShares, approximateStockNotionalUsd: approximateDeltaShares * candidate.snapshot.ask,
      rationale: ["Shares avoid option expiry and time decay. This is a local delta sensitivity comparison, not equal payoff or equal risk.",
        q.optionType === "PUT" ? "Replacing a long put with short stock requires separately verified short-sale permissions, borrow and liability limits."
          : "A smaller stock position may express the thesis without paying option time value; the correct comparison needs an underlying stop and share sizing.",
        "Long-option full loss is premium plus the stated fee allowance; no planned stop loss has been supplied here."] } };
}

function cell(value: unknown): string { return String(value).replace(/[\r\n|]/g, " ").replace(/</g, "&lt;"); }
export function renderOptionsPickerMarkdown(report: OptionsPickerReport): string {
  const lines = ["# Options research shortlist", "", `Mode: ${report.mode}. Evaluated ${new Date(report.asOfMs).toISOString()}.`,
    "Ranks compare contract data and affordability; they do not predict returns or authorize a trade.", "",
    "| Rank | Underlying | Exact contract | Direction | DTE | Bid / ask | Quantity | Premium debit | Full-loss allowance | Data valid until |",
    "|---:|---|---|---|---:|---:|---:|---:|---:|---|" ];
  for (const pick of report.picks) lines.push(`| ${pick.rank} | ${pick.symbol} | ${pick.contract} | ${pick.direction} | ${pick.daysToExpiration} | ${pick.bid.toFixed(2)} / ${pick.ask.toFixed(2)} | ${pick.quantity} | $${pick.premiumDebitUsd.toFixed(2)} | $${pick.fullLossUsd.toFixed(2)} | ${new Date(pick.dataValidUntil).toISOString()} |`);
  if (!report.picks.length) lines.push("", "No contracts pass the configured data, liquidity, direction and affordability constraints. No trade is implied.");
  for (const pick of report.picks) {
    lines.push("", `## ${pick.symbol}: ${pick.contract}`, "", ...pick.reasons.map((r) => `- ${cell(r)}`),
      "", "Countercase / missing evidence:", "", ...pick.countercase.map((r) => `- ${cell(r)}`),
      "", "Stock versus options:", "", ...pick.stockComparison.rationale.map((r) => `- ${cell(r)}`),
      `- Approximate delta-equivalent shares: ${pick.stockComparison.approximateDeltaShares.toFixed(2)}; stock notional at ask: $${pick.stockComparison.approximateStockNotionalUsd.toFixed(2)}.`,
      "", "Attributed evidence:", "");
    for (const h of pick.evidence) lines.push(`- ${cell(h.publisher)}; ${new Date(h.publishedAt).toISOString()}; ${cell(h.title)}; ${cell(h.url)}`);
    if (!pick.evidence.length) lines.push("- None verified in the supplied packet as of evaluation.");
  }
  lines.push("", "## Rejections", "");
  for (const d of report.decisions.filter((d) => d.status === "REJECTED")) {
    lines.push(`- ${cell(d.symbol)}: ${d.codes.join(", ")}; ${JSON.stringify(d.rejectionCounts)}`);
    for (const sample of d.qualitySamples.slice(0, 3)) lines.push(`- ${cell(d.symbol)} / ${cell(sample.contract)}: ${sample.reasons.map(cell).join(", ")}`);
  }
  lines.push("", "## Limits", "", ...report.limitations.map((r) => `- ${cell(r)}`));
  return lines.join("\n") + "\n";
}
