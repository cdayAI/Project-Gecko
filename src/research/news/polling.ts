import { setTimeout as delay } from "node:timers/promises";
import { NewsLedger } from "./ledger.js";
import { validateRequest } from "./normalize.js";
import { ingestOnce } from "./pipeline.js";
import type { NewsProvider, NewsRequest, NewsSource } from "./types.js";

export interface NewsPollPolicy {
  readonly watch: boolean;
  readonly intervalMs: number;
  readonly maxCycles: number | null;
  readonly maxRequests: number | null;
}

export interface NewsPollSummary {
  readonly reason: "completed" | "request-budget-exhausted" | "interrupted" | "source-failed";
  readonly cycles: number;
  readonly requestsReserved: number;
  readonly reportedRequests: number;
}

export interface NewsPollHooks {
  readonly signal?: AbortSignal;
  readonly clock?: () => number;
  readonly wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly onCycle?: (result: Awaited<ReturnType<typeof ingestOnce>>, summary: NewsPollSummary) => void | Promise<void>;
}

function positiveInteger(value: string | undefined): number | null {
  if (value === undefined) return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error("News polling bounds must be positive safe integers");
  return number;
}

export function parsePollPolicy(options: ReadonlyMap<string, string>, source: NewsSource): NewsPollPolicy {
  const watch = options.has("watch");
  if (watch && options.has("once")) throw new Error("Choose either --watch or --once");
  const intervalMs = positiveInteger(options.get("interval-ms")) ?? 60_000;
  if (intervalMs < 60_000 || intervalMs > 2_147_483_647) throw new Error("News polling interval must be 60000-2147483647 ms");
  const cycles = positiveInteger(options.get("cycles"));
  if (!watch && cycles !== null && cycles !== 1) throw new Error("Repeated news cycles require explicit --watch");
  const maxRequests = positiveInteger(options.get("max-requests"));
  if (watch && (source === "x" || source === "benzinga") && cycles === null && maxRequests === null) throw new Error("Paid news polling requires explicit --cycles or --max-requests");
  return { watch, intervalMs, maxCycles: watch ? cycles : 1, maxRequests };
}

async function wait(ms: number, signal?: AbortSignal): Promise<void> {
  try { await delay(ms, undefined, { signal }); }
  catch { if (!signal?.aborted) throw new Error("News polling wait failed"); }
}

export async function runNewsPolling(provider: NewsProvider, input: Omit<NewsRequest, "now" | "signal">, ledger: NewsLedger,
  policy: NewsPollPolicy, hooks: NewsPollHooks = {}): Promise<NewsPollSummary> {
  const clock = hooks.clock ?? Date.now;
  validateRequest({ ...input, now: clock() });
  if (!Number.isSafeInteger(policy.intervalMs) || policy.intervalMs < 60_000 || policy.intervalMs > 2_147_483_647
    || (policy.maxCycles !== null && (!Number.isSafeInteger(policy.maxCycles) || policy.maxCycles <= 0))
    || (policy.maxRequests !== null && (!Number.isSafeInteger(policy.maxRequests) || policy.maxRequests <= 0))
    || (!policy.watch && policy.maxCycles !== 1)
    || (policy.watch && (provider.source === "x" || provider.source === "benzinga") && policy.maxCycles === null && policy.maxRequests === null)) throw new Error("Invalid or unbounded paid news polling policy");
  // Capture a fixed upper bound once. A cycle reserves it before touching the network.
  // Reservations never decrease, even after a partial read, missing auth or an exception.
  const requestCost = provider.source === "x" || provider.source === "benzinga" ? 1 : input.symbols.length;
  let cycles = 0, requestsReserved = 0, reportedRequests = 0;
  let reason: NewsPollSummary["reason"] = "completed";
  try {
    while (policy.maxCycles === null || cycles < policy.maxCycles) {
      if (hooks.signal?.aborted) { reason = "interrupted"; break; }
      if (policy.maxRequests !== null && requestCost > policy.maxRequests - requestsReserved) { reason = "request-budget-exhausted"; break; }
      requestsReserved += requestCost;
      const result = await ingestOnce(provider, { ...input, now: clock(), signal: hooks.signal }, ledger, clock);
      cycles++;
      reportedRequests += result.health.requests;
      if (!Number.isInteger(result.health.requests) || result.health.requests < 0 || result.health.requests > requestCost) throw new Error("News provider exceeded its declared request bound");
      await hooks.onCycle?.(result, { reason, cycles, requestsReserved, reportedRequests });
      if (hooks.signal?.aborted) { reason = "interrupted"; break; }
      if (result.health.status !== "ok" && result.health.status !== "partial") { reason = "source-failed"; break; }
      if (!policy.watch || (policy.maxCycles !== null && cycles >= policy.maxCycles)) break;
      if (policy.maxRequests !== null && requestCost > policy.maxRequests - requestsReserved) { reason = "request-budget-exhausted"; break; }
      await (hooks.wait ?? wait)(policy.intervalMs, hooks.signal);
    }
  } catch {
    reason = hooks.signal?.aborted ? "interrupted" : "source-failed";
    ledger.appendHealth({ source: provider.source, checkedAt: clock(), status: "error", requests: 0, receivedCount: 0,
      acceptedCount: 0, appendedCount: 0, duplicateCount: 0, rejectedCount: 0,
      notes: ["News polling stopped after a provider, persistence or consumer failure; no automatic retry."], coverage: "bounded-poll", latency: "unknown" });
  } finally {
    if (policy.watch && reason !== "source-failed") {
      ledger.appendHealth({ source: provider.source, checkedAt: clock(), status: "unavailable", requests: 0, receivedCount: 0,
        acceptedCount: 0, appendedCount: 0, duplicateCount: 0, rejectedCount: 0,
        notes: [`News collector stopped (${reason}); ${cycles} completed cycles, ${requestsReserved} request reservations. Previous events retain their original timestamps.`], coverage: "bounded-poll", latency: "unknown" });
    }
  }
  return { reason, cycles, requestsReserved, reportedRequests };
}
