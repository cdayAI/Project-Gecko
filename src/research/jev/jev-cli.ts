import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { NewsLedger } from "../news/ledger.js";
import { JevClient, JEV_MODEL, type JevRequest, type JevResponse } from "./client.js";
import { PROMPT_VERSION, type EvidenceContext } from "./questions.js";
import { readJournal, runShadow, syntheticEvent } from "./shadow.js";
import { evaluateLabels, type SemanticPrediction, type SemanticLabel } from "./evaluation.js";
import { readWatchStatus, runWatch } from "./watch.js";
import type { NewsSource } from "../news/types.js";

export function parseArgs(args: readonly string[]): Map<string, string> {
  const switches = new Set(["status", "demo", "probe", "live", "watch", "evaluate", "export", "help"]);
  const values = new Set(["max-requests", "max-events", "max-age-minutes", "news-directory", "directory", "evidence-file", "predictions", "labels", "split", "output", "duration-minutes", "sources", "poll-seconds", "health-max-age-seconds"]);
  const parsed = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("--")) throw new Error("Unknown argument");
    const key = args[i].slice(2);
    if (parsed.has(key) || !switches.has(key) && !values.has(key)) throw new Error("Unknown or duplicate option");
    if (switches.has(key)) parsed.set(key, "true");
    else { const value = args[++i]; if (!value || value.startsWith("--")) throw new Error("Missing option value"); parsed.set(key, value); }
  }
  if ([...switches].filter(k => parsed.has(k)).length > 1) throw new Error("Select one mode");
  if ((parsed.has("live") || parsed.has("probe") || parsed.has("watch")) && !parsed.has("max-requests")) throw new Error("Live inference requires explicit --max-requests");
  if (parsed.has("watch") && (!["duration-minutes", "sources", "directory"].every(k => parsed.has(k)) || parsed.has("evidence-file"))) throw new Error("Watch needs explicit duration, sources and dedicated directory; static evidence files are not supported");
  if (!parsed.has("watch") && ["duration-minutes", "sources", "poll-seconds", "health-max-age-seconds"].some(k => parsed.has(k))) throw new Error("Watch-only arguments require --watch");
  if (parsed.has("probe") && parsed.get("max-requests") !== "1") throw new Error("Probe must be bounded to one request");
  return parsed;
}
function positive(value: string, max: number): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > max) throw new Error("Invalid numeric bound");
  return number;
}
function jsonLines(file: string): unknown[] {
  if (fs.statSync(file).size > 50_000_000) throw new Error("Input exceeds 50 MB");
  return fs.readFileSync(file, "utf8").split("\n").filter(line => line.trim()).map(line => JSON.parse(line) as unknown);
}
function writeNew(file: string, data: string): void {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, data, { flag: "wx", mode: 0o600 });
}

