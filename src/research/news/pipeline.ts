import { NewsLedger } from "./ledger.js";
import { validItem, validateRequest } from "./normalize.js";
import type { NewsBatch, NewsEvent, NewsProvider, NewsRequest, SourceHealth } from "./types.js";

export async function ingestOnce(provider: NewsProvider, request: NewsRequest, ledger: NewsLedger, clock: () => number = Date.now): Promise<{ events: readonly NewsEvent[]; health: SourceHealth }> {
  validateRequest(request);
  let batch: NewsBatch;
  try { batch = await provider.poll(request); }
  catch {
    // Unexpected provider exceptions cannot reveal URLs, credentials or response bodies.
    // The request count is a conservative upper bound when a provider did not report it.
    batch = { items: [], status: "error", requests: provider.source === "x" || provider.source === "benzinga" ? 1 : request.symbols.length,
      receivedCount: 0, rejectedCount: 0, notes: ["Provider failed before reporting completion; request count is a conservative upper bound."] };
  }
  const receivedAt = clock();
  const receiptRequest = { ...request, now: receivedAt };
  validateRequest(receiptRequest);
  // fetchedAt is the observed receipt of this bounded batch, never a request-start guess.
  const receivedItems = batch.items.map((item) => ({ ...item, fetchedAt: receivedAt }));
  const eligible = receivedItems.filter((item) => item.source === provider.source && validItem(item, receiptRequest));
  let result: { events: NewsEvent[]; duplicateCount: number };
  try { result = ledger.append(eligible, receivedAt); }
  catch {
    // Persist the failure separately if the health ledger remains writable.
    ledger.appendHealth({ source: provider.source, checkedAt: receivedAt, status: "error", requests: batch.requests,
      receivedCount: batch.receivedCount, acceptedCount: eligible.length, appendedCount: 0, duplicateCount: 0,
      rejectedCount: batch.rejectedCount, notes: ["News event ledger persistence failed; do not use this poll as entry evidence."], coverage: "bounded-poll", latency: "unknown" });
    throw new Error("News ledger persistence failed");
  }
  const rejectedCount = batch.rejectedCount + batch.items.length - eligible.length;
  const health: SourceHealth = { source: provider.source, checkedAt: receivedAt, status: batch.status,
    requests: batch.requests, receivedCount: batch.receivedCount, acceptedCount: eligible.length,
    appendedCount: result.events.length, duplicateCount: result.duplicateCount, rejectedCount,
    notes: [...batch.notes, ...(batch.items.length > eligible.length ? ["Age, future-time, relevance, or attribution filters rejected rows."] : [])],
    coverage: "bounded-poll", latency: "unknown" };
  ledger.appendHealth(health);
  return { events: result.events, health };
}
