// Helpers shared by the daily packet (morning) and the night list (evening):
// child commands, the headline ledger, Jev, and the packet push.

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

export function run(cmd: string, args: readonly string[]): { out: string; ok: boolean } {
  // One command string: spawnSync with shell:true and an args array warns (DEP0190).
  const r = spawnSync([cmd, ...args].join(" "), { shell: true, encoding: "utf8", maxBuffer: 1 << 26, env: process.env });
  const out = `${r.stdout ?? ""}${r.stderr ? "\n" + r.stderr : ""}`.split("\n").filter((l) => !l.includes('"level":"debug"')).join("\n");
  return { out, ok: r.status === 0 };
}

export interface NewsEvent { symbols?: string[]; title?: string; url?: string; publisher?: string; source?: string; publishedAt?: number }

// Headlines for the symbols from the ledger (data/news/events.jsonl), last 24h, newest first.
export function readEvents(symbols: readonly string[], maxAgeHours = 24): NewsEvent[] {
  const f = path.join("data", "news", "events.jsonl");
  if (!fs.existsSync(f)) return [];
  const want = new Set(symbols);
  const cutoff = Date.now() - maxAgeHours * 3_600_000;
  const rows = fs.readFileSync(f, "utf-8").split("\n").filter((l) => l.trim()).map((l) => { try { return JSON.parse(l) as NewsEvent; } catch { return null; } }).filter((e): e is NewsEvent => e !== null);
  const seen = new Set<string>();
  return rows.filter((e) => (e.publishedAt ?? 0) >= cutoff && (e.symbols ?? []).some((s) => want.has(s))).filter((e) => { const k = `${e.title}|${e.url}`; if (seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0));
}

// Pull Yahoo headlines for the symbols into the ledger, then read them back.
export function collectNews(symbols: readonly string[], maxAgeMinutes = 1440): { events: NewsEvent[]; ok: boolean } {
  if (symbols.length === 0) return { events: [], ok: true };
  const r = run("npm", ["run", "news", "--", "--source", "yahoo", "--symbols", symbols.join(","), "--once", "--max-age-minutes", String(maxAgeMinutes), "--limit", "20"]);
  return { events: readEvents(symbols, maxAgeMinutes / 60), ok: r.ok };
}

export function renderNews(date: string, symbols: readonly string[], events: readonly NewsEvent[]): string {
  const lines = [`# Headlines ${date} (last 24h, Yahoo, attributed)`, ""];
  for (const s of symbols) {
    const mine = events.filter((e) => (e.symbols ?? []).includes(s));
    lines.push(`## ${s} (${mine.length})`);
    for (const e of mine.slice(0, 8)) {
      const t = e.publishedAt ? new Date(e.publishedAt).toISOString().slice(0, 16) + "Z" : "n/a";
      lines.push(`- ${t} [${e.publisher ?? e.source ?? "?"}] ${e.title ?? ""}${e.url ? ` (${e.url})` : ""}`);
    }
    if (mine.length === 0) lines.push("- (no headlines in the last 24h; check the platform news feed before treating a gap as a catalyst)");
    lines.push("");
  }
  return lines.join("\n");
}

export function listReviews(): string[] {
  const d = path.join("data", "jev");
  return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => /^review-.*\.md$/.test(f)) : [];
}

// Jev over the ledger: scripts/Invoke-Jev.ps1 on Windows (DPAPI vault) or
// TYPESAFE_API_KEY elsewhere. Copies the fresh review to `dest` when produced.
export function runJev(maxRequests: number, dest: string): string {
  const before = new Set(listReviews());
  let ran = false;
  let note = "";
  if (process.platform === "win32" && fs.existsSync(path.join("scripts", "Invoke-Jev.ps1"))) {
    const r = run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "scripts/Invoke-Jev.ps1", "-Mode", "live", "-MaxRequests", String(maxRequests), "-MaxEvents", "24", "-MaxAgeMinutes", "1440"]);
    ran = r.ok; if (!r.ok) note = `Invoke-Jev.ps1 failed: ${r.out.trim().split("\n").slice(-2).join(" ")}`;
  } else if (process.env.TYPESAFE_API_KEY) {
    const r = run("npm", ["run", "jev", "--", "--live", "--max-requests", String(maxRequests), "--max-events", "24", "--max-age-minutes", "1440"]);
    ran = r.ok; if (!r.ok) note = `jev failed: ${r.out.trim().split("\n").slice(-2).join(" ")}`;
  } else note = "skipped (no Windows vault key and no TYPESAFE_API_KEY)";
  if (ran) {
    const fresh = listReviews().filter((f) => !before.has(f));
    const latest = (fresh.length ? fresh : listReviews()).sort().pop();
    if (latest) { fs.copyFileSync(path.join("data", "jev", latest), dest); note = `ok (${latest})`; }
    else note = "ran but no review file was produced";
  }
  return note;
}

// Symbol -> catalyst label with the highest model probability in a Jev review file.
export function jevLabels(reviewFile: string): Map<string, string> {
  const out = new Map<string, { label: string; p: number }>();
  if (!fs.existsSync(reviewFile)) return new Map();
  let sym = "";
  for (const line of fs.readFileSync(reviewFile, "utf-8").split("\n")) {
    const h = line.match(/^## ([A-Z]{1,5}): /);
    if (h) { sym = h[1]; continue; }
    const m = line.match(/^\| catalyst \| ([a-z_]+) \| ([\d.]+) \|/);
    if (m && sym) {
      const p = Number(m[2]);
      const cur = out.get(sym);
      if (!cur || p > cur.p) out.set(sym, { label: m[1], p });
    }
  }
  return new Map([...out].map(([k, v]) => [k, `${v.label} ${v.p.toFixed(2)}`]));
}

// Commit docs/daily and docs/log and push HEAD to the transport branch.
export function pushDocs(branch: string, message: string): string {
  const add = run("git", ["add", "docs/daily", "docs/log"]);
  const commit = run("git", ["commit", "-m", `"${message.replace(/"/g, "'")}"`]);
  const push = run("git", ["push", "origin", `HEAD:${branch}`]);
  return add.ok && commit.ok && push.ok ? `pushed to ${branch}` : `push step: add ${add.ok} commit ${commit.ok} push ${push.ok}\n${push.out.trim().split("\n").slice(-3).join("\n")}`;
}

export function logReportSummary(): string {
  return run("npm", ["run", "log", "--", "report"]).out.split("\n").filter((l) => l.startsWith("=====") || l.startsWith("ALL") || l.startsWith("  taken") || l.startsWith("  watched")).join("\n");
}