export async function main(args: readonly string[]): Promise<void> {
  const options = parseArgs(args);
  const directory = options.get("directory") ?? "data/jev";
  const newsDirectory = options.get("news-directory") ?? "data/news";
  const now = Date.now();
  const maxEvents = positive(options.get("max-events") ?? "20", 1000);
  const maxAgeMs = positive(options.get("max-age-minutes") ?? (options.has("watch") ? "5" : "1440"), 44640) * 60000;
  if (options.has("help")) {
    console.log("Jev research: --status (default); --demo (synthetic, offline); --probe --max-requests 1; --live --max-requests N [--max-events 20 --max-age-minutes 1440 --news-directory data/news --directory data/jev --evidence-file excerpts.jsonl]; --watch --max-requests N --duration-minutes N --sources yahoo,sec --directory NEW_SESSION [--poll-seconds 1 --max-age-minutes 5 --health-max-age-seconds 180]; --export --output NEW.jsonl; --evaluate --predictions FILE --labels FILE --split development|holdout [--output NEW.json]. Watch is a foreground ledger consumer with a persisted session cap and deadline; it starts no collector, background service or orders. Ordinary --live caps apply only to that invocation.");
    return;
  }
  if (options.has("export")) {
    if (!options.get("output")) throw new Error("Export requires new output path");
    const rows = readJournal(directory);
    if (rows.some(r => r.mode !== "LIVE_SHADOW")) throw new Error("Synthetic or unclassified rows cannot be exported for live evaluation");
    const reservations = new Map(rows.filter(r => r.type === "reserved").map(r => [r.attemptId, r]));
    const predictions: SemanticPrediction[] = [];
    for (const row of rows.filter(r => r.type === "result")) {
      const reservation = reservations.get(row.attemptId);
      if (!reservation || reservation.key !== row.key) throw new Error("Result has no matching reservation");
      const response = row.response as JevResponse;
      for (const [questionId, answer] of Object.entries(response.answers)) predictions.push({
        eventId: `${reservation.eventId}@${row.key}`, questionId, choice: answer.choice, probabilities: answer.probabilities,
        model: response.model, promptVersion: String(reservation.promptVersion), observedAt: Number(reservation.observedAt), decidedAt: Number(row.at),
      });
    }
    writeNew(options.get("output")!, predictions.map(p => JSON.stringify(p)).join("\n") + (predictions.length ? "\n" : ""));
    console.log(JSON.stringify({ status: "EXPORTED_SEMANTIC_PREDICTIONS_ONLY", count: predictions.length, output: options.get("output"), sourceDirectory: directory }));
    return;
  }
  if (options.has("evaluate")) {
    const predictions = options.get("predictions"), labels = options.get("labels"), split = options.get("split");
    if (!predictions || !labels || !["development", "holdout"].includes(split ?? "")) throw new Error("Evaluation requires predictions, labels and split");
    const evaluation = evaluateLabels(jsonLines(predictions) as SemanticPrediction[], jsonLines(labels) as SemanticLabel[], split as "development" | "holdout");
    if (options.has("output")) writeNew(options.get("output")!, JSON.stringify(evaluation, null, 2) + "\n");
    console.log(JSON.stringify(evaluation, null, 2)); return;
  }
  if (options.has("demo") || options.has("probe")) {
    const probe = options.has("probe");
    if (probe && !process.env.TYPESAFE_API_KEY) throw new Error("Probe needs locally configured key");
    const demoDirectory = path.join(directory, `${probe ? "probe" : "synthetic"}-${randomUUID()}`);
    const input = path.join(demoDirectory, "news");
    const event = syntheticEvent(now);
    writeNew(path.join(input, "events.jsonl"), JSON.stringify(event) + "\n");
    const mock = { evaluate: async (request: JevRequest): Promise<JevResponse> => ({ model: JEV_MODEL,
      answers: Object.fromEntries(Object.entries(request.questions).map(([id, q]) => {
        const choice = ({ catalyst: "contract", commitment: "conditional", evidence_scope: "headline_only" } as Record<string, string>)[id] ?? "unknown";
        return [id, { type: "choice" as const, choice, probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, k === choice ? 1 : 0])), confidence: 1 }];
      })), usage: { input_tokens: 0, output_tokens: 0 } }) };
    const summary = await runShadow(probe ? new JevClient(process.env.TYPESAFE_API_KEY!) : mock, { directory: demoDirectory, newsDirectory: input, maxEvents: 1, maxRequests: 1, maxAgeMs, now, synthetic: !probe, probe });
    console.log(JSON.stringify({ ...summary, directory: demoDirectory, note: probe ? "Connection probe with synthetic text; no market forecast or accuracy validation." : "Handwritten fixture responses validate plumbing only; no model call or accuracy measurement." }, null, 2));
    if (summary.succeeded !== 1) process.exitCode = 2;
    return;
  }
  if (options.has("live")) {
    const maxRequests = positive(options.get("max-requests")!, 1000);
    const key = process.env.TYPESAFE_API_KEY;
    if (!key) throw new Error("Key absent");
    const contexts = options.has("evidence-file") ? jsonLines(options.get("evidence-file")!) as EvidenceContext[] : undefined;
    const summary = await runShadow(new JevClient(key), { directory, newsDirectory, maxEvents, maxRequests, maxAgeMs, now, contexts });
    console.log(JSON.stringify(summary, null, 2));
    if (summary.stoppedReason || summary.unresolved || summary.invalid) process.exitCode = 2;
    return;
  }
  if (options.has("watch")) {
    const key = process.env.TYPESAFE_API_KEY;
    if (!key) throw new Error("Key absent");
    const controller = new AbortController(), stop = () => controller.abort();
    process.on("SIGINT", stop); process.on("SIGTERM", stop);
    let previous = "";
    try {
      const summary = await runWatch(new JevClient(key), { directory, newsDirectory,
        sources: options.get("sources")!.split(",") as NewsSource[], maxRequests: positive(options.get("max-requests")!, 1000),
        durationMs: positive(options.get("duration-minutes")!, 480) * 60000, maxAgeMs,
        pollMs: positive(options.get("poll-seconds") ?? "1", 60) * 1000,
        healthMaxAgeMs: positive(options.get("health-max-age-seconds") ?? "180", 600) * 1000, signal: controller.signal },
      { onHeartbeat: heartbeat => { const state = `${heartbeat.status}:${heartbeat.completed}`; if (state !== previous) { console.log(JSON.stringify(heartbeat)); previous = state; } } });
      if (summary.status === "REVIEW_REQUIRED" || summary.status === "ERROR") process.exitCode = 2;
    } finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
    return;
  }
  const news = new NewsLedger(newsDirectory);
  const events = news.readEvents({ now });
  const journal = readJournal(directory);
  const watch = readWatchStatus(directory, now);
  console.log(JSON.stringify({ status: "LOCAL_STATUS_NO_API_CALL", model: JEV_MODEL, promptVersion: PROMPT_VERSION,
    keyInProcessEnvironment: Boolean(process.env.TYPESAFE_API_KEY), note: "Encrypted key is inspected only by the explicit live wrapper. Local status does not verify authentication.",
    monitorActive: watch?.monitorActive ?? false, ordersSupported: false, liveRequires: ["API key", "--live", "--max-requests N", "fresh attributed news"],
    watch,
    news: { totalSavedLatestEvents: events.length, ageEligible: events.filter(e => now - e.publishedAt <= maxAgeMs).length,
      sourceHealth: news.readHealth(now) }, evaluations: { journalRows: journal.length, completed: journal.filter(r => r.type === "result").length },
  }, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => {
    console.error("Jev stopped. Check key setup, explicit live request cap, input chronology/schema, and ledger integrity. No provider bodies, credentials or raw errors are printed.");
    process.exitCode = 1;
  });
}
