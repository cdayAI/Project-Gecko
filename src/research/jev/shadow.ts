import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { NewsLedger } from "../news/ledger.js";
import { record, hash } from "../news/normalize.js";
import type { NewsEvent } from "../news/types.js";
import { JEV_MODEL, JevError, type JevRequest, type JevResponse } from "./client.js";
import { buildRequest, requestKey, PROMPT_VERSION, type EvidenceContext } from "./questions.js";

export interface Evaluator { evaluate(request: JevRequest): Promise<JevResponse> }
export interface ShadowOptions {
  directory: string;
  newsDirectory: string;
  maxEvents: number;
  maxRequests: number;
  maxAgeMs: number;
  now?: number;
  contexts?: readonly EvidenceContext[];
  synthetic?: boolean;
  probe?: boolean;
  /** Optional foreground-worker gates; ordinary bounded batches remain unchanged. */
  eventFilter?: (event: NewsEvent) => boolean;
  canRequest?: () => boolean;
}
export interface ShadowSummary {
  runId: string; mode: "LIVE_SHADOW" | "SYNTHETIC_OFFLINE" | "AUTHENTICATED_SYNTHETIC_PROBE";
  startedAt: number; completedAt: number; model: string; promptVersion: string;
  scanned: number; eligible: number; attempted: number; succeeded: number; cached: number;
  unresolved: number; invalid: number; deferred: number; inputTokens: number;
  estimatedInputCostUsd: number; stoppedReason: string | null;
  sourceHealth: unknown[]; status: "RESEARCH_ONLY"; monitorActive: false;
}
interface JournalRow { schemaVersion: 1; type: "reserved" | "result" | "error"; key: string; attemptId: string; [key: string]: unknown }

export function readJournal(directory: string): JournalRow[] {
  const file = path.join(directory, "evaluations.jsonl");
  if (!fs.existsSync(file)) return [];
  if (fs.statSync(file).size > 50_000_000) throw new Error("Jev journal too large; archive explicitly");
  return fs.readFileSync(file, "utf8").split("\n").filter(x => x.trim()).map(line => {
    const row = record(JSON.parse(line) as unknown);
    if (!row || row.schemaVersion !== 1 || !["reserved", "result", "error"].includes(String(row.type))
      || typeof row.key !== "string" || typeof row.attemptId !== "string") throw new Error("Invalid Jev journal; refusing silent loss");
    return row as JournalRow;
  });
}
function append(directory: string, row: JournalRow): void {
  const fd = fs.openSync(path.join(directory, "evaluations.jsonl"), "a", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(row) + "\n", "utf8"); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}
function bounds(options: ShadowOptions): void {
  if (!Number.isInteger(options.maxRequests) || options.maxRequests < 1 || options.maxRequests > 1000
    || !Number.isInteger(options.maxEvents) || options.maxEvents < 1 || options.maxEvents > 1000
    || !Number.isFinite(options.maxAgeMs) || options.maxAgeMs < 1 || options.maxAgeMs > 31 * 86400000
    || options.probe && (options.synthetic || options.maxRequests !== 1)) throw new Error("Invalid bounded shadow configuration");
}

