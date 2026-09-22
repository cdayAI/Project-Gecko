// Daily packet: one command that runs the scans, pulls headlines for every
// candidate, runs Jev over them when a key is available, validates the night
// list when one exists, and writes it all to docs/daily/<date>/ so it can be
// pushed and read by the research partner.
//
//   npm run packet -- --provider schwab --push --no-swing   # morning, 08:50 ET (npm run morning wraps this)
//   npm run packet -- --provider schwab --push               # after the close (labelled -close automatically)
//   npm run packet -- --no-jev --scan-args "--symbols AMD,VICR --provider yahoo"   # test
//
// Steps: scan:gap -> scan:swing -> news (Yahoo headlines, last 24h, for the
// candidates) -> Jev live classification (bounded) -> README index with the
// night-list validation (CONFIRMED / GAPPED / NO GAP / NEW) -> commit and
// push docs/daily and docs/log to codex/daily-<date> (--push). Jev uses
// scripts/Invoke-Jev.ps1 on Windows (DPAPI vault) or TYPESAFE_API_KEY
// elsewhere; when neither is available the packet says so and continues.
// --no-swing skips the swing scan (about 12 minutes over the universe); its
// daily bars do not change between the close and the next open, so the
// evening verdict stands for the morning. Runs after 09:30 ET are labelled
// automatically (intraday, or close from 16:00 ET) unless --label is given,
// so an evening run never overwrites the morning packet. Read-only; never
// places orders.

import * as fs from "node:fs";
import * as path from "node:path";
import { etParts } from "../utils/time.js";
import { collectNews, logReportSummary, pushDocs, renderNews, run, runJev } from "./packet-utils.js";
import type { PlanFile } from "./plan-types.js";

interface Args { provider: string; push: boolean; jev: boolean; swing: boolean; jevRequests: number; top: number; scanArgs: string; label: string; date: string; validate: boolean }

function parseArgs(argv: readonly string[]): Args {
  const p = etParts(Date.now());
  const mins = p.hour * 60 + p.minute;
  const defaultLabel = mins < 9 * 60 + 30 ? "" : mins < 16 * 60 ? "intraday" : "close";
  const out: Args = { provider: "auto", push: false, jev: true, swing: true, jevRequests: 12, top: 10, scanArgs: "", label: defaultLabel, date: p.date, validate: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--provider") out.provider = argv[++i] ?? "auto";
    else if (a === "--push") out.push = true;
    else if (a === "--no-jev") out.jev = false;
    else if (a === "--no-swing") out.swing = false;
    else if (a === "--jev-requests") out.jevRequests = Number(argv[++i]);
    else if (a === "--top") out.top = Number(argv[++i]);
    else if (a === "--scan-args") out.scanArgs = argv[++i] ?? "";
    else if (a === "--label") out.label = argv[++i] ?? "";
    else if (a === "--date") out.date = argv[++i] ?? out.date;
    else if (a === "--validate") out.validate = true;   // compare with the night list even after the open (tests)
  }
  return out;
}

interface Candidate { symbol: string; star: boolean; table: string; gapPct: number; above20: boolean; sectorPct: number | null }

