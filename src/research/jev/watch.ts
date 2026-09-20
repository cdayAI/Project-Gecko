import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { NewsLedger } from "../news/ledger.js";
import { record } from "../news/normalize.js";
import type { NewsEvent, NewsSource, SourceHealth } from "../news/types.js";
import { JEV_MODEL, type JevResponse } from "./client.js";
import { buildRequest, requestKey, PROMPT_VERSION } from "./questions.js";
import { readJournal, runShadow, type Evaluator } from "./shadow.js";

const SOURCES: readonly NewsSource[] = ["yahoo", "sec", "x", "benzinga", "primary"];
export interface WatchOptions {
  directory: string; newsDirectory: string; sources: readonly NewsSource[];
  maxRequests: number; durationMs: number; pollMs?: number; maxAgeMs?: number; healthMaxAgeMs?: number;
  signal?: AbortSignal;
}
interface Config {
  newsDirectory: string; sources: NewsSource[]; maxRequests: number; durationMs: number;
  pollMs: number; maxAgeMs: number; healthMaxAgeMs: number;
}
interface Session {
  schemaVersion: 1; mode: "LIVE_SHADOW_WATCH"; id: string; createdAt: number; expiresAt: number;
  model: string; promptVersion: string; config: Config;
}
export interface WatchHeartbeat {
  schemaVersion: 1; sessionId: string; observedAt: number; expiresAt: number;
  status: "STARTING" | "WAITING_FOR_HEALTH" | "WAITING_FOR_NEWS" | "RESEARCH_ALERT" | "STOPPED" | "EXPIRED" | "BUDGET_EXHAUSTED" | "REVIEW_REQUIRED" | "ERROR";
  monitorActive: boolean; ordersSupported: false; reservations: number; remainingRequests: number; completed: number;
  eligibleEvents: number; latestPublicationAgeMs: number | null;
  sourceHealth: { source: NewsSource; status: string; ageMs: number | null; usable: boolean }[];
  note: string;
}
export interface WatchRuntime {
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  onHeartbeat?: (heartbeat: WatchHeartbeat) => void;
}
function integer(value: number, min: number, max: number): boolean { return Number.isInteger(value) && value >= min && value <= max; }
function configFor(options: WatchOptions): Config {
  const config: Config = { newsDirectory: path.resolve(options.newsDirectory), sources: [...options.sources].sort(),
    maxRequests: options.maxRequests, durationMs: options.durationMs, pollMs: options.pollMs ?? 1000,
    maxAgeMs: options.maxAgeMs ?? 300000, healthMaxAgeMs: options.healthMaxAgeMs ?? 180000 };
  if (!integer(config.maxRequests, 1, 1000) || !integer(config.durationMs, 1000, 8 * 3600000)
    || !integer(config.pollMs, 1000, 60000) || !integer(config.maxAgeMs, 1000, 1800000)
    || !integer(config.healthMaxAgeMs, 1000, 600000) || !config.sources.length
    || new Set(config.sources).size !== config.sources.length || config.sources.some(s => !SOURCES.includes(s))) throw new Error("Invalid bounded watch configuration");
  return config;
}
function durableNew(file: string, value: unknown): void {
  const fd = fs.openSync(file, "wx", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function append(file: string, value: unknown): void {
  const fd = fs.openSync(file, "a", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function sessionFor(directory: string, config: Config, now: number): Session {
  const file = path.join(directory, "session.json");
  if (!fs.existsSync(file)) {
    // A lost manifest must not create a new allowance over an old journal or alerts.
    if (fs.readdirSync(directory).some(name => name !== ".watch.lock")) throw new Error("Watch needs a new empty directory or intact session");
    const session: Session = { schemaVersion: 1, mode: "LIVE_SHADOW_WATCH", id: randomUUID(), createdAt: now,
      expiresAt: now + config.durationMs, model: JEV_MODEL, promptVersion: PROMPT_VERSION, config };
    durableNew(file, session); return session;
  }
  if (fs.statSync(file).size > 20000) throw new Error("Invalid watch session");
  const row = record(JSON.parse(fs.readFileSync(file, "utf8")) as unknown);
  if (!row || row.schemaVersion !== 1 || row.mode !== "LIVE_SHADOW_WATCH" || typeof row.id !== "string"
    || !integer(Number(row.createdAt), 1, Number.MAX_SAFE_INTEGER) || typeof row.createdAt !== "number"
    || row.createdAt > now || row.expiresAt !== row.createdAt + config.durationMs
    || row.model !== JEV_MODEL || row.promptVersion !== PROMPT_VERSION || JSON.stringify(row.config) !== JSON.stringify(config)) throw new Error("Watch session changed, malformed or from another mode");
  return row as unknown as Session;
}
function journalState(directory: string): { reservations: number; completed: number; blocked: boolean } {
  const rows = readJournal(directory), attempts = new Map<string, string>(), seen = new Set<string>();
  let blocked = false;
  for (const row of rows) {
    if (row.mode !== "LIVE_SHADOW") throw new Error("Watch refuses synthetic or mixed mode journals");
    if (row.type === "reserved") {
      if (seen.has(row.attemptId)) throw new Error("Duplicate watch reservation");
      seen.add(row.attemptId);
      attempts.set(row.attemptId, row.key);
    } else {
      if (attempts.get(row.attemptId) !== row.key) throw new Error("Orphan or duplicate watch completion");
      attempts.delete(row.attemptId);
      if (row.type === "error") blocked = true;
    }
  }
  return { reservations: rows.filter(r => r.type === "reserved").length, completed: rows.filter(r => r.type === "result").length,
    blocked: blocked || attempts.size > 0 };
}
export function healthUsable(health: SourceHealth | undefined, now: number, maxAgeMs: number): boolean {
  return Boolean(health && (health.status === "ok" || health.status === "partial") && health.checkedAt <= now && now - health.checkedAt <= maxAgeMs);
}
export function eventUsable(event: NewsEvent, sources: readonly NewsSource[], health: readonly SourceHealth[], now: number, maxAgeMs: number, healthMaxAgeMs: number): boolean {
  return sources.includes(event.source) && !event.duplicateOf && event.publishedAt > 0 && event.publishedAt <= now
    && event.fetchedAt <= now && event.firstSeenAt <= now && now - event.publishedAt <= maxAgeMs
    && !event.contentNote?.includes("DATE_ONLY")
    && healthUsable(health.find(h => h.source === event.source), now, healthMaxAgeMs);
}
function emitAlerts(directory: string, modelDirectory: string, session: Session, now: number): number {
  const file = path.join(directory, "alerts.jsonl"), known = new Set<string>();
  if (fs.existsSync(file)) {
    if (fs.statSync(file).size > 50_000_000) throw new Error("Alert ledger exceeds bound");
    for (const line of fs.readFileSync(file, "utf8").split("\n").filter(s => s.trim())) {
      const row = record(JSON.parse(line) as unknown);
      if (!row || row.schemaVersion !== 1 || row.sessionId !== session.id || typeof row.key !== "string"
        || row.status !== "RESEARCH_ONLY" || known.has(row.key)) throw new Error("Invalid or duplicate alert ledger");
      known.add(row.key);
    }
  }
  const rows = readJournal(modelDirectory), reservations = new Map(rows.filter(r => r.type === "reserved").map(r => [r.attemptId, r]));
  const health = new NewsLedger(session.config.newsDirectory).readHealth(now);
  let added = 0;
  for (const row of rows.filter(r => r.type === "result" && !known.has(r.key))) {
    const reservation = reservations.get(row.attemptId), response = row.response as JevResponse;
    if (!reservation || !record(response?.answers) || row.status !== "RESEARCH_ONLY" || row.orderEligible !== false) throw new Error("Invalid research result");
    const event = reservation.eventSnapshot as NewsEvent;
    const fresh = now < session.expiresAt && eventUsable(event, session.config.sources, health, now, session.config.maxAgeMs, session.config.healthMaxAgeMs);
    // Labels only. A catalyst label supplies no sentiment, entry signal or trading probability.
    append(file, { schemaVersion: 1, sessionId: session.id, key: row.key, eventId: event.id, revision: event.revision,
      title: event.title, symbols: event.symbols, source: event.source, sourceUrl: event.url, claimStatus: event.claimStatus,
      publishedAt: event.publishedAt, firstSeenAt: event.firstSeenAt, fetchedAt: event.fetchedAt, evaluatedAt: row.at,
      emittedAt: now, publicationAgeMs: now - event.publishedAt,
      alertFreshness: fresh ? "FRESH_FOR_RESEARCH_REVIEW" : "STALE_FOR_LIVE_REVIEW",
      sourceHealthyAtEmission: healthUsable(health.find(item => item.source === event.source), now, session.config.healthMaxAgeMs),
      publicationToFetchMs: event.fetchedAt - event.publishedAt, fetchToEvaluationMs: Number(row.at) - event.fetchedAt,
      modelLatencyMs: row.latencyMs, sourceLatencyCoverage: "unknown", status: "RESEARCH_ONLY", orderEligible: false,
      evidenceScope: event.kind === "social-post" ? "social_commentary" : "headline_only", sourceClaimVerified: false, primaryEvidenceVerificationRequired: true,
      socialOrRumor: event.kind === "social-post" || event.claimStatus === "rumor" || event.claimStatus === "commentary",
      labels: Object.fromEntries(Object.entries(response.answers).map(([key, value]) => [key, value.choice])),
      note: "Source claim classification. Verify primary evidence, quotes and the independent trade plan before any manual decision." });
    known.add(row.key); if (fresh) added++;
  }
  return added;
}
function interruptibleSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve(); return; }
    const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, ms); signal?.addEventListener("abort", finish, { once: true });
  });
}

