// Daily packet: one command that runs the scans, pulls headlines for every
// candidate, runs Jev over them when a key is available, and writes it all to
// docs/daily/<date>/ so it can be pushed and read by the research partner.
//
//   npm run packet -- --provider schwab --push          # morning, 08:50 ET
//   npm run packet -- --provider schwab --push --label close   # after the close
//   npm run packet -- --no-jev --scan-args "--symbols AMD,VICR --provider yahoo"   # test
//
// Steps: scan:gap -> scan:swing -> news (Yahoo headlines, last 24h, for the
// candidates) -> Jev live classification (bounded) -> README index -> commit
// and push docs/daily and docs/log to codex/daily-<date> (--push). Jev uses
// scripts/Invoke-Jev.ps1 on Windows (DPAPI vault) or TYPESAFE_API_KEY
// elsewhere; when neither is available the packet says so and continues.
// Read-only; never places orders.

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { etParts } from "../utils/time.js";

interface Args { provider: string; push: boolean; jev: boolean; jevRequests: number; top: number; scanArgs: string; label: string; date: string }

function parseArgs(argv: readonly string[]): Args {
  const p = etParts(Date.now());
  const out: Args = { provider: "auto", push: false, jev: true, jevRequests: 12, top: 10, scanArgs: "", label: "", date: p.date };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--provider") out.provider = argv[++i] ?? "auto";
    else if (a === "--push") out.push = true;
    else if (a === "--no-jev") out.jev = false;
    else if (a === "--jev-requests") out.jevRequests = Number(argv[++i]);
    else if (a === "--top") out.top = Number(argv[++i]);
    else if (a === "--scan-args") out.scanArgs = argv[++i] ?? "";
    else if (a === "--label") out.label = argv[++i] ?? "";
    else if (a === "--date") out.date = argv[++i] ?? out.date;
  }
  return out;
}

function run(cmd: string, args: readonly string[]): { out: string; ok: boolean } {
  const r = spawnSync(cmd, args, { shell: true, encoding: "utf8", maxBuffer: 1 << 26, env: process.env });
  const out = `${r.stdout ?? ""}${r.stderr ? "\n" + r.stderr : ""}`.split("\n").filter((l) => !l.includes('"level":"debug"')).join("\n");
  return { out, ok: r.status === 0 };
}

interface Candidate { symbol: string; star: boolean; table: string }

// Rows look like "  *CRML      9.27  +37.67 ..." under a table header line.
function parseGapCandidates(scanOut: string): Candidate[] {
  const out: Candidate[] = [];
  let table = "";
  for (const line of scanOut.split("\n")) {
    const h = line.match(/^(GAP (UP|DOWN): [A-Z]+)/);
    if (h) { table = h[1]; continue; }
    const m = line.match(/^\s{1,3}(\*?)([A-Z]{1,5})\s+[\d.]+\s+[+-][\d.]+/);
    if (m && table) out.push({ symbol: m[2], star: m[1] === "*", table });
  }
  return out;
}

function parseSwingCandidates(scanOut: string): string[] {
  const out: string[] = [];
  let inRows = false;
  for (const line of scanOut.split("\n")) {
    if (line.startsWith("Candidates ranked by drop size")) { inRows = true; continue; }
    if (inRows) { const m = line.match(/^\s{2}([A-Z]{1,5})\s+[\d.]+\s+[\d.]+/); if (m) out.push(m[1]); else if (line.startsWith("Rules")) break; }
  }
  return out;
}

