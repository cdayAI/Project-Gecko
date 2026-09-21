import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { evaluateLabels, type EvaluationSplit, type SemanticLabel, type SemanticPrediction } from "./evaluation.js";
import { QUESTIONS } from "./questions.js";

const observedAt = Date.UTC(2026, 8, 19, 16);
const decidedAt = observedAt + 1_000;
function prediction(eventId = "SYNTHETIC-1", questionId = "dilution", choice = "present", p = 0.8): SemanticPrediction {
  const alternatives = Object.keys(QUESTIONS[questionId].criteria);
  return { eventId, questionId, choice,
    probabilities: Object.fromEntries(alternatives.map((label) => [label, label === choice ? p : (1 - p) / (alternatives.length - 1)])),
    model: "SYNTHETIC-NOT-A-MODEL-RUN", promptVersion: "SYNTHETIC-evaluation-selftest", observedAt, decidedAt };
}
function label(eventId = "SYNTHETIC-1", questionId = "dilution", answer = "present", split: EvaluationSplit = "holdout"): SemanticLabel {
  return { eventId, questionId, label: answer, split, labelledAt: decidedAt + 1_000 };
}
function near(actual: number | null, expected: number): void {
  assert.ok(actual !== null && Math.abs(actual - expected) < 1e-12, `${actual} differs from ${expected}`);
}

