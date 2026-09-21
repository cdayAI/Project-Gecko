import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { JEV_MODEL, JevError, type JevRequest, type JevResponse } from "./client.js";
import { main, parseArgs } from "./jev-cli.js";
import { readJournal, syntheticEvent } from "./shadow.js";
import { runWatch, readWatchStatus, type WatchOptions } from "./watch.js";
import type { NewsEvent, SourceHealth } from "../news/types.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gecko-jev-watch-offline-"));
let serial = 0, checks = 0;
const initialTime = Date.now();
function response(request: JevRequest): JevResponse {
  return { model: JEV_MODEL, answers: Object.fromEntries(Object.entries(request.questions).map(([id, q]) => {
    const choice = Object.hasOwn(q.criteria, "unknown") ? "unknown" : Object.keys(q.criteria)[0];
    return [id, { type: "choice" as const, choice, confidence: 1, probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, Number(k === choice)])) }];
  })), usage: { input_tokens: 0, output_tokens: 0 } };
}
function fixture() {
  const base = path.join(root, String(++serial)), newsDirectory = path.join(base, "news"), directory = path.join(base, "watch");
  fs.mkdirSync(newsDirectory, { recursive: true });
  let time = initialTime, calls = 0;
  const event = syntheticEvent(time);
  const health: SourceHealth = { source: "yahoo", checkedAt: time, status: "ok", requests: 1, receivedCount: 1,
    acceptedCount: 1, appendedCount: 1, duplicateCount: 0, rejectedCount: 0, notes: ["OFFLINE TEST FIXTURE"], coverage: "bounded-poll", latency: "unknown" };
  const writeEvents = (events: NewsEvent[]) => fs.writeFileSync(path.join(newsDirectory, "events.jsonl"), events.map(e => JSON.stringify(e)).join("\n") + "\n");
  const writeHealth = (rows: SourceHealth[]) => fs.writeFileSync(path.join(newsDirectory, "health.jsonl"), rows.map(h => JSON.stringify(h)).join("\n") + "\n");
  writeEvents([event]); writeHealth([health]);
  const options: WatchOptions = { directory, newsDirectory, sources: ["yahoo"], maxRequests: 2, durationMs: 3000 };
  const runtime = { now: () => time, sleep: async (ms: number) => { time += ms; } };
  const evaluator = { evaluate: async (r: JevRequest) => { calls++; return response(r); } };
  return { options, runtime, evaluator, event, health, writeEvents, writeHealth, calls: () => calls, setTime: (next: number) => { time = next; } };
}
async function test(name: string, action: () => Promise<void> | void) { await action(); checks++; console.log(`PASS ${name}`); }
try {
  await test("watch requires explicit cap, duration, sources and dedicated directory", () => {
    for (const missing of ["max-requests", "duration-minutes", "sources", "directory"]) {
      const values = { "max-requests": "2", "duration-minutes": "1", sources: "yahoo", directory: "temporary" };
      const args = ["--watch", ...Object.entries(values).filter(([k]) => k !== missing).flatMap(([k, v]) => [`--${k}`, v])];
      assert.throws(() => parseArgs(args));
    }
    assert.throws(() => parseArgs(["--watch", "--live", "--max-requests", "1"]));
    assert.throws(() => parseArgs(["--status", "--duration-minutes", "1"]));
    assert.equal(parseArgs([]).size, 0);
  });
  await test("lifetime reservations survive restart and cannot be increased", async () => {
    const f = fixture(), options = { ...f.options, maxRequests: 1 };
    assert.equal((await runWatch(f.evaluator, options, f.runtime)).status, "BUDGET_EXHAUSTED");
    assert.equal((await runWatch(f.evaluator, options, f.runtime)).reservations, 1); assert.equal(f.calls(), 1);
    await assert.rejects(runWatch(f.evaluator, { ...options, maxRequests: 2 }, f.runtime));
    assert.equal(f.calls(), 1);
  });
  await test("restart cannot extend the original deadline", async () => {
    const f = fixture(); f.writeEvents([]);
    const first = await runWatch(f.evaluator, f.options, f.runtime);
    assert.equal(first.status, "EXPIRED");
    const second = await runWatch(f.evaluator, f.options, f.runtime);
    assert.equal(second.expiresAt, first.expiresAt); assert.equal(second.status, "EXPIRED"); assert.equal(f.calls(), 0);
  });
  await test("stale failed missing or unselected source cannot spend", async () => {
    for (const kind of ["missing", "stale", "failed", "future", "wrong-source"]) {
      const f = fixture();
      f.writeHealth(kind === "missing" ? [] : [{ ...f.health,
        ...(kind === "stale" ? { checkedAt: initialTime - 180001 } : {}), ...(kind === "failed" ? { status: "error" as const } : {}),
        ...(kind === "future" ? { checkedAt: initialTime + 100000 } : {}), ...(kind === "wrong-source" ? { source: "x" as const } : {}) }]);
      await runWatch(f.evaluator, f.options, f.runtime); assert.equal(f.calls(), 0, kind);
    }
  });
  await test("partial health is usable but stale and date-only publications are excluded", async () => {
    const f = fixture(); f.writeHealth([{ ...f.health, status: "partial" }]);
    f.writeEvents([{ ...f.event, id: "stale", publishedAt: initialTime - 300001 }, { ...f.event, id: "date-only", contentNote: "DATE_ONLY_WITH_CONSERVATIVE_UPPER_BOUND" }, f.event]);
    await runWatch(f.evaluator, f.options, f.runtime); assert.equal(f.calls(), 1);
  });
  await test("duplicates and cached revisions emit one alert and incur one request", async () => {
    const f = fixture(); f.writeEvents([f.event, { ...f.event, id: "syndicated", duplicateOf: f.event.id }]);
    await runWatch(f.evaluator, f.options, f.runtime); assert.equal(f.calls(), 1);
    const alerts = fs.readFileSync(path.join(f.options.directory, "alerts.jsonl"), "utf8").trim().split("\n");
    assert.equal(alerts.length, 1);
    const row = JSON.parse(alerts[0]); assert.equal(row.status, "RESEARCH_ONLY"); assert.equal(row.orderEligible, false);
    assert.ok(!Object.hasOwn(row, "tradeWinProbability")); assert.ok(!Object.hasOwn(row, "sentiment"));
    assert.equal(row.publishedAt, f.event.publishedAt); assert.equal(row.sourceLatencyCoverage, "unknown");
    assert.equal(row.evidenceScope, "headline_only"); assert.equal(row.sourceClaimVerified, false);
    assert.equal(fs.readdirSync(path.join(f.options.directory, "model")).filter(name => name.startsWith("run-")).length, 1);
  });
  await test("new revision gets a new reserved request and immutable alert", async () => {
    const f = fixture(); let changed = false;
    const runtime = { ...f.runtime, sleep: async (ms: number) => { await f.runtime.sleep(ms); if (!changed) { changed = true; f.writeEvents([f.event, { ...f.event, revision: 2, title: "SYNTHETIC changed evidence", contentHash: "changed-v2", fetchedAt: f.runtime.now() }]); } } };
    assert.equal((await runWatch(f.evaluator, f.options, runtime)).status, "BUDGET_EXHAUSTED"); assert.equal(f.calls(), 2);
    const alerts = fs.readFileSync(path.join(f.options.directory, "alerts.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(alerts.map(row => row.revision), [1, 2]); assert.notEqual(alerts[0].key, alerts[1].key);
  });
  await test("provider errors stop permanently without automatic retry even when charge is known absent", async () => {
    const f = fixture(); let calls = 0;
    const failed = { evaluate: async (): Promise<JevResponse> => { calls++; throw new JevError("HTTP_ERROR", 429); } };
    const result = await runWatch(failed, f.options, f.runtime); assert.equal(result.status, "REVIEW_REQUIRED");
    assert.equal((await runWatch(f.evaluator, f.options, f.runtime)).status, "REVIEW_REQUIRED"); assert.equal(calls, 1); assert.equal(f.calls(), 0);
  });
  await test("unfinished reservation blocks all later spending", async () => {
    const f = fixture(); await runWatch(f.evaluator, { ...f.options, maxRequests: 1 }, f.runtime);
    const directory = path.join(f.options.directory, "model"), reservation = readJournal(directory)[0];
    fs.writeFileSync(path.join(directory, "evaluations.jsonl"), JSON.stringify(reservation) + "\n");
    assert.equal((await runWatch(f.evaluator, { ...f.options, maxRequests: 1 }, f.runtime)).status, "REVIEW_REQUIRED"); assert.equal(f.calls(), 1);
  });
  await test("stop signal is observed before spending and after interrupted sleep", async () => {
    const f = fixture(), controller = new AbortController(); controller.abort();
    assert.equal((await runWatch(f.evaluator, { ...f.options, signal: controller.signal }, f.runtime)).status, "STOPPED"); assert.equal(f.calls(), 0);
    const g = fixture(), next = new AbortController(); g.writeEvents([]);
    assert.equal((await runWatch(g.evaluator, { ...g.options, signal: next.signal }, { ...g.runtime, sleep: async () => { next.abort(); } })).status, "STOPPED");
  });
  await test("worker lock and shadow lock reject concurrent owners", async () => {
    const f = fixture(); fs.mkdirSync(f.options.directory); fs.writeFileSync(path.join(f.options.directory, ".watch.lock"), "owner");
    await assert.rejects(runWatch(f.evaluator, f.options, f.runtime)); assert.equal(f.calls(), 0);
    assert.equal(fs.readFileSync(path.join(f.options.directory, ".watch.lock"), "utf8"), "owner");
    const g = fixture(); let locked = false;
    await assert.rejects(runWatch(g.evaluator, g.options, { ...g.runtime, now: () => {
      if (!locked && fs.existsSync(path.join(g.options.directory, "session.json"))) {
        fs.mkdirSync(path.join(g.options.directory, "model")); fs.writeFileSync(path.join(g.options.directory, "model", ".run.lock"), "owner"); locked = true;
      }
      return g.runtime.now();
    } })); assert.equal(g.calls(), 0);
  });
  await test("malformed session and mixed mode journal fail closed", async () => {
    const f = fixture(); fs.mkdirSync(f.options.directory); fs.writeFileSync(path.join(f.options.directory, "session.json"), "broken");
    await assert.rejects(runWatch(f.evaluator, f.options, f.runtime)); assert.equal(f.calls(), 0);
    const g = fixture(); await runWatch(g.evaluator, { ...g.options, maxRequests: 1 }, g.runtime);
    const file = path.join(g.options.directory, "model", "evaluations.jsonl");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replaceAll("LIVE_SHADOW", "SYNTHETIC_OFFLINE"));
    await assert.rejects(runWatch(g.evaluator, { ...g.options, maxRequests: 1 }, g.runtime)); assert.equal(g.calls(), 1);
  });
  await test("lost manifest cannot silently replenish a journal allowance", async () => {
    const f = fixture(); await runWatch(f.evaluator, f.options, f.runtime);
    fs.unlinkSync(path.join(f.options.directory, "session.json"));
    await assert.rejects(runWatch(f.evaluator, f.options, f.runtime)); assert.equal(f.calls(), 1);
  });
  await test("source health ages out while the foreground process remains alive", async () => {
    const f = fixture(); let changed = false;
    await runWatch(f.evaluator, { ...f.options, healthMaxAgeMs: 1000, durationMs: 4000 }, { ...f.runtime, sleep: async (ms: number) => {
      await f.runtime.sleep(ms); if (!changed && f.runtime.now() >= initialTime + 2000) { changed = true; f.writeEvents([{ ...f.event, revision: 2, contentHash: "must-not-spend", fetchedAt: f.runtime.now() }]); }
    } }); assert.equal(f.calls(), 1);
  });
  await test("recovered old results remain stale history and never become fresh alerts", async () => {
    const f = fixture(); await runWatch(f.evaluator, f.options, f.runtime);
    fs.unlinkSync(path.join(f.options.directory, "alerts.jsonl"));
    f.setTime(initialTime + 400000);
    const result = await runWatch(f.evaluator, f.options, f.runtime); assert.equal(result.status, "EXPIRED");
    const alert = JSON.parse(fs.readFileSync(path.join(f.options.directory, "alerts.jsonl"), "utf8"));
    assert.equal(alert.alertFreshness, "STALE_FOR_LIVE_REVIEW"); assert.equal(alert.sourceHealthyAtEmission, false);
    assert.equal(alert.emittedAt, initialTime + 400000); assert.equal(alert.publicationAgeMs, 460000); assert.equal(f.calls(), 1);
  });
  await test("status rejects missing process lock and stale heartbeat", async () => {
    const f = fixture(), controller = new AbortController(); f.writeEvents([]);
    await runWatch(f.evaluator, { ...f.options, durationMs: 60000, signal: controller.signal }, { ...f.runtime,
      onHeartbeat: heartbeat => {
        if (!heartbeat.monitorActive) return;
        assert.equal((readWatchStatus(f.options.directory, f.runtime.now()) as { monitorActive: boolean }).monitorActive, true);
        assert.equal((readWatchStatus(f.options.directory, f.runtime.now() + 16000) as { monitorActive: boolean }).monitorActive, false);
        controller.abort();
      } });
    assert.equal((readWatchStatus(f.options.directory, f.runtime.now()) as { monitorActive: boolean }).monitorActive, false);
  });
  await test("CLI top-level and nested watch status agree for active and stopped sessions", async () => {
    const f = fixture(), controller = new AbortController(); f.writeEvents([]);
    const captureStatus = async () => {
      const previous = console.log, messages: string[] = [];
      console.log = (...args: unknown[]) => { messages.push(args.map(String).join(" ")); };
      try { await main(["--status", "--directory", f.options.directory, "--news-directory", f.options.newsDirectory]); }
      finally { console.log = previous; }
      return JSON.parse(messages.join("\n")) as { monitorActive: boolean; watch: { monitorActive: boolean } };
    };
    await runWatch(f.evaluator, { ...f.options, durationMs: 60000, signal: controller.signal }, { ...f.runtime,
      sleep: async () => {
        const active = await captureStatus(); assert.equal(active.monitorActive, true); assert.equal(active.watch.monitorActive, true);
        controller.abort();
      } });
    const stopped = await captureStatus(); assert.equal(stopped.monitorActive, false); assert.equal(stopped.watch.monitorActive, false);
    assert.equal(f.calls(), 0);
  });
  console.log(`Jev watch offline checks passed: ${checks}. Synthetic fixtures only; no credentials, network, live worker or trading validation.`);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
