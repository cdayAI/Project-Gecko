import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createLogger } from "../../core/logger.js";
import { BenzingaNewsProvider, parseBenzinga } from "./benzinga.js";
import { getJson, NewsHttpError } from "./http.js";
import { NewsLedger } from "./ledger.js";
import { canonicalUrl, claimStatus, publicationTime, relevantSymbols, validItem } from "./normalize.js";
import { ingestOnce } from "./pipeline.js";
import { parseNewsCliArgs } from "./news-cli.js";
import { parsePollPolicy, runNewsPolling } from "./polling.js";
import { parseSecSubmissions, SecNewsProvider } from "./sec.js";
import { parseXRecent, XNewsProvider } from "./x.js";
import { YahooNewsProvider } from "./yahoo.js";
import type { NewsFetch, NewsItem, NewsProvider, NewsRequest } from "./types.js";

const log = createLogger("news-selftest");
const now = Date.parse("2026-09-17T17:00:00Z");
const request: NewsRequest = { symbols: ["TSLA", "NVDA"], now, maxAgeMs: 3_600_000, limitPerSymbol: 20, aliases: { TSLA: ["Tesla"], NVDA: ["Nvidia"] } };
const base: NewsItem = { source: "yahoo", sourceId: "fixture-1", symbols: ["TSLA"], title: "Tesla announces an investor update",
  url: "https://example.com/article?utm_source=fixture", publisher: "Fixture News", publishedAt: now - 10_000,
  fetchedAt: now, kind: "headline", claimStatus: "reported", relevance: "configured-alias" };