export function runJevEvaluationSelfTest(): { passed: number; data: "SYNTHETIC_ONLY" } {
  let passed = 0;
  const test = (fn: () => void): void => { fn(); passed++; };
  test(() => {
    // Hand-computed two-row, three-class example. An accuracy-only metric would
    // fail to distinguish the well-calibrated correct row from the second miss.
    const predictions = [prediction("a"), prediction("b", "dilution", "denied", 0.6)];
    const labels = [label("a"), label("b")];
    const result = evaluateLabels(predictions, labels, "holdout");
    assert.equal(result.overall.sampleSize, 2);
    assert.equal(result.overall.accuracy, 0.5);
    near(result.overall.multiclassBrier, (0.06 + 1.04) / 2);
    near(result.overall.logLoss as number, -(Math.log(0.8) + Math.log(0.2)) / 2);
    assert.equal(result.blinding.status, "CHRONOLOGY_COMPATIBLE_HOLDOUT_NOT_PROOF_OF_PROSPECTIVE_COLLECTION");
    assert.equal(result.blinding.prospectiveCollectionVerified, false);
    assert.equal(result.scope, "SEMANTIC_LABEL_EVALUATION_NOT_TRADING_PROBABILITY");
  });
  test(() => {
    const result = evaluateLabels([prediction("a"), prediction("b"), prediction("orphan"), prediction("dev")],
      [label("a"), label("a", "guidance", "raised"), label("b"), label("missing"), label("dev", "dilution", "present", "development")], "holdout");
    assert.deepEqual(result.coverage, { suppliedPredictions: 4, labelledRows: 4, matchedRows: 2,
      missingPredictions: 2, unlabelledPredictions: 1, predictionsInOtherSplit: 1, predictionCoverage: 0.5,
      labelledEvents: 3, eventsWithPredictions: 2, fullyPredictedEvents: 1 });
    const guidance = result.perQuestion.find((row) => row.questionId === "guidance")!;
    assert.equal(guidance.labelledRows, 1); assert.equal(guidance.sampleSize, 0);
    assert.equal(guidance.missingPredictions, 1); assert.equal(guidance.predictionCoverage, 0);
    assert.equal(guidance.accuracy, null); assert.equal(guidance.labelCounts.raised, 1);
  });
  test(() => {
    const result = evaluateLabels([], [], "holdout");
    assert.deepEqual(result.overall, { sampleSize: 0, correct: 0, accuracy: null, multiclassBrier: null,
      logLoss: null, zeroProbabilityLabels: 0 });
    assert.equal(result.coverage.predictionCoverage, null); assert.equal(result.cohort, null);
    assert.equal(result.perQuestion.length, 6); assert.equal(result.blinding.status, "NO_MATCHED_HOLDOUT_PREDICTIONS");
  });
  test(() => {
    const result = evaluateLabels([prediction("a", "dilution", "denied", 1)], [label("a")], "holdout");
    assert.equal(result.overall.multiclassBrier, 2); assert.equal(result.overall.logLoss, "infinity");
    assert.equal(result.overall.zeroProbabilityLabels, 1);
    assert.equal(JSON.parse(JSON.stringify(result)).overall.logLoss, "infinity");
  });
  test(() => {
    const result = evaluateLabels([prediction("a", "dilution", "present", 1)], [label("a")], "holdout");
    assert.equal(result.overall.multiclassBrier, 0); assert.equal(result.overall.logLoss, 0);
    assert.equal(result.overall.accuracy, 1);
  });
  test(() => {
    const r = evaluateLabels([prediction("a", "dilution", "present", 1 / 3)], [label("a")], "holdout");
    near(r.overall.multiclassBrier, 2 / 3); near(r.overall.logLoss as number, Math.log(3));
  });
  test(() => {
    const r = evaluateLabels([prediction("a", "guidance", "raised", 0.8), prediction("b")],
      [label("a", "guidance", "lowered"), label("b")], "holdout");
    assert.equal(r.perQuestion.find((q) => q.questionId === "guidance")!.accuracy, 0);
    assert.equal(r.perQuestion.find((q) => q.questionId === "dilution")!.accuracy, 1);
    assert.equal(r.overall.accuracy, 0.5);
  });
  test(() => {
    for (const labelledAt of [observedAt - 1, observedAt, decidedAt]) {
      const r = evaluateLabels([prediction()], [{ ...label(), labelledAt }], "holdout");
      assert.equal(r.blinding.status, "INVALID_BLINDED_HOLDOUT_RETROSPECTIVE");
      assert.equal(r.overall.sampleSize, 1, "Retrospective descriptive metrics remain available");
      assert.deepEqual(r.blinding.affectedEventIds, ["SYNTHETIC-1"]);
    }
  });
  test(() => {
    // Even if this row's label came later, a different label for the same event
    // was already known. A per-row-only leakage check would miss this.
    const r = evaluateLabels([prediction()], [label(), { ...label("SYNTHETIC-1", "guidance", "raised"), labelledAt: decidedAt }], "holdout");
    assert.equal(r.blinding.rowsWithEventLabelAtOrBeforeDecision, 1);
    assert.equal(r.blinding.status, "INVALID_BLINDED_HOLDOUT_RETROSPECTIVE");
  });
  test(() => {
    const p = prediction(), l = { ...label(), split: "development" as const, labelledAt: observedAt - 1 };
    assert.equal(evaluateLabels([p], [l], "development").blinding.status, "DEVELOPMENT_RETROSPECTIVE_DIAGNOSTIC");
  });
  test(() => {
    assert.throws(() => evaluateLabels([prediction(), prediction()], [label()], "holdout"), /Duplicate prediction/);
    assert.throws(() => evaluateLabels([prediction()], [label(), label()], "holdout"), /Duplicate or conflicting label/);
    assert.throws(() => evaluateLabels([prediction()], [label(), { ...label(), label: "denied" }], "holdout"), /conflicting label/);
  });
  test(() => {
    assert.throws(() => evaluateLabels([], [label(), label("SYNTHETIC-1", "guidance", "raised", "development")], "holdout"), /both development and holdout/);
    const old = `source@${"a".repeat(64)}`, revision = `source@${"b".repeat(64)}`;
    assert.throws(() => evaluateLabels([], [label(old), label(revision, "dilution", "present", "development")], "holdout"), /both development and holdout/);
  });
  test(() => {
    const old = `source@${"a".repeat(64)}`, revision = `source@${"b".repeat(64)}`;
    const r = evaluateLabels([prediction(revision)], [{ ...label(old), labelledAt: decidedAt - 1 }, label(revision)], "holdout");
    assert.equal(r.blinding.status, "INVALID_BLINDED_HOLDOUT_RETROSPECTIVE");
  });
  test(() => {
    assert.throws(() => evaluateLabels([{ ...prediction(), observedAt: decidedAt + 1 }], [label()], "holdout"), /future observation/);
    assert.throws(() => evaluateLabels([prediction(), { ...prediction("SYNTHETIC-1", "guidance", "raised"), observedAt: observedAt - 1 }], [], "holdout"), /Inconsistent observation/);
  });
  test(() => {
    for (const bad of [NaN, Infinity, -1, 0.25, Number.MAX_SAFE_INTEGER]) {
      assert.throws(() => evaluateLabels([{ ...prediction(), observedAt: bad }], [], "holdout"), /milliseconds/);
      assert.throws(() => evaluateLabels([{ ...prediction(), decidedAt: bad }], [], "holdout"), /milliseconds/);
      assert.throws(() => evaluateLabels([], [{ ...label(), labelledAt: bad }], "holdout"), /milliseconds/);
    }
  });
  test(() => {
    for (const bad of [NaN, Infinity, -0.01, 1.01, "0.8"]) {
      const p = prediction(); (p.probabilities as Record<string, unknown>).present = bad;
      assert.throws(() => evaluateLabels([p], [], "holdout"), /finite numbers/);
    }
    const p = prediction(); p.probabilities.present = 0.2;
    assert.throws(() => evaluateLabels([p], [], "holdout"), /sum to 1/);
  });
  test(() => {
    const p = prediction(); delete p.probabilities.unknown;
    assert.throws(() => evaluateLabels([p], [], "holdout"), /probability classes/);
    const extra = prediction(); extra.probabilities["future_price_up"] = 0;
    assert.throws(() => evaluateLabels([extra], [], "holdout"), /probability classes/);
    assert.throws(() => evaluateLabels([], [{ ...label(), label: "invalid" }], "holdout"), /allowed classes/);
  });
  test(() => {
    assert.throws(() => evaluateLabels([{ ...prediction(), choice: "unknown" }], [], "holdout"), /maximum probability/);
    assert.throws(() => evaluateLabels([{ ...prediction(), choice: "invalid" }], [], "holdout"), /absent from probabilities/);
  });
  test(() => {
    assert.throws(() => evaluateLabels([prediction("a"), { ...prediction("b"), model: "other" }], [], "holdout"), /cohorts/);
    assert.throws(() => evaluateLabels([prediction("a"), { ...prediction("b"), promptVersion: "other" }], [], "holdout"), /cohorts/);
  });
  test(() => {
    for (const questionId of ["win_probability", "", " guidance"]) {
      assert.throws(() => evaluateLabels([{ ...prediction(), questionId }], [], "holdout"));
      assert.throws(() => evaluateLabels([], [{ ...label(), questionId }], "holdout"));
    }
    assert.throws(() => evaluateLabels([], [], "test" as EvaluationSplit), /split/);
    assert.throws(() => evaluateLabels([], [{ ...label(), split: "test" as EvaluationSplit }], "holdout"), /split/);
  });
  test(() => {
    const withExtra = { ...prediction(), winProbability: 0.99 };
    assert.throws(() => evaluateLabels([withExtra], [], "holdout"), /schema fields/);
    const missing = { ...prediction() } as Partial<SemanticPrediction>; delete missing.observedAt;
    assert.throws(() => evaluateLabels([missing as SemanticPrediction], [], "holdout"), /schema fields/);
    assert.throws(() => evaluateLabels([], [{ ...label(), unexpected: true } as SemanticLabel], "holdout"), /schema fields/);
  });
  test(() => {
    assert.throws(() => evaluateLabels([null as unknown as SemanticPrediction], [], "holdout"), /plain object/);
    assert.throws(() => evaluateLabels(Array<SemanticPrediction>(1), [], "holdout"), /plain object/);
    assert.throws(() => evaluateLabels([], Array<SemanticLabel>(1), "holdout"), /plain object/);
    assert.throws(() => evaluateLabels(null as unknown as SemanticPrediction[], [], "holdout"), /arrays/);
    assert.throws(() => evaluateLabels([], null as unknown as SemanticLabel[], "holdout"), /arrays/);
  });
  test(() => {
    const predictions = [prediction("z"), prediction("a")], labels = [label("a"), label("z")];
    const before = JSON.stringify({ predictions, labels });
    for (const p of predictions) { Object.freeze(p.probabilities); Object.freeze(p); }
    labels.forEach(Object.freeze); Object.freeze(predictions); Object.freeze(labels);
    const r = evaluateLabels(predictions, labels, "holdout");
    assert.equal(JSON.stringify({ predictions, labels }), before);
    assert.deepEqual(evaluateLabels([...predictions].reverse(), [...labels].reverse(), "holdout"), r);
  });
  test(() => {
    // Validate every exact schema and demonstrate there are no live API calls.
    const predictions = Object.entries(QUESTIONS).map(([id, q]) => prediction("all", id, Object.keys(q.criteria)[0], 1));
    const labels = predictions.map((p) => label(p.eventId, p.questionId, p.choice));
    const r = evaluateLabels(predictions, labels, "holdout");
    assert.equal(r.overall.sampleSize, 6); assert.equal(r.overall.accuracy, 1);
    assert.ok(r.limitations.some((s) => s.includes("synthetic")));
    assert.ok(r.limitations.some((s) => s.includes("fill and cost evidence")));
  });
  test(() => {
    const labels = readFileSync(new URL("../../../fixtures/jev-labels.example.jsonl", import.meta.url), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line) as SemanticLabel);
    const r = evaluateLabels([], labels, "holdout");
    assert.equal(r.coverage.labelledRows, 6); assert.equal(r.coverage.missingPredictions, 6);
    assert.equal(r.overall.accuracy, null, "Example labels alone must not manufacture scored predictions");
    assert.equal(r.blinding.status, "NO_MATCHED_HOLDOUT_PREDICTIONS");
  });
  test(() => {
    const p = prediction(); p.probabilities.present += 0.00005;
    const r = evaluateLabels([p], [label()], "holdout");
    near(r.overall.multiclassBrier, (0.80005 - 1) ** 2 + 0.1 ** 2 + 0.1 ** 2);
  });
  return { passed, data: "SYNTHETIC_ONLY" };
}

if (process.argv[1]?.endsWith("evaluation-selftest.ts") || process.argv[1]?.endsWith("evaluation-selftest.js")) {
  process.stdout.write(JSON.stringify({ component: "jev-evaluation-selftest", ...runJevEvaluationSelfTest() }) + "\n");
}
