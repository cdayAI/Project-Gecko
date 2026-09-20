import * as fs from "node:fs";
import * as path from "node:path";
import { canonicalUrl, hash, itemHash, record } from "./normalize.js";
import type { NewsEvent, NewsItem, SourceHealth } from "./types.js";

export interface ReadNewsOptions {
  readonly symbols?: readonly string[];
  readonly since?: number; // Filter latest revisions by fetchedAt, inclusive.
  readonly maxAgeMs?: number;
  readonly now?: number;
  readonly includeDuplicates?: boolean;
}

function readRows(file: string): unknown[] {
  if (!fs.existsSync(file)) return [];
  if (fs.statSync(file).size > 50_000_000) throw new Error("News ledger exceeds 50 MB; archive it before continuing");
  return fs.readFileSync(file, "utf8").split("\n").filter((line) => line.trim()).map((line, index) => {
    try { return JSON.parse(line) as unknown; } catch { throw new Error(`News ledger has malformed JSON at line ${index + 1}; refusing silent loss`); }
  });
}

function asEvent(value: unknown): NewsEvent {
  const row = record(value);
  if (!row || row.schemaVersion !== 1 || typeof row.id !== "string" || typeof row.contentHash !== "string"
    || !Number.isInteger(row.revision) || typeof row.firstSeenAt !== "number" || !Number.isFinite(row.firstSeenAt)
    || !["yahoo", "sec", "x", "benzinga", "primary"].includes(String(row.source)) || typeof row.sourceId !== "string"
    || typeof row.title !== "string" || typeof row.url !== "string" || canonicalUrl(row.url) === null
    || typeof row.publisher !== "string" || !Array.isArray(row.symbols) || !row.symbols.every((symbol) => typeof symbol === "string")
    || typeof row.publishedAt !== "number" || !Number.isFinite(row.publishedAt)
    || typeof row.fetchedAt !== "number" || !Number.isFinite(row.fetchedAt)
    || !["reported", "commentary", "rumor", "filing-notice"].includes(String(row.claimStatus))) throw new Error("News ledger event schema is invalid");
  return row as unknown as NewsEvent;
}

export class NewsLedger {
  readonly eventsPath: string;
  readonly healthPath: string;
  private readonly lockPath: string;

  constructor(readonly directory = "data/news") {
    this.eventsPath = path.join(directory, "events.jsonl");
    this.healthPath = path.join(directory, "health.jsonl");
    this.lockPath = path.join(directory, ".write.lock");
  }

  readEvents(options: ReadNewsOptions = {}): NewsEvent[] {
    const now = options.now ?? Date.now();
    const latest = new Map<string, NewsEvent>();
    for (const row of readRows(this.eventsPath)) {
      const event = asEvent(row);
      // Filter before folding: a correction received later must not erase or
      // replace the evidence that was actually available at a replay time.
      if (event.fetchedAt <= now && event.firstSeenAt <= now) latest.set(event.id, event);
    }
    return [...latest.values()].filter((event) => (options.includeDuplicates || !event.duplicateOf)
      && event.publishedAt <= now
      && (!options.symbols || event.symbols.some((symbol) => options.symbols?.includes(symbol)))
      && (options.since === undefined || event.fetchedAt >= options.since)
      && (options.maxAgeMs === undefined || event.publishedAt >= now - options.maxAgeMs))
      .sort((a, b) => b.publishedAt - a.publishedAt || a.id.localeCompare(b.id));
  }

  readHealth(now = Date.now()): SourceHealth[] {
    const latest = new Map<string, SourceHealth>();
    for (const value of readRows(this.healthPath)) {
      const row = record(value);
      if (!row || !["yahoo", "sec", "x", "benzinga", "primary"].includes(String(row.source)) || typeof row.checkedAt !== "number" || !Number.isFinite(row.checkedAt)
        || !["ok", "partial", "auth-required", "rate-limited", "unavailable", "misconfigured", "error"].includes(String(row.status)) || !Array.isArray(row.notes)) throw new Error("News health ledger schema is invalid");
      if (row.checkedAt <= now) latest.set(String(row.source), row as unknown as SourceHealth);
    }
    return [...latest.values()];
  }

  append(items: readonly NewsItem[], firstSeenAt = Date.now()): { events: NewsEvent[]; duplicateCount: number } {
    return this.withLock(() => {
      const latest = new Map(this.readEvents({ includeDuplicates: true }).map((event) => [event.id, event]));
      const byUrl = new Map<string, NewsEvent>();
      for (const event of latest.values()) if (!event.duplicateOf) byUrl.set(event.url, event);
      const events: NewsEvent[] = [];
      let duplicateCount = 0;
      for (const item of items) {
        const url = canonicalUrl(item.url);
        if (!url) throw new Error("News ledger refuses an invalid source URL");
        const id = `${item.source}:${hash(item.sourceId).slice(0, 24)}`;
        const existing = latest.get(id);
        const contentHash = itemHash(item);
        if (existing?.contentHash === contentHash) { duplicateCount++; continue; }
        const sameUrl = byUrl.get(url);
        const duplicateOf = existing?.duplicateOf ?? (sameUrl && sameUrl.id !== id ? sameUrl.id : undefined);
        const event: NewsEvent = { ...item, url, schemaVersion: 1, id, revision: (existing?.revision ?? 0) + 1,
          firstSeenAt: existing?.firstSeenAt ?? firstSeenAt, contentHash, ...(duplicateOf ? { duplicateOf } : {}) };
        asEvent(event);
        events.push(event); latest.set(id, event);
        if (!duplicateOf) byUrl.set(url, event); else duplicateCount++;
      }
      this.appendRows(this.eventsPath, events);
      return { events, duplicateCount };
    });
  }

  appendHealth(health: SourceHealth): void { this.withLock(() => this.appendRows(this.healthPath, [health])); }

  private appendRows(file: string, rows: readonly unknown[]): void {
    if (!rows.length) return;
    const descriptor = fs.openSync(file, "a", 0o600);
    try { fs.writeFileSync(descriptor, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8"); fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }
  }

  private withLock<T>(action: () => T): T {
    fs.mkdirSync(this.directory, { recursive: true });
    let descriptor: number;
    try { descriptor = fs.openSync(this.lockPath, "wx", 0o600); }
    catch { throw new Error("News ledger is locked; another writer may be active. Do not remove the lock until its owner has stopped."); }
    try { return action(); }
    finally { fs.closeSync(descriptor); fs.unlinkSync(this.lockPath); }
  }
}
