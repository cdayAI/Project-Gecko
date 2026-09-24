import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { JevClient, JEV_MODEL, JevError, type JevRequest, type JevResponse } from "./client.js";
import { buildRequest, requestKey, type EvidenceContext } from "./questions.js";
import { runShadow, readJournal, syntheticEvent } from "./shadow.js";
import { main, parseArgs } from "./jev-cli.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gecko-jev-shadow-"));
let checks = 0;
async function test(name: string, action: () => void | Promise<void>): Promise<void> {
  await action(); checks++; console.log(`PASS ${name}`);
}
const now = Date.now();
const event = syntheticEvent(now);
let serial = 0;
function setup(events = [event]) {
  const base = path.join(root, String(++serial)), newsDirectory = path.join(base, "news"), directory = path.join(base, "jev");
  fs.mkdirSync(newsDirectory, { recursive: true });
  fs.writeFileSync(path.join(newsDirectory, "events.jsonl"), events.map(e => JSON.stringify(e)).join("\n") + "\n");
  return { newsDirectory, directory, now, maxAgeMs: 86400000, maxEvents: 20, maxRequests: 2 };
}
function result(request: JevRequest): JevResponse {
  return { model: JEV_MODEL, answers: Object.fromEntries(Object.entries(request.questions).map(([id, q]) => {
    const choice = Object.hasOwn(q.criteria, "unknown") ? "unknown" : Object.keys(q.criteria)[0];
    return [id, { type: "choice" as const, choice, confidence: 1, probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, k === choice ? 1 : 0])) }];
  })), usage: { input_tokens: 100, output_tokens: 60 } };
}
const mock = { evaluate: async (request: JevRequest) => result(request) };
try {
  await test("live requires an explicit request allowance", () => {
    assert.throws(() => parseArgs(["--live"])); assert.throws(() => parseArgs(["--live", "--demo", "--max-requests", "1"]));
    assert.throws(() => parseArgs(["--probe"])); assert.throws(() => parseArgs(["--probe", "--max-requests", "2"]));
    assert.throws(() => parseArgs(["--api-key", "sentinel"])); assert.equal(parseArgs([]).size, 0);
  });
  await test("future and reversed evidence chronology rejected", () => {
    assert.throws(() => buildRequest({ ...event, fetchedAt: now + 1 }, now));
    assert.throws(() => buildRequest({ ...event, firstSeenAt: now, fetchedAt: now - 1 }, now));
    assert.throws(() => buildRequest({ ...event, sourceUpdatedAt: now + 1 }, now));
  });
  await test("headlines never silently become article bodies", () => {
    const state = buildRequest(event, now).state as { evidence: { scope: string; text: null }; thesis: null };
    assert.equal(state.evidence.scope, "headline_only"); assert.equal(state.evidence.text, null); assert.equal(state.thesis, null);
  });
  await test("curated issuer intake retains its actual source channel", async () => {
    const options = setup([{ ...event, source: "primary" as const }]);
    await runShadow(mock, options);
    const row = readJournal(options.directory)[0];
    assert.equal((row.eventSnapshot as { source: string }).source, "primary");
    assert.equal(((row.request as JevRequest).state as { evidence: { source: string } }).evidence.source, "primary");
  });
  await test("date-only source upper bounds cannot render as exact publication clocks", async () => {
    const options = setup([{ ...event, contentNote: "SOURCE_PUBLICATION_DATE=2026-09-18; precision=DATE_ONLY_WITH_CONSERVATIVE_UPPER_BOUND" }]);
    const summary = await runShadow(mock, options);
    const rendered = fs.readFileSync(path.join(options.directory, `review-${summary.runId}.md`), "utf8");
    assert.ok(rendered.includes("Stored publication upper bound (not a source clock)"));
    assert.ok(rendered.includes("SOURCE_PUBLICATION_DATE=2026-09-18"));
    assert.ok(!rendered.includes("Published:"));
  });
  await test("unanimous semantic support cannot qualify a trade or supply a win probability", async () => {
    const options = setup();
    await runShadow({ evaluate: async request => {
      const response = result(request);
      response.answers.thesis_relation = { type: "choice", choice: "supports", confidence: 1,
        probabilities: { supports: 1, contradicts: 0, mixed: 0, unrelated: 0, unknown: 0 } };
      return response;
    } }, options);
    const row = readJournal(options.directory).find(item => item.type === "result")!;
    assert.equal(row.orderEligible, false); assert.equal(row.tradeWinProbability, null);
    assert.equal(row.status, "RESEARCH_ONLY");
  });
  await test("attributed excerpts bind to source and observation time", () => {
    const context: EvidenceContext = { eventId: event.id, sourceUrl: event.url, observedAt: now - 500, text: "A synthetic excerpt.", scope: "primary_excerpt" };
    assert.doesNotThrow(() => buildRequest(event, now, context));
    assert.throws(() => buildRequest(event, now, { ...context, sourceUrl: "https://other.example" }));
    assert.throws(() => buildRequest(event, now, { ...context, observedAt: now + 1 }));
    assert.notEqual(requestKey(event, buildRequest(event, now)), requestKey(event, buildRequest(event, now, context), context));
  });
  await test("unchanged evidence does not incur another request", async () => {
    const options = setup(); let calls = 0;
    const evaluator = { evaluate: async (r: JevRequest) => { calls++; return result(r); } };
    const first = await runShadow(evaluator, options), second = await runShadow(evaluator, options);
    assert.equal(first.succeeded, 1); assert.equal(second.cached, 1); assert.equal(calls, 1);
    const rows = readJournal(options.directory); assert.equal(rows.length, 2);
    assert.equal(rows[1].orderEligible, false); assert.equal(rows[1].tradeWinProbability, null);
  });
  await test("reserve is durable before transport and count cap is enforced", async () => {
    const options = setup([event, { ...event, id: "synthetic:second", contentHash: "second" }]);
    const summary = await runShadow({ evaluate: async r => { assert.equal(readJournal(options.directory)[0].type, "reserved"); return result(r); } }, { ...options, maxRequests: 1 });
    assert.equal(summary.attempted, 1); assert.equal(summary.deferred, 1);
  });
  await test("cached front page does not starve remaining events", async () => {
    const options = { ...setup([event, { ...event, id: "synthetic:second", contentHash: "second" }]), maxEvents: 1 };
    assert.equal((await runShadow(mock, options)).succeeded, 1);
    const second = await runShadow(mock, options); assert.equal(second.cached, 1); assert.equal(second.succeeded, 1);
  });
  await test("uncertain timeouts stop and cannot be blindly retried", async () => {
    const options = setup();
    const first = await runShadow({ evaluate: async () => { throw new Error("sentinel-secret-provider-text"); } }, options);
    assert.equal(first.stoppedReason, "provider-error-no-automatic-retry");
    const second = await runShadow(mock, options); assert.equal(second.unresolved, 1); assert.equal(second.attempted, 0);
    assert.ok(!fs.readFileSync(path.join(options.directory, "evaluations.jsonl"), "utf8").includes("sentinel-secret"));
  });
  await test("missing completion after process crash requires review", async () => {
    const options = setup(); await runShadow(mock, options);
    const file = path.join(options.directory, "evaluations.jsonl");
    fs.writeFileSync(file, JSON.stringify(readJournal(options.directory)[0]) + "\n");
    assert.equal((await runShadow(mock, options)).unresolved, 1);
  });
  await test("HTTP failure halts batch without automatic retries", async () => {
    const options = setup([event, { ...event, id: "synthetic:second" }]); let calls = 0;
    const client = new JevClient("synthetic-not-a-key", async () => { calls++; return new Response("do-not-log-this", { status: 429 }); });
    const summary = await runShadow(client, options);
    assert.equal(calls, 1); assert.equal(summary.deferred, 1); assert.equal(summary.succeeded, 0);
  });
  await test("stale news is excluded before spending", async () => {
    const options = setup([{ ...event, publishedAt: now - 2 * 86400000 }]);
    const summary = await runShadow(mock, options); assert.equal(summary.scanned, 1); assert.equal(summary.eligible, 0); assert.equal(summary.attempted, 0);
  });
  await test("later revision is not substituted into earlier evidence", async () => {
    const options = setup([event, { ...event, revision: 2, title: "future revision", fetchedAt: now + 1000 }]);
    await runShadow(mock, options);
    assert.equal((readJournal(options.directory)[0].eventSnapshot as { title: string }).title, event.title);
  });
  await test("exclusive run lock and malformed journal fail closed", async () => {
    const options = setup(); fs.mkdirSync(options.directory); fs.writeFileSync(path.join(options.directory, ".run.lock"), "other writer");
    await assert.rejects(runShadow(mock, options)); fs.unlinkSync(path.join(options.directory, ".run.lock"));
    fs.writeFileSync(path.join(options.directory, "evaluations.jsonl"), "broken\n");
    await assert.rejects(runShadow(mock, options)); assert.ok(!fs.existsSync(path.join(options.directory, ".run.lock")));
  });
  await test("nonpositive and excessive caps are rejected", async () => {
    const options = setup(); await assert.rejects(runShadow(mock, { ...options, maxRequests: 0 }));
    await assert.rejects(runShadow(mock, { ...options, maxRequests: 1001 }));
  });
  await test("synthetic run remains distinctly labelled", async () => {
    const options = { ...setup(), synthetic: true };
    const summary = await runShadow(mock, options);
    assert.equal(summary.mode, "SYNTHETIC_OFFLINE"); assert.equal(summary.estimatedInputCostUsd, 0); assert.equal(summary.monitorActive, false);
    await assert.rejects(main(["--export", "--directory", options.directory, "--output", path.join(root, "fake-live.jsonl")]));
    assert.ok(!fs.existsSync(path.join(root, "fake-live.jsonl")));
  });
  await test("connection probe cannot become live market evidence", async () => {
    const options = { ...setup(), maxRequests: 1, probe: true };
    const summary = await runShadow(mock, options);
    assert.equal(summary.mode, "AUTHENTICATED_SYNTHETIC_PROBE");
    await assert.rejects(main(["--export", "--directory", options.directory, "--output", path.join(root, "fake-probe.jsonl")]));
    await assert.rejects(runShadow(mock, { ...options, maxRequests: 2 }));
  });
  console.log(`Jev shadow offline checks passed: ${checks}. No live inference or trading validated.`);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
