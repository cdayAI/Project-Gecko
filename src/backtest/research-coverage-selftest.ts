import assert from "node:assert/strict";
import { expectedResearchSessions, researchCoverageIssues } from "./research-coverage.js";
import { createLogger } from "../core/logger.js";
const dates = expectedResearchSessions();
assert.equal(dates.length, 32);
assert.ok(!dates.includes("2026-09-07"));
assert.equal(researchCoverageIssues([], ["SPY", "QQQ"]).length, 64, "Entire missing sessions must not disappear");
const complete = dates.flatMap(date => Array.from({ length: 25 }, (_, index) => ({ symbol: "SPY",
  timestamp: Date.parse(`${date}T13:30:00Z`) + index * 300_000, open: 100, high: 101, low: 99, close: 100, volume: 10 })));
assert.equal(researchCoverageIssues(complete, ["SPY"]).length, 0);
assert.equal(researchCoverageIssues(complete.slice(25), ["SPY"]).length, 1, "Missing full day must be detected");
assert.throws(() => researchCoverageIssues([{ ...complete[0], timestamp: Date.parse("2026-09-17T13:30:00Z") }], ["SPY"]));
createLogger("research-coverage-test").info("Frozen calendar coverage checks passed", { checks: 6 });
