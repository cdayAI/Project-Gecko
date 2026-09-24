import * as fs from "node:fs";
import * as path from "node:path";
import { createLogger } from "../core/logger.js";
import { evaluateDesk } from "./engine.js";
import { demoConfig, demoFrame, DEMO_TIME } from "./fixtures.js";
import { reconstruct } from "./journal.js";
import { DeskStore } from "./store.js";
import type { PlanUpdate } from "./types.js";

const log = createLogger("desk-demo");
const directory = path.join("data", "desk-demo", new Date().toISOString().replace(/[:.]/g, "-"));
const config = demoConfig(), store = new DeskStore(directory);
fs.writeFileSync(path.join(directory, "config.json"), JSON.stringify(config, null, 2));
store.register(config.plans);
let previous: PlanUpdate[] = [];
const stale = demoFrame(DEMO_TIME + 4000);
const frames = [demoFrame(DEMO_TIME, 699), demoFrame(DEMO_TIME + 1000), demoFrame(DEMO_TIME + 2000),
  { ...stale, options: stale.options.map(q => ({ ...q, quoteTime: DEMO_TIME - 10_000 })) },
  demoFrame(DEMO_TIME + 5000), demoFrame(DEMO_TIME + 6000, 697.9), demoFrame(DEMO_TIME + 7000)];
for (const frame of frames) {
  const result = evaluateDesk(config, frame, reconstruct([]), previous);
  store.publish(config, frame, result, previous); previous = [...result.updates];
}
store.health({ at: Date.now(), status: "STOPPED", source: "synthetic", reason: "Completed offline demonstration; no live connection or fills" });
log.info("Synthetic manual desk demonstration complete", { directory, frames: frames.length, realTrades: 0, marketPerformance: "NOT_MEASURED" });
