import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createLogger } from "../core/logger.js";
const log = createLogger("manual-checks");

// Verify the manual entry point's complete local import graph has no order path.
const visited = new Set<string>();
function inspect(file: string): void {
  const normalized = path.resolve(file);
  if (visited.has(normalized)) return;
  visited.add(normalized);
  const relative = path.relative(process.cwd(), normalized).replace(/\\/g, "/");
  if (relative.startsWith("src/brokers/") || relative.startsWith("src/execution/") || relative === "src/index.ts") throw new Error(`Manual entry point reaches trading code: ${relative}`);
  const body = fs.readFileSync(normalized, "utf8");
  for (const match of body.matchAll(/(?:from\s+|import\s*)["'](\.[^"']+)["']/g)) {
    inspect(path.resolve(path.dirname(normalized), match[1].replace(/\.js$/, ".ts")));
  }
}
inspect("src/desk/desk-cli.ts");
log.info("Manual runtime import boundary passed", { modules: visited.size });

const commands = [
  ["node_modules/typescript/bin/tsc"],
  ...["src/research/providers/webull/signer-selftest.ts", "src/research/quote-quality-selftest.ts",
    "src/research/providers/webull/provider-selftest.ts", "src/research/news/news-selftest.ts",
    "src/desk/desk-selftest.ts", "src/desk/picker-selftest.ts",
    "src/backtest/manual-backtest-selftest.ts", "src/backtest/manual-options-selftest.ts",
    "src/backtest/edge-selftest.ts", "src/backtest/research-statistics-selftest.ts", "src/backtest/research-coverage-selftest.ts",
    "src/research/valuation-history-selftest.ts", "src/research/valuation-pricing-selftest.ts", "src/research/valuation-calibration-selftest.ts"]
    .map(file => ["--import", "tsx", file]),
];
for (const args of commands) {
  const result = spawnSync(process.execPath, args, { stdio: "inherit", windowsHide: true });
  if (result.error || result.status !== 0) { log.error("Manual checks failed", { command: args.at(-1), status: result.status }); process.exit(1); }
}
log.info("All manual-desk component checks passed; live integration and profitability remain separate");