/** A heartbeat alone cannot prove liveness. Status additionally requires a live lock PID. */
export function readWatchStatus(directory: string, now = Date.now()): { monitorActive: boolean; [key: string]: unknown } | null {
  const sessionFile = path.join(directory, "session.json");
  if (!fs.existsSync(sessionFile)) return null;
  try {
    const session = JSON.parse(fs.readFileSync(sessionFile, "utf8")) as Session;
    const heartbeat = JSON.parse(fs.readFileSync(path.join(directory, "heartbeat.json"), "utf8")) as WatchHeartbeat;
    const ageMs = now - heartbeat.observedAt, staleAfterMs = Math.max(15000, session.config.pollMs * 3);
    let lockProcessObserved = false;
    if (fs.existsSync(path.join(directory, ".watch.lock"))) {
      const lock = record(JSON.parse(fs.readFileSync(path.join(directory, ".watch.lock"), "utf8")) as unknown);
      if (lock && typeof lock.pid === "number" && Number.isInteger(lock.pid) && lock.pid > 0) {
        try { process.kill(lock.pid, 0); lockProcessObserved = true; } catch { /* Process absent or inaccessible: fail closed. */ }
      }
    }
    const valid = session.schemaVersion === 1 && session.mode === "LIVE_SHADOW_WATCH" && heartbeat.schemaVersion === 1
      && heartbeat.sessionId === session.id && Number.isFinite(ageMs) && ageMs >= 0 && Number.isFinite(staleAfterMs);
    return { monitorActive: valid && heartbeat.monitorActive === true && ageMs <= staleAfterMs && now < session.expiresAt && lockProcessObserved,
      status: valid ? heartbeat.status : "INVALID_STATUS", heartbeatAgeMs: Number.isFinite(ageMs) ? ageMs : null,
      heartbeatStale: !valid || ageMs > staleAfterMs, lockProcessObserved, expiresAt: session.expiresAt,
      note: "Local process/heartbeat observation only; source freshness and trading readiness are separate." };
  } catch { return { monitorActive: false, status: "INVALID_OR_INCOMPLETE_STATUS" }; }
}

