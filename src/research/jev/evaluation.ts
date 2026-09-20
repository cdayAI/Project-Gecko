import { QUESTIONS } from "./questions.js";

/** Offline semantic-label diagnostics. This module does not evaluate trades. */
export type EvaluationSplit = "development" | "holdout";

export interface SemanticPrediction {
  eventId: string;
  questionId: string;
  choice: string;
  probabilities: Record<string, number>;
  model: string;
  promptVersion: string;
  /** UTC Unix milliseconds when the source was first observed. */
  observedAt: number;
  /** UTC Unix milliseconds when the prediction was recorded. */
  decidedAt: number;
}

export interface SemanticLabel {
  eventId: string;
  questionId: string;
  label: string;
  split: EvaluationSplit;
  /** Actual UTC Unix milliseconds of annotation, never the source date. */
  labelledAt: number;
}

export interface SemanticMetrics {
  sampleSize: number;
  correct: number;
  accuracy: number | null;
  /** Mean sum of squared class errors, without dividing by class count. */
  multiclassBrier: number | null;
  /** Natural-log loss; the string preserves infinite loss in JSON. */
  logLoss: number | "infinity" | null;
  zeroProbabilityLabels: number;
}

export interface QuestionEvaluation extends SemanticMetrics {
  questionId: string;
  classes: string[];
  labelledRows: number;
  missingPredictions: number;
  predictionCoverage: number | null;
  labelCounts: Record<string, number>;
}

export interface SemanticEvaluation {
  scope: "SEMANTIC_LABEL_EVALUATION_NOT_TRADING_PROBABILITY";
  split: EvaluationSplit;
  cohort: { model: string; promptVersion: string } | null;
  coverage: {
    suppliedPredictions: number;
    labelledRows: number;
    matchedRows: number;
    missingPredictions: number;
    /** Predictions without any supplied label; their split is unknown. */
    unlabelledPredictions: number;
    predictionsInOtherSplit: number;
    predictionCoverage: number | null;
    labelledEvents: number;
    eventsWithPredictions: number;
    fullyPredictedEvents: number;
  };
  overall: SemanticMetrics;
  perQuestion: QuestionEvaluation[];
  blinding: {
    status: "DEVELOPMENT_RETROSPECTIVE_DIAGNOSTIC" | "NO_MATCHED_HOLDOUT_PREDICTIONS"
      | "INVALID_BLINDED_HOLDOUT_RETROSPECTIVE"
      | "CHRONOLOGY_COMPATIBLE_HOLDOUT_NOT_PROOF_OF_PROSPECTIVE_COLLECTION";
    rowsWithEventLabelAtOrBeforeDecision: number;
    affectedEventIds: string[];
    /** Timestamps alone cannot establish that labels were actually concealed. */
    prospectiveCollectionVerified: false;
  };
  limitations: string[];
}

const QUESTION_IDS = new Set(Object.keys(QUESTIONS));
// Accept the same rounding tolerance as the transport validator; do not silently
// normalize or clip supplied probabilities when calculating proper scores.
const PROBABILITY_TOLERANCE = 0.0001;

function record(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error(`${name} must be a plain object`);
  }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], name: string): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new Error(`${name} has missing or unexpected schema fields`);
  }
}

function textField(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || value.length > 512) {
    throw new Error(`${name} must be nonempty trimmed text of at most 512 characters`);
  }
}

function timestamp(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 8.64e15) {
    throw new Error(`${name} must be valid nonnegative UTC Unix milliseconds`);
  }
}

function question(value: unknown, name: string): asserts value is string {
  textField(value, name);
  if (!QUESTION_IDS.has(value)) throw new Error(`${name} is not a supported semantic question`);
}

function key(eventId: string, questionId: string): string {
  // JSON encoding avoids collisions when user-provided IDs contain separators.
  return JSON.stringify([eventId, questionId]);
}

function eventGroup(eventId: string): string {
  // The shadow exporter appends a SHA-256 request key to preserve revisions.
  // Revisions of one source event must not cross the development/holdout split.
  return /^(.*)@[a-f0-9]{64}$/.exec(eventId)?.[1] ?? eventId;
}

function validatePrediction(value: unknown, index: number): asserts value is SemanticPrediction {
  const name = `prediction[${index}]`;
  record(value, name);
  exactKeys(value, ["eventId", "questionId", "choice", "probabilities", "model", "promptVersion", "observedAt", "decidedAt"], name);
  for (const field of ["eventId", "choice", "model", "promptVersion"]) textField(value[field], `${name}.${field}`);
  question(value.questionId, `${name}.questionId`);
  timestamp(value.observedAt, `${name}.observedAt`);
  timestamp(value.decidedAt, `${name}.decidedAt`);
  if (value.observedAt > value.decidedAt) throw new Error(`${name} uses a future observation after its decision`);
  record(value.probabilities, `${name}.probabilities`);
  const entries = Object.entries(value.probabilities);
  if (entries.length < 2 || entries.length > 255) throw new Error(`${name} needs 2 to 255 probability classes`);
  const expectedClasses = Object.keys(QUESTIONS[value.questionId].criteria).sort();
  if (JSON.stringify(entries.map(([label]) => label).sort()) !== JSON.stringify(expectedClasses)) {
    throw new Error(`${name} has missing or unexpected probability classes`);
  }
  let total = 0;
  for (const [label, probability] of entries) {
    textField(label, `${name} probability class`);
    if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) {
      throw new Error(`${name} probabilities must be finite numbers in [0, 1]`);
    }
    total += probability;
  }
  if (Math.abs(total - 1) > PROBABILITY_TOLERANCE) throw new Error(`${name} probabilities must sum to 1`);
  if (!Object.hasOwn(value.probabilities, value.choice as string)) throw new Error(`${name} choice is absent from probabilities`);
  const chosen = value.probabilities[value.choice as string] as number;
  if (entries.some(([, probability]) => (probability as number) > chosen + PROBABILITY_TOLERANCE)) {
    throw new Error(`${name} choice must have maximum probability (ties are allowed)`);
  }
}