async function main(): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gecko-news-"));
  let checks = 0;
  const check = (condition: unknown, message: string): void => { assert.ok(condition, message); checks++; };
  try {
    check(canonicalUrl(base.url) === "https://example.com/article", "tracking URL canonicalization");
    check(canonicalUrl("javascript:alert(1)") === null && canonicalUrl("https://user:secret@example.com") === null, "reject unsafe attribution URLs");
    check(publicationTime("2026-09-17T12:00:00") === null, "ambiguous timestamp cannot acquire local timezone");
    check(publicationTime("Thu, 17 Sep 2026 12:00:00 -0400") === now - 3_600_000, "explicit offset timestamp");
    check(relevantSymbols("Tesla update and $NVDA", request).symbols.length === 2, "explicit and configured-alias relevance");
    check(relevantSymbols("Broad markets update", request).symbols.length === 0, "search result is not proof of ticker relevance");
    check(claimStatus("Unconfirmed TSLA report") === "rumor" && claimStatus("$TSLA looks good", true) === "commentary", "social text is not promoted to fact");
    check(!validItem({ ...base, publishedAt: now - 3_600_001 }, request) && !validItem({ ...base, publishedAt: now + 60_001 }, request), "stale and future rejection");
    const ledger = new NewsLedger(directory);
    const first = ledger.append([base], now);
    check(first.events.length === 1 && first.events[0].firstSeenAt === now, "first observation persisted");
    check(ledger.append([{ ...base, fetchedAt: now + 1000 }], now + 1000).events.length === 0, "repeat read deduplicates without rewriting first-seen time");
    const changed = ledger.append([{ ...base, title: "Tesla corrects its investor update", fetchedAt: now + 2000 }], now + 2000);
    check(changed.events[0].revision === 2 && changed.events[0].firstSeenAt === now, "same source ID keeps revision history");
    const otherSource = ledger.append([{ ...base, source: "benzinga", sourceId: "77", fetchedAt: now + 3000 }], now + 3000);
    check(otherSource.events[0].duplicateOf === first.events[0].id, "same canonical URL is not independent corroboration");
    check(new NewsLedger(directory).readEvents().length === 1 && ledger.readEvents({ includeDuplicates: true }).length === 2, "restart read keeps latest revision and dedup view");
    check(ledger.readEvents({ symbols: ["NVDA"] }).length === 0 && ledger.readEvents({ since: now + 1500 }).length === 1, "monitor filters work on saved revisions");
    check(ledger.readEvents({ now: now + 1000 })[0].revision === 1 && ledger.readEvents({ now: now + 2500 })[0].revision === 2, "replay folds only revisions received by the requested time");
    check(ledger.readEvents({ now: now - 1 }).length === 0, "replay cannot see events before their first observation");
    ledger.append([{ ...base, sourceId: "future-receipt", url: "https://example.com/future", fetchedAt: now + 30_000 }], now + 30_000);
    check(!ledger.readEvents({ now: now + 29_999 }).some((event) => event.sourceId === "future-receipt"), "future first-seen event excluded from historical read");
    const yahoo = await new YahooNewsProvider(async () => [{ title: "Tesla update", publisher: "Fixture", publishedAt: now - 5, url: "https://example.com/yahoo" }, { title: "Unrelated ticker", publisher: "Fixture", publishedAt: now - 5, url: "https://example.com/unrelated" }]).poll({ ...request, symbols: ["TSLA"] });
    check(yahoo.items.length === 1 && yahoo.rejectedCount === 1 && yahoo.items[0].publisher === "Fixture", "Yahoo reuse retains source and rejects unrelated row");
    const secFixture = { cik: 1318605, name: "Tesla, Inc.", tickers: ["TSLA"], filings: { recent: { accessionNumber: ["0001318605-26-000001"], form: ["8-K"], primaryDocument: ["filing.htm"], acceptanceDateTime: ["2026-09-17T16:55:00Z"] } } };
    const sec = parseSecSubmissions(secFixture, "TSLA", "0001318605", now, ["8-K"], 20);
    check(sec.items.length === 1 && sec.items[0].claimStatus === "filing-notice" && sec.items[0].url.includes("/1318605/000131860526000001/filing.htm"), "SEC issuer link and limited factual claim");
    assert.throws(() => parseSecSubmissions(secFixture, "NVDA", "0001318605", now, ["8-K"], 20)); checks++;
    const xFixture = { data: [{ id: "123456789", text: "$TSLA unconfirmed news", created_at: "2026-09-17T16:59:00Z", author_id: "42" }], includes: { users: [{ id: "42", username: "fixture_user" }] }, meta: { next_token: "bounded-page" } };
    const x = parseXRecent(xFixture, request);
    check(x.items[0].author === "fixture_user" && x.items[0].claimStatus === "rumor" && x.partial, "X attribution and partial-page reporting");
    const benzinga = parseBenzinga([{ id: 55, created: "Thu, 17 Sep 2026 12:59:00 -0400", updated: "Thu, 17 Sep 2026 12:59:30 -0400", title: "Company update", url: "https://www.benzinga.com/fixture", stocks: [{ name: "TSLA" }], author: "Fixture" }], request);
    check(benzinga.items.length === 1 && benzinga.items[0].sourceUpdatedAt === now - 30_000, "Benzinga source ticker and revision time");
    let networkCalls = 0;
    const neverFetch: NewsFetch = async () => { networkCalls++; throw new Error("No network allowed in fixture"); };
    const noX = await new XNewsProvider({ bearerToken: "" }, neverFetch).poll(request);
    const noBenzinga = await new BenzingaNewsProvider("", neverFetch).poll(request);
    const noSec = await new SecNewsProvider({ userAgent: "", cikBySymbol: {} }, neverFetch).poll(request);
    check(noX.status === "auth-required" && noBenzinga.status === "auth-required" && noSec.status === "misconfigured" && networkCalls === 0, "missing access is explicit and sends no request");
    let capturedXUrl = "";
    const fixtureFetch: NewsFetch = async (url, init) => { capturedXUrl = url; check(init.method === "GET", "X adapter is read-only"); return new Response(JSON.stringify(xFixture)); };
    const xRead = await new XNewsProvider({ bearerToken: "fixture-token", authors: ["fixture_user"] }, fixtureFetch).poll(request);
    check(xRead.status === "partial" && new URL(capturedXUrl).searchParams.has("post.fields") && !capturedXUrl.includes("fixture-token"), "X documented fields and token in header only");
    await new XNewsProvider({ bearerToken: "fixture-token", fieldSelector: "tweet.fields" }, fixtureFetch).poll(request);
    check(new URL(capturedXUrl).searchParams.has("tweet.fields") && !new URL(capturedXUrl).searchParams.has("post.fields"), "documented alternate X fields are explicit, never retried automatically");
    const longQuery = await new XNewsProvider({ bearerToken: "fixture-token", authors: Array.from({ length: 20 }, (_, i) => `accountname${i}`) }, neverFetch).poll({ ...request, symbols: Array.from({ length: 20 }, (_, i) => `SYMBOL${i}`) });
    check(longQuery.status === "misconfigured" && networkCalls === 0, "oversized X query cannot issue a paid request");
    const badResponse: NewsFetch = async () => new Response("sensitive-provider-body", { status: 429 });
    try { await getJson("https://example.com/?token=fixture-token", {}, badResponse); assert.fail("expected rate limit"); }
    catch (error) { check(error instanceof NewsHttpError && error.status === "rate-limited" && !error.message.includes("token") && !error.message.includes("sensitive"), "errors redact credentials and bodies"); }
    const fixtureProvider: NewsProvider = { source: "yahoo", poll: async () => ({ items: [{ ...base, sourceId: "new", url: "https://example.com/new" }, { ...base, sourceId: "old", publishedAt: now - 4_000_000 }], status: "ok", requests: 1, receivedCount: 2, rejectedCount: 0, notes: [] }) };
    const ingested = await ingestOnce(fixtureProvider, request, ledger, () => now + 5000);
    check(ingested.health.acceptedCount === 1 && ingested.health.rejectedCount === 1 && ledger.readHealth()[0].latency === "unknown", "pipeline records source health and filters old news");
    check(ingested.events[0].fetchedAt === now + 5000 && ingested.events[0].firstSeenAt === now + 5000 && ingested.health.checkedAt === now + 5000, "receipt and first-seen use observed completion rather than request start");
    check(ledger.readHealth(now + 4999).length === 0, "historical health read excludes future poll status");
    check(parsePollPolicy(parseNewsCliArgs([]), "yahoo").maxCycles === 1, "default CLI policy does one read only");
    assert.throws(() => parsePollPolicy(parseNewsCliArgs(["--watch"]), "x")); checks++;
    assert.throws(() => parsePollPolicy(parseNewsCliArgs(["--watch", "--cycles", "0"]), "benzinga")); checks++;
    assert.throws(() => parsePollPolicy(parseNewsCliArgs(["--watch", "--interval-ms", "59999"]), "yahoo")); checks++;
    assert.throws(() => parsePollPolicy(parseNewsCliArgs(["--watch", "--interval-ms", "2147483648"]), "yahoo")); checks++;
    assert.throws(() => parsePollPolicy(parseNewsCliArgs(["--watch", "--once"]), "sec")); checks++;
    try { parseNewsCliArgs(["--token-fixture-secret", "fixture-secret"]); assert.fail("unknown flag accepted"); }
    catch (error) { check(error instanceof Error && !error.message.includes("fixture-secret"), "CLI parse errors never echo supplied secrets"); }
    check(parsePollPolicy(parseNewsCliArgs(["--watch", "--max-requests", "3"]), "x").maxRequests === 3, "paid watch can be bounded by requests");
    let active = 0, maxActive = 0, polls = 0, waits = 0;
    const reservations: number[] = [];
    const pollingProvider: NewsProvider = { source: "x", poll: async () => {
      active++; maxActive = Math.max(maxActive, active); await Promise.resolve(); active--; polls++;
      return { items: [], status: "ok", requests: 1, receivedCount: 0, rejectedCount: 0, notes: [] };
    } };
    const pollLedger = new NewsLedger(path.join(directory, "polling"));
    const summary = await runNewsPolling(pollingProvider, request, pollLedger, { watch: true, intervalMs: 60_000, maxCycles: null, maxRequests: 3 },
      { clock: () => now, wait: async (ms) => { assert.equal(ms, 60_000); waits++; }, onCycle: (_result, cycle) => { reservations.push(cycle.requestsReserved); } });
    check(summary.reason === "request-budget-exhausted" && polls === 3 && waits === 2 && maxActive === 1, "paid polling does not overlap or exceed its request cap");
    check(reservations.join(",") === "1,2,3" && summary.reportedRequests === 3, "request reservations are monotonic from the initial fixed cost");
    check(pollLedger.readHealth(now)[0].status === "unavailable", "stopped collector writes durable unavailable status");
    const smallBudget = await runNewsPolling({ ...pollingProvider, source: "yahoo" }, request, pollLedger,
      { watch: true, intervalMs: 60_000, maxCycles: 5, maxRequests: 1 }, { clock: () => now });
    check(smallBudget.cycles === 0 && polls === 3, "a multi-symbol poll cannot overshoot a smaller remaining request budget");
    const stopController = new AbortController();
    const stopped = await runNewsPolling(pollingProvider, request, pollLedger, { watch: true, intervalMs: 60_000, maxCycles: 10, maxRequests: 10 },
      { signal: stopController.signal, clock: () => now, wait: async () => { stopController.abort(); } });
    check(stopped.reason === "interrupted" && stopped.cycles === 1, "shutdown during the wait prevents another poll");
    let failingCalls = 0;
    const failingProvider: NewsProvider = { source: "benzinga", poll: async () => { failingCalls++; throw new Error("fixture-secret-provider-url"); } };
    const failedRun = await runNewsPolling(failingProvider, request, pollLedger, { watch: true, intervalMs: 60_000, maxCycles: 10, maxRequests: 10 }, { clock: () => now });
    check(failedRun.reason === "source-failed" && failingCalls === 1 && !JSON.stringify(pollLedger.readHealth(now)).includes("fixture-secret"), "provider failures persist sanitized health and are not retried");
    const aborted = new AbortController(); aborted.abort();
    const beforeAbortCalls = networkCalls;
    await new XNewsProvider({ bearerToken: "fixture-token" }, neverFetch).poll({ ...request, signal: aborted.signal });
    check(networkCalls === beforeAbortCalls, "pre-aborted paid provider sends no request");
    const inflight = new AbortController();
    const pendingFetch: NewsFetch = async (_url, init) => new Promise((_resolve, reject) => { init.signal?.addEventListener("abort", () => reject(new Error("fixture abort")), { once: true }); inflight.abort(); });
    await assert.rejects(getJson("https://example.com/fixture", {}, pendingFetch, 10_000, inflight.signal), NewsHttpError); checks++;
    fs.writeFileSync(path.join(directory, ".write.lock"), "fixture");
    assert.throws(() => ledger.append([base])); checks++;
    fs.unlinkSync(path.join(directory, ".write.lock"));
    fs.appendFileSync(ledger.eventsPath, "{broken\n");
    assert.throws(() => ledger.readEvents()); checks++;
    log.info("News deterministic selftests passed", { checks, networkRequests: 0, llmRequests: 0 });
  } finally {
    const resolved = path.resolve(directory), prefix = path.join(path.resolve(os.tmpdir()), "gecko-news-");
    assert.ok(resolved.startsWith(prefix) && path.dirname(resolved) === path.resolve(os.tmpdir()), "temporary cleanup stays inside the intended test directory");
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => { log.error("News selftest failed", { error: error instanceof Error ? error.message : "unknown failure" }); process.exitCode = 1; });