interface NewsEvent { symbols?: string[]; title?: string; url?: string; publisher?: string; source?: string; publishedAt?: number }

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const p = etParts(Date.now());
  const stamp = `${String(p.hour).padStart(2, "0")}${String(p.minute).padStart(2, "0")}`;
  const dir = path.join("docs", "daily", args.date);
  fs.mkdirSync(dir, { recursive: true });
  const suffix = args.label ? `-${args.label}` : "";
  const notes: string[] = [];
  const say = (s: string): void => { process.stdout.write(s + "\n"); };

  // 1. Gap scan.
  say(`[1/5] scan:gap (${args.provider})`);
  const gapArgs = args.scanArgs ? args.scanArgs.split(/\s+/) : ["--provider", args.provider];
  const gap = run("npm", ["run", "scan:gap", "--", ...gapArgs]);
  fs.writeFileSync(path.join(dir, `scan-gap${suffix}.txt`), gap.out);
  if (!gap.ok) notes.push("scan:gap exited with an error; see scan-gap.txt");
  const gapCands = parseGapCandidates(gap.out);
  const tape = (gap.out.match(/^Tape: .*$/m) ?? [""])[0];
  const providerLine = (gap.out.match(/^Provider: .*$/m) ?? [""])[0];

  // 2. Swing scan.
  say("[2/5] scan:swing");
  const swing = run("npm", ["run", "scan:swing", "--", "--top", "10", ...(args.scanArgs.includes("--provider") ? [] : ["--provider", args.provider])]);
  fs.writeFileSync(path.join(dir, `scan-swing${suffix}.txt`), swing.out);
  const swingVerdict = (swing.out.match(/^Breadth: .*$/m) ?? [""])[0];
  const swingCands = parseSwingCandidates(swing.out);

  // 3. Headlines for the candidates (Yahoo, no key).
  const symbols = [...new Set([...gapCands.filter((c) => c.star).map((c) => c.symbol), ...gapCands.filter((c) => !c.star).map((c) => c.symbol), ...swingCands])].slice(0, Math.max(args.top, 1));
  say(`[3/5] news for ${symbols.length} candidates: ${symbols.join(",") || "(none)"}`);
  if (symbols.length > 0) {
    const news = run("npm", ["run", "news", "--", "--source", "yahoo", "--symbols", symbols.join(","), "--once", "--max-age-minutes", "1440", "--limit", "20"]);
    if (!news.ok) notes.push("news collector exited with an error");
  }
  const events = readEvents(symbols);
  fs.writeFileSync(path.join(dir, `news${suffix}.md`), renderNews(args.date, symbols, events));

  // 4. Jev.
  say("[4/5] jev");
  let jevNote = "";
  if (!args.jev) jevNote = "skipped (--no-jev)";
  else if (symbols.length === 0) jevNote = "skipped (no candidates)";
  else {
    const before = new Set(listReviews());
    let ran = false;
    if (process.platform === "win32" && fs.existsSync(path.join("scripts", "Invoke-Jev.ps1"))) {
      const r = run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "scripts/Invoke-Jev.ps1", "-Mode", "live", "-MaxRequests", String(args.jevRequests), "-MaxEvents", "24", "-MaxAgeMinutes", "1440"]);
      ran = r.ok; if (!r.ok) jevNote = `Invoke-Jev.ps1 failed: ${r.out.trim().split("\n").slice(-2).join(" ")}`;
    } else if (process.env.TYPESAFE_API_KEY) {
      const r = run("npm", ["run", "jev", "--", "--live", "--max-requests", String(args.jevRequests), "--max-events", "24", "--max-age-minutes", "1440"]);
      ran = r.ok; if (!r.ok) jevNote = `jev failed: ${r.out.trim().split("\n").slice(-2).join(" ")}`;
    } else jevNote = "skipped (no Windows vault key and no TYPESAFE_API_KEY)";
    if (ran) {
      const fresh = listReviews().filter((f) => !before.has(f));
      const latest = (fresh.length ? fresh : listReviews()).sort().pop();
      if (latest) { fs.copyFileSync(path.join("data", "jev", latest), path.join(dir, `jev${suffix}.md`)); jevNote = `ok (${latest})`; }
      else jevNote = "ran but no review file was produced";
    }
  }
  say(`      ${jevNote}`);

  // 5. Index + log summary.
  say("[5/5] index");
  const logReport = run("npm", ["run", "log", "--", "report"]).out.split("\n").filter((l) => l.startsWith("=====") || l.startsWith("ALL") || l.startsWith("  taken") || l.startsWith("  watched")).join("\n");
  const stars = gapCands.filter((c) => c.star).map((c) => c.symbol);
  const readme = [
    `# Daily packet ${args.date} ${stamp} ET${args.label ? ` (${args.label})` : ""}`,
    ``,
    providerLine, tape, ``,
    `Star rows (H-GAP-SECTOR-LONG spec): ${stars.join(", ") || "none"}`,
    `Other gap rows: ${gapCands.filter((c) => !c.star).map((c) => `${c.symbol} [${c.table.replace("GAP ", "")}]`).join(", ") || "none"}`,
    `Swing: ${swingVerdict || "n/a"}${swingCands.length ? ` -> ${swingCands.join(", ")}` : ""}`,
    `Jev: ${jevNote}`,
    notes.length ? `Notes: ${notes.join("; ")}` : "",
    ``,
    `Files: scan-gap${suffix}.txt, scan-swing${suffix}.txt, news${suffix}.md${fs.existsSync(path.join(dir, `jev${suffix}.md`)) ? `, jev${suffix}.md` : ""}`,
    ``,
    "## Forward log", "", "```", logReport, "```", "",
  ].filter((l) => l !== undefined).join("\n");
  fs.writeFileSync(path.join(dir, `README${suffix}.md`), readme);
  say(`packet written: ${dir}`);

  if (args.push) {
    const branch = `codex/daily-${args.date}`;
    const add = run("git", ["add", "docs/daily", "docs/log"]);
    const commit = run("git", ["commit", "-m", `"Daily packet ${args.date} ${stamp} ET${args.label ? ` ${args.label}` : ""}"`]);
    const push = run("git", ["push", "origin", `HEAD:${branch}`]);
    say(add.ok && commit.ok && push.ok ? `pushed to ${branch}` : `push step: add ${add.ok} commit ${commit.ok} push ${push.ok}\n${push.out.trim().split("\n").slice(-3).join("\n")}`);
  }
}

function listReviews(): string[] {
  const d = path.join("data", "jev");
  return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => /^review-.*\.md$/.test(f)) : [];
}

function readEvents(symbols: readonly string[]): NewsEvent[] {
  const f = path.join("data", "news", "events.jsonl");
  if (!fs.existsSync(f)) return [];
  const want = new Set(symbols);
  const cutoff = Date.now() - 24 * 3_600_000;
  const rows = fs.readFileSync(f, "utf-8").split("\n").filter((l) => l.trim()).map((l) => { try { return JSON.parse(l) as NewsEvent; } catch { return null; } }).filter((e): e is NewsEvent => e !== null);
  const seen = new Set<string>();
  return rows.filter((e) => (e.publishedAt ?? 0) >= cutoff && (e.symbols ?? []).some((s) => want.has(s))).filter((e) => { const k = `${e.title}|${e.url}`; if (seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0));
}

function renderNews(date: string, symbols: readonly string[], events: readonly NewsEvent[]): string {
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

main();