export async function runWatch(evaluator: Evaluator, options: WatchOptions, runtime: WatchRuntime = {}): Promise<WatchHeartbeat> {
  const config = configFor(options), now = runtime.now ?? Date.now, sleep = runtime.sleep ?? interruptibleSleep;
  const directory = path.resolve(options.directory), modelDirectory = path.join(directory, "model");
  fs.mkdirSync(directory, { recursive: true });
  const lock = path.join(directory, ".watch.lock"), fd = fs.openSync(lock, "wx", 0o600);
  let session: Session | undefined, heartbeat: WatchHeartbeat | undefined;
  const publish = (status: WatchHeartbeat["status"], active: boolean, note: string): WatchHeartbeat => {
    const time = now(), ledger = new NewsLedger(config.newsDirectory), health = ledger.readHealth(time), events = ledger.readEvents({ now: time });
    const state = journalState(modelDirectory);
    const eligible = events.filter(e => eventUsable(e, config.sources, health, time, config.maxAgeMs, config.healthMaxAgeMs));
    heartbeat = { schemaVersion: 1, sessionId: session!.id, observedAt: time, expiresAt: session!.expiresAt,
      status, monitorActive: active, ordersSupported: false, reservations: state.reservations, remainingRequests: Math.max(0, config.maxRequests - state.reservations),
      completed: state.completed, eligibleEvents: eligible.length, latestPublicationAgeMs: eligible.length ? time - eligible[0].publishedAt : null,
      sourceHealth: config.sources.map(source => { const h = health.find(item => item.source === source); return { source, status: h?.status ?? "missing", ageMs: h ? time - h.checkedAt : null, usable: healthUsable(h, time, config.healthMaxAgeMs) }; }), note };
    const target = path.join(directory, "heartbeat.json"), temporary = path.join(directory, ".heartbeat.tmp");
    fs.writeFileSync(temporary, JSON.stringify(heartbeat, null, 2) + "\n", { mode: 0o600 }); fs.renameSync(temporary, target);
    runtime.onHeartbeat?.(heartbeat); return heartbeat;
  };
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: now() })); fs.fsyncSync(fd);
    session = sessionFor(directory, config, now());
    const ledger = new NewsLedger(config.newsDirectory);
    for (;;) {
      const time = now(), state = journalState(modelDirectory);
      if (state.blocked) return publish("REVIEW_REQUIRED", false, "Provider failure or unfinished reservation requires review; no automatic retry.");
      // Recover completed-but-not-alerted results before checking a finished budget.
      emitAlerts(directory, modelDirectory, session, time);
      if (options.signal?.aborted) return publish("STOPPED", false, "Operator stopped this foreground session.");
      if (time >= session.expiresAt) return publish("EXPIRED", false, "Persisted session deadline reached.");
      if (state.reservations >= config.maxRequests) return publish("BUDGET_EXHAUSTED", false, "Persisted lifetime request ceiling reached.");
      const health = ledger.readHealth(time), usable = config.sources.some(source => healthUsable(health.find(h => h.source === source), time, config.healthMaxAgeMs));
      const eligible = ledger.readEvents({ now: time }).filter(e => eventUsable(e, config.sources, health, time, config.maxAgeMs, config.healthMaxAgeMs));
      const completedKeys = new Set(readJournal(modelDirectory).filter(row => row.type === "result").map(row => row.key));
      let pending: NewsEvent[];
      try { pending = eligible.filter(event => !completedKeys.has(requestKey(event, buildRequest(event, time)))); }
      catch { return publish("REVIEW_REQUIRED", false, "Invalid input chronology or schema requires review before inference."); }
      let added = 0;
      if (usable && pending.length) {
        const summary = await runShadow(evaluator, { directory: modelDirectory, newsDirectory: config.newsDirectory,
          maxEvents: 1000, maxRequests: 1, maxAgeMs: config.maxAgeMs, now: time,
          eventFilter: event => eventUsable(event, config.sources, ledger.readHealth(now()), now(), config.maxAgeMs, config.healthMaxAgeMs),
          canRequest: () => !options.signal?.aborted && now() < session!.expiresAt && journalState(modelDirectory).reservations < config.maxRequests });
        added = emitAlerts(directory, modelDirectory, session, now());
        if (summary.stoppedReason === "provider-error-no-automatic-retry" || summary.unresolved || summary.invalid) return publish("REVIEW_REQUIRED", false, "Provider or input failure requires review; no automatic retry.");
      }
      publish(added ? "RESEARCH_ALERT" : usable ? "WAITING_FOR_NEWS" : "WAITING_FOR_HEALTH", true,
        "Foreground ledger polling only; collector and market-data freshness are separate. A saved heartbeat is not proof this process is still alive.");
      await sleep(Math.min(config.pollMs, Math.max(0, session.expiresAt - now())), options.signal);
    }
  } catch (error) {
    // A malformed ledger may prevent a full heartbeat. Leave a minimal explicit failure, never a stale active indicator.
    if (session) fs.writeFileSync(path.join(directory, "heartbeat.json"), JSON.stringify({ schemaVersion: 1, sessionId: session.id,
      observedAt: now(), status: "ERROR", monitorActive: false, ordersSupported: false, note: "Watch stopped on integrity or local I/O failure; inspect local inputs." }, null, 2) + "\n", { mode: 0o600 });
    throw error;
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