export async function runShadow(evaluator: Evaluator, options: ShadowOptions): Promise<ShadowSummary> {
  bounds(options);
  const now = options.now ?? Date.now();
  if (!Number.isFinite(now) || now <= 0) throw new Error("Invalid decision timestamp");
  fs.mkdirSync(options.directory, { recursive: true });
  const lock = path.join(options.directory, ".run.lock");
  // Serialize the entire run so two workers cannot bill the same event concurrently.
  const lockFd = fs.openSync(lock, "wx", 0o600);
  try {
    fs.writeFileSync(lockFd, JSON.stringify({ pid: process.pid, at: Date.now() }));
    const history = readJournal(options.directory);
    const attempts = new Map<string, JournalRow>();
    for (const row of history) {
      if (row.type === "reserved") { if (attempts.has(row.attemptId)) throw new Error("Duplicate reservation"); }
      else if (attempts.get(row.attemptId)?.type !== "reserved" || attempts.get(row.attemptId)?.key !== row.key) throw new Error("Orphan or duplicate result");
      attempts.set(row.attemptId, row);
    }
    const complete = new Set(history.filter(r => r.type === "result").map(r => r.key));
    const unknown = new Set([...attempts.values()].filter(r => r.type === "reserved" || r.type === "error" && r.uncertain === true).map(r => r.key));
    const ledger = new NewsLedger(options.newsDirectory);
    const events = ledger.readEvents({ now });
    const eligible = events.filter(e => now - e.publishedAt <= options.maxAgeMs && (!options.eventFilter || options.eventFilter(e)));
    const contexts = new Map<string, EvidenceContext>();
    for (const context of options.contexts ?? []) {
      if (contexts.has(context.eventId)) throw new Error("Duplicate evidence context");
      contexts.set(context.eventId, context);
    }
    const summary: ShadowSummary = { runId: randomUUID(), mode: options.probe ? "AUTHENTICATED_SYNTHETIC_PROBE" : options.synthetic ? "SYNTHETIC_OFFLINE" : "LIVE_SHADOW", startedAt: now, completedAt: now,
      model: JEV_MODEL, promptVersion: PROMPT_VERSION, scanned: events.length, eligible: eligible.length,
      attempted: 0, succeeded: 0, cached: 0, unresolved: 0, invalid: 0, deferred: 0, inputTokens: 0,
      estimatedInputCostUsd: 0, stoppedReason: null, sourceHealth: ledger.readHealth(now), status: "RESEARCH_ONLY", monitorActive: false };
    let examined = 0;
    for (const event of eligible) {
      const context = contexts.get(event.id);
      let request: JevRequest;
      try { request = buildRequest(event, now, context); }
      catch { summary.invalid++; continue; }
      const key = requestKey(event, request, context);
      if (complete.has(key)) { summary.cached++; continue; }
      if (unknown.has(key)) { summary.unresolved++; continue; }
      if (examined >= options.maxEvents) { summary.deferred++; continue; }
      examined++;
      if (summary.attempted >= options.maxRequests || summary.stoppedReason) { summary.deferred++; continue; }
      if (options.eventFilter && !options.eventFilter(event)) { summary.deferred++; continue; }
      if (options.canRequest && !options.canRequest()) { summary.stoppedReason = "caller-stopped-before-request"; summary.deferred++; continue; }
      const attemptId = randomUUID();
      const common = { schemaVersion: 1 as const, key, attemptId, runId: summary.runId, mode: summary.mode };
      // This append must succeed before a request. Crash/timeout reservations are never automatically retried.
      append(options.directory, { ...common, type: "reserved", at: Date.now(), model: JEV_MODEL, promptVersion: PROMPT_VERSION,
        requestHash: hash(JSON.stringify(request)), requestBytes: Buffer.byteLength(JSON.stringify(request)),
        eventId: event.id, revision: event.revision, contentHash: event.contentHash, sourceUrl: event.url,
        publishedAt: event.publishedAt, observedAt: Math.max(event.fetchedAt, event.firstSeenAt, context?.observedAt ?? 0),
        eventSnapshot: event, context: context ?? null, request });
      summary.attempted++;
      const begin = performance.now();
      let response: JevResponse;
      try { response = await evaluator.evaluate(request); }
      catch (error) {
        const code = error instanceof JevError ? error.code : "evaluation-failed";
        // Network errors, malformed 200s and timeouts may already have incurred a charge.
        const status = error instanceof JevError ? error.status : undefined;
        const uncertain = ![400, 401, 403, 404, 422, 429].includes(status ?? 0);
        append(options.directory, { ...common, type: "error", at: Date.now(), code, uncertain,
          latencyMs: performance.now() - begin, ...(status === undefined ? {} : { httpStatus: status }) });
        summary.stoppedReason = "provider-error-no-automatic-retry";
        continue;
      }
      append(options.directory, { ...common, type: "result", at: Date.now(), latencyMs: performance.now() - begin,
        eventId: event.id, response, probabilityMeaning: "semantic-label-only", tradeWinProbability: null,
        status: "RESEARCH_ONLY", orderEligible: false });
      summary.succeeded++;
      summary.inputTokens += response.usage.input_tokens;
      complete.add(key);
    }
    summary.completedAt = Date.now();
    // Published input-only pricing, not a spending ceiling or full data-service cost.
    summary.estimatedInputCostUsd = options.synthetic ? 0 : summary.inputTokens * 0.042 / 1_000_000;
    fs.writeFileSync(path.join(options.directory, `run-${summary.runId}.json`), JSON.stringify(summary, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    fs.writeFileSync(path.join(options.directory, `review-${summary.runId}.md`), renderReview(summary, readJournal(options.directory)), { flag: "wx", mode: 0o600 });
    return summary;
  } finally { fs.closeSync(lockFd); fs.unlinkSync(lock); }
}

function renderReview(summary: ShadowSummary, journal: JournalRow[]): string {
  const clean = (value: unknown): string => String(value).replace(/[\r\n|<>`]/g, " ");
  const lines = ["# Jev evidence review", "", `Mode: ${summary.mode}. Research only; no trade probability, entry qualification or order authorization.`, "",
    `Started: ${new Date(summary.startedAt).toISOString()}. Model: ${summary.model}. Questions: ${summary.promptVersion}.`,
    `Requests: ${summary.attempted}; successful: ${summary.succeeded}; cached: ${summary.cached}; unresolved: ${summary.unresolved}; invalid: ${summary.invalid}; deferred: ${summary.deferred}.`,
    "", "These are model interpretations of source claims. Headline classifications do not independently verify the article or business event.", ""];
  const reservations = new Map(journal.filter(r => r.type === "reserved").map(r => [r.attemptId, r]));
  for (const row of journal.filter(r => r.type === "result" && r.runId === summary.runId)) {
    const reservation = reservations.get(row.attemptId)!;
    const event = reservation.eventSnapshot as NewsEvent;
    const response = row.response as JevResponse;
    const publicationLabel = event.contentNote?.includes("DATE_ONLY_WITH_CONSERVATIVE_UPPER_BOUND")
      ? "Stored publication upper bound (not a source clock)" : "Published";
    lines.push(`## ${clean(event.symbols.join(", "))}: ${clean(event.title)}`, "",
      `${publicationLabel}: ${new Date(event.publishedAt).toISOString()}; evidence observed: ${new Date(Number(reservation.observedAt)).toISOString()}; evaluated: ${new Date(Number(row.at)).toISOString()}.`,
      ...(event.contentNote ? [`Source timing/provenance note: ${clean(event.contentNote)}`] : []),
      `Source: ${clean(event.url)}`, "", "| Question | Selected label | Model probability of that label |", "|---|---|---|");
    for (const [id, answer] of Object.entries(response.answers)) lines.push(`| ${clean(id)} | ${clean(answer.choice)} | ${answer.probabilities[answer.choice].toFixed(4)} |`);
    lines.push("", "Probabilities describe semantic labels; domain calibration and future trading performance remain unverified.", "");
  }
  if (!summary.succeeded) lines.push("No new successful classifications in this run. Prior classifications retain their original journal timestamps.", "");
  return lines.join("\n");
}

export function syntheticEvent(now: number): NewsEvent {
  return { schemaVersion: 1, id: "synthetic:conditional-contract", revision: 1, contentHash: "synthetic-v1",
    source: "yahoo", sourceId: "fixture-only", symbols: ["EXAMPLE"], title: "SYNTHETIC: ExampleCo proposes a supply agreement, subject to customer approval.",
    url: "https://example.com/synthetic-not-a-market-source", publisher: "OFFLINE FIXTURE", publishedAt: now - 60000,
    fetchedAt: now - 1000, firstSeenAt: now - 1000, kind: "headline", claimStatus: "reported", relevance: "explicit-symbol" };
}
