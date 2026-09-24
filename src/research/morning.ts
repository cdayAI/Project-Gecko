// One morning command, 08:50 ET:
//
//   npm run morning                     # Schwab via the vault
//   npm run morning -- --provider yahoo # no vault
//
// Runs the packet (scan:gap, headlines, Jev, validation against the night
// list, pushed to codex/daily-<date>), then starts the live monitor at
// 09:30 in the same window. Ctrl+C stops the monitor. Read-only.

import { spawn, spawnSync } from "node:child_process";
import { etParts } from "../utils/time.js";

function main(): void {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--provider");
  const provider = i >= 0 ? argv[i + 1] ?? "schwab" : "schwab";
  const push = !argv.includes("--no-push");
  const r = spawnSync(`npm run packet -- --provider ${provider} --no-swing${push ? " --push" : ""}`, { shell: true, stdio: "inherit" });
  if (r.status !== 0) process.stdout.write("packet exited with an error; starting the monitor anyway\n");

  const p = etParts(Date.now());
  const mins = p.hour * 60 + p.minute;
  if (mins >= 16 * 60 + 5 || p.dayOfWeek < 1 || p.dayOfWeek > 5) { process.stdout.write("Outside the session; no monitor started.\n"); return; }
  const waitMs = Math.max(0, ((9 * 60 + 30) - mins) * 60_000 - p.second * 1000);
  if (waitMs > 0) process.stdout.write(`Monitor starts at 09:30 ET (in ${Math.ceil(waitMs / 60_000)} min). Ctrl+C to skip.\n`);
  setTimeout(() => {
    const child = spawn(`npm run live -- --provider ${provider}`, { shell: true, stdio: "inherit" });
    child.on("exit", (code) => process.exit(code ?? 0));
  }, waitMs);
}

main();