function validateLabel(value: unknown, index: number): asserts value is SemanticLabel {
  const name = `label[${index}]`;
  record(value, name);
  exactKeys(value, ["eventId", "questionId", "label", "split", "labelledAt"], name);
  textField(value.eventId, `${name}.eventId`);
  question(value.questionId, `${name}.questionId`);
  textField(value.label, `${name}.label`);
  if (!Object.hasOwn(QUESTIONS[value.questionId].criteria, value.label)) {
    throw new Error(`${name} label is outside the question's allowed classes`);
  }
  if (value.split !== "development" && value.split !== "holdout") throw new Error(`${name} has an invalid split`);
  timestamp(value.labelledAt, `${name}.labelledAt`);
}

function metrics(pairs: readonly { prediction: SemanticPrediction; label: SemanticLabel }[]): SemanticMetrics {
  let correct = 0, brierSum = 0, logLossSum = 0, zeroProbabilityLabels = 0;
  for (const { prediction, label } of pairs) {
    if (prediction.choice === label.label) correct++;
    for (const [option, probability] of Object.entries(prediction.probabilities)) {
      brierSum += (probability - Number(option === label.label)) ** 2;
    }
    const probability = prediction.probabilities[label.label];
    if (probability === 0) zeroProbabilityLabels++;
    else logLossSum -= Math.log(probability);
  }
  const sampleSize = pairs.length;
  return { sampleSize, correct, accuracy: sampleSize ? correct / sampleSize : null,
    multiclassBrier: sampleSize ? brierSum / sampleSize : null,
    logLoss: !sampleSize ? null : zeroProbabilityLabels ? "infinity" : logLossSum / sampleSize,
    zeroProbabilityLabels };
}

/**
 * Pure, deterministic evaluation of one model/prompt cohort. All supplied rows
 * are validated before selecting a split. No network, clock or file access.
 * "No future observations" means observedAt <= decidedAt; caller-supplied
 * timestamps do not independently prove source availability or blinded labels.
 */