// Rows look like "  *CRML      9.27  +37.67  n/a  8.84  8.30  8.56  32.15  Y  -  -  0.47  57M  SPY  +0.6% ..." under a table header line.
function parseGapCandidates(scanOut: string): Candidate[] {
  const out: Candidate[] = [];
  let table = "";
  for (const line of scanOut.split("\n")) {
    const h = line.match(/^(GAP (UP|DOWN): [A-Z]+)/);
    if (h) { table = h[1]; continue; }
    const m = line.match(/^\s{1,3}(\*?)([A-Z]{1,5})\s+[\d.]+\s+[+-][\d.]+/);
    if (!m || !table) continue;
    const tok = line.trim().split(/\s+/);
    const sectorPct = Number((tok[14] ?? "").replace("%", ""));
    out.push({ symbol: m[2], star: m[1] === "*", table, gapPct: Number(tok[2]), above20: tok[8] === "Y", sectorPct: Number.isFinite(sectorPct) ? sectorPct : null });
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

function readPlan(date: string): PlanFile | null {
  const f = path.join("docs", "daily", date, "plan.json");
  try {
    if (!fs.existsSync(f)) return null;
    const p = JSON.parse(fs.readFileSync(f, "utf-8")) as PlanFile;
    return Array.isArray(p.candidates) ? p : null;
  } catch {
    return null;
  }
}

// Night list versus the morning scan.
function validation(plan: PlanFile | null, cands: readonly Candidate[]): string[] {
  if (!plan) return ["No night list for this session (docs/daily/<date>/plan.json); run npm run evening the night before."];
  const lines = [`Night list for ${plan.for} built ${plan.builtAt.slice(0, 16)}Z: ${plan.candidates.length} candidates.`, "", "| Sym | Night list | Morning |", "|---|---|---|"];
  const inPlan = new Set<string>();
  for (const c of plan.candidates) {
    inPlan.add(c.symbol);
    const g = cands.find((x) => x.symbol === c.symbol);
    let verdict: string;
    if (!g) verdict = "NO GAP (not in the scan)";
    else if (g.star) verdict = `CONFIRMED star, gap ${g.gapPct >= 0 ? "+" : ""}${g.gapPct.toFixed(1)}%`;
    else {
      const why: string[] = [];
      if (g.table.startsWith("GAP DOWN")) why.push("gap down (the spec is long only)");
      if (Math.abs(g.gapPct) < 10) why.push(`gap ${g.gapPct >= 0 ? "+" : ""}${g.gapPct.toFixed(1)}% (< 10%)`);
      if (!g.above20) why.push("below the 20-day high");
      if (g.sectorPct !== null && g.sectorPct <= 0) why.push("sector red");
      verdict = `GAPPED, not star: ${why.join("; ") || "see scan"}`;
    }
    lines.push(`| ${c.symbol} | ${c.tags.join(" ")} ${c.side}, star level ${c.starLevel.toFixed(2)} | ${verdict} |`);
  }
  for (const g of cands) {
    if (inPlan.has(g.symbol)) continue;
    lines.push(`| ${g.symbol} | not on the list | NEW ${g.star ? "star" : "watch"} (${g.table.replace("GAP ", "")}, gap ${g.gapPct >= 0 ? "+" : ""}${g.gapPct.toFixed(1)}%) |`);
  }
  return lines;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const p = etParts(Date.now());
  const stamp = `${String(p.hour).padStart(2, "0")}${String(p.minute).padStart(2, "0")}`;
  const preOpen = p.hour * 60 + p.minute < 9 * 60 + 30;
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
  let swingVerdict = "skipped (--no-swing; the evening verdict stands, daily bars do not change before the open)";
  let swingCands: string[] = [];
  if (args.swing) {
    say("[2/5] scan:swing");
    const swing = run("npm", ["run", "scan:swing", "--", "--top", "10", ...(args.scanArgs.includes("--provider") ? [] : ["--provider", args.provider])]);
    fs.writeFileSync(path.join(dir, `scan-swing${suffix}.txt`), swing.out);
    swingVerdict = (swing.out.match(/^Breadth: .*$/m) ?? [""])[0];
    swingCands = parseSwingCandidates(swing.out);
  } else say("[2/5] scan:swing skipped (--no-swing)");

  // 3. Headlines for the candidates (Yahoo, no key).
  const symbols = [...new Set([...gapCands.filter((c) => c.star).map((c) => c.symbol), ...gapCands.filter((c) => !c.star).map((c) => c.symbol), ...swingCands])].slice(0, Math.max(args.top, 1));
  say(`[3/5] news for ${symbols.length} candidates: ${symbols.join(",") || "(none)"}`);
  const news = collectNews(symbols);
  if (!news.ok) notes.push("news collector exited with an error");
  fs.writeFileSync(path.join(dir, `news${suffix}.md`), renderNews(args.date, symbols, news.events));

  // 4. Jev.
  say("[4/5] jev");
  const jevNote = !args.jev ? "skipped (--no-jev)" : symbols.length === 0 ? "skipped (no candidates)" : runJev(args.jevRequests, path.join(dir, `jev${suffix}.md`));
  say(`      ${jevNote}`);

  // 5. Index: validation against the night list, then the log summary.
  say("[5/5] index");
  const validate = preOpen || args.validate;
  const plan = validate ? readPlan(args.date) : null;
  const stars = gapCands.filter((c) => c.star).map((c) => c.symbol);
  const readme = [
    `# Daily packet ${args.date} ${stamp} ET${args.label ? ` (${args.label})` : ""}`,
    ``,
    providerLine, tape, ``,
    ...(preOpen ? [] : [`After-open run: Gap% is today's move versus the prior close (a recap of today's movers), not tomorrow's pre-market gap. Star flags below are informational only.`]),
    `Star rows (H-GAP-SECTOR-LONG spec${preOpen ? "" : ", today's move"}): ${stars.join(", ") || "none"}`,
    `Other gap rows: ${gapCands.filter((c) => !c.star).map((c) => `${c.symbol} [${c.table.replace("GAP ", "")}]`).join(", ") || "none"}`,
    `Swing: ${swingVerdict || "n/a"}${swingCands.length ? ` -> ${swingCands.join(", ")}` : ""}`,
    `Jev: ${jevNote}`,
    notes.length ? `Notes: ${notes.join("; ")}` : "",
    ``,
    `Files: scan-gap${suffix}.txt${args.swing ? `, scan-swing${suffix}.txt` : ""}, news${suffix}.md${fs.existsSync(path.join(dir, `jev${suffix}.md`)) ? `, jev${suffix}.md` : ""}`,
    ``,
    ...(validate ? ["## Validation versus the night list", "", ...validation(plan, gapCands), ""] : []),
    "## Forward log", "", "```", logReportSummary(), "```", "",
  ].filter((l) => l !== undefined).join("\n");
  fs.writeFileSync(path.join(dir, `README${suffix}.md`), readme);
  say(`packet written: ${dir}`);

  if (args.push) say(pushDocs(`codex/daily-${args.date}`, `Daily packet ${args.date} ${stamp} ET${args.label ? ` ${args.label}` : ""}`));
}

main();