export function evaluateLabels(
  predictions: readonly SemanticPrediction[],
  labels: readonly SemanticLabel[],
  split: EvaluationSplit,
): SemanticEvaluation {
  if (!Array.isArray(predictions) || !Array.isArray(labels)) throw new Error("Predictions and labels must be arrays");
  if (split !== "development" && split !== "holdout") throw new Error("Invalid evaluation split");
  const predictionByKey = new Map<string, SemanticPrediction>();
  const labelByKey = new Map<string, SemanticLabel>();
  const classesByQuestion = new Map<string, string[]>();
  const observationsByEvent = new Map<string, number>();
  const splitByEvent = new Map<string, EvaluationSplit>();
  const firstLabelByEvent = new Map<string, number>();
  let cohort: SemanticEvaluation["cohort"] = null;

  for (const [index, prediction] of predictions.entries()) {
    validatePrediction(prediction, index);
    const rowKey = key(prediction.eventId, prediction.questionId);
    if (predictionByKey.has(rowKey)) throw new Error(`Duplicate prediction for ${rowKey}`);
    predictionByKey.set(rowKey, prediction);
    if (cohort && (cohort.model !== prediction.model || cohort.promptVersion !== prediction.promptVersion)) {
      throw new Error("Mixed model or promptVersion cohorts must be evaluated separately");
    }
    cohort = { model: prediction.model, promptVersion: prediction.promptVersion };
    const classes = Object.keys(prediction.probabilities).sort();
    const previousClasses = classesByQuestion.get(prediction.questionId);
    if (previousClasses && JSON.stringify(previousClasses) !== JSON.stringify(classes)) {
      throw new Error(`Inconsistent probability classes for ${prediction.questionId}`);
    }
    classesByQuestion.set(prediction.questionId, classes);
    const observedAt = observationsByEvent.get(prediction.eventId);
    if (observedAt !== undefined && observedAt !== prediction.observedAt) {
      throw new Error(`Inconsistent observation timestamp for event ${prediction.eventId}`);
    }
    observationsByEvent.set(prediction.eventId, prediction.observedAt);
  }

  for (const [index, label] of labels.entries()) {
    validateLabel(label, index);
    const rowKey = key(label.eventId, label.questionId);
    if (labelByKey.has(rowKey)) throw new Error(`Duplicate or conflicting label for ${rowKey}`);
    labelByKey.set(rowKey, label);
    const group = eventGroup(label.eventId);
    const previousSplit = splitByEvent.get(group);
    if (previousSplit !== undefined && previousSplit !== label.split) {
      throw new Error(`Event ${label.eventId} occurs in both development and holdout splits`);
    }
    splitByEvent.set(group, label.split);
    firstLabelByEvent.set(group, Math.min(firstLabelByEvent.get(group) ?? Infinity, label.labelledAt));
    const classes = classesByQuestion.get(label.questionId);
    if (classes && !classes.includes(label.label)) throw new Error(`Label outside probability classes for ${rowKey}`);
  }

  const selectedLabels = labels.filter((label) => label.split === split);
  const pairs = selectedLabels.flatMap((label) => {
    const prediction = predictionByKey.get(key(label.eventId, label.questionId));
    return prediction ? [{ prediction, label }] : [];
  }).sort((a, b) => key(a.label.eventId, a.label.questionId).localeCompare(key(b.label.eventId, b.label.questionId)));
  const unlabelledPredictions = predictions.filter((prediction) => !labelByKey.has(key(prediction.eventId, prediction.questionId))).length;
  const predictionsInOtherSplit = predictions.filter((prediction) => {
    const label = labelByKey.get(key(prediction.eventId, prediction.questionId));
    return label !== undefined && label.split !== split;
  }).length;
  const eventIds = [...new Set(selectedLabels.map((label) => label.eventId))].sort();
  const matchedEvents = new Set(pairs.map(({ label }) => label.eventId));
  const missingEvents = new Set(selectedLabels.filter((label) => !predictionByKey.has(key(label.eventId, label.questionId))).map((label) => label.eventId));
  const affectedRows = pairs.filter(({ prediction }) => firstLabelByEvent.get(eventGroup(prediction.eventId))! <= prediction.decidedAt);
  const perQuestion = [...QUESTION_IDS].sort().map((questionId): QuestionEvaluation => {
    const questionLabels = selectedLabels.filter((label) => label.questionId === questionId);
    const questionPairs = pairs.filter(({ label }) => label.questionId === questionId);
    const classes = Object.keys(QUESTIONS[questionId].criteria).sort();
    const counts = new Map<string, number>(classes.map((label) => [label, 0]));
    for (const { label } of questionLabels) counts.set(label, (counts.get(label) ?? 0) + 1);
    return { questionId, classes: [...classes], labelledRows: questionLabels.length,
      missingPredictions: questionLabels.length - questionPairs.length,
      predictionCoverage: questionLabels.length ? questionPairs.length / questionLabels.length : null,
      labelCounts: Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b))), ...metrics(questionPairs) };
  });

  return {
    scope: "SEMANTIC_LABEL_EVALUATION_NOT_TRADING_PROBABILITY", split, cohort,
    coverage: { suppliedPredictions: predictions.length, labelledRows: selectedLabels.length, matchedRows: pairs.length,
      missingPredictions: selectedLabels.length - pairs.length, unlabelledPredictions, predictionsInOtherSplit,
      predictionCoverage: selectedLabels.length ? pairs.length / selectedLabels.length : null,
      labelledEvents: eventIds.length, eventsWithPredictions: matchedEvents.size,
      fullyPredictedEvents: eventIds.filter((eventId) => !missingEvents.has(eventId)).length },
    overall: metrics(pairs), perQuestion,
    blinding: {
      status: split === "development" ? "DEVELOPMENT_RETROSPECTIVE_DIAGNOSTIC"
        : !pairs.length ? "NO_MATCHED_HOLDOUT_PREDICTIONS"
          : affectedRows.length ? "INVALID_BLINDED_HOLDOUT_RETROSPECTIVE"
            : "CHRONOLOGY_COMPATIBLE_HOLDOUT_NOT_PROOF_OF_PROSPECTIVE_COLLECTION",
      rowsWithEventLabelAtOrBeforeDecision: affectedRows.length,
      affectedEventIds: [...new Set(affectedRows.map(({ label }) => label.eventId))].sort(),
      prospectiveCollectionVerified: false,
    },
    limitations: [
      "Semantic label agreement and proper scoring rules do not estimate trading win probability, P&L, or profitable edge.",
      "Small or synthetic samples are diagnostics only; no sample size in this report automatically qualifies a model.",
      "Only supplied labels define coverage; an omitted candidate cannot be detected without a separately frozen manifest.",
      "Timestamp order is checked against the decision, not a wall clock. Source availability and timestamp authenticity require external evidence.",
      "Later labels do not prove blinding, prospective collection, an untouched holdout, or absence of model training-data leakage.",
      "Retrospective sources may be known to the model. Forward shadow collection and independently retained records remain required.",
      "Aggregate scores weight matched question rows equally; shared-event questions are correlated, and missing predictions can bias results.",
      "Trading comparisons require separate exact-contract, ordered entry/exit, fill and cost evidence; that evaluator is not implemented here.",
    ],
  };
}
