# Offline Jev semantic evaluation

`src/research/jev/evaluation.ts` compares recorded semantic choices with human labels. It performs no network requests, reads no files, consults no clock, and changes no inputs. Its pure entry point is:

```ts
evaluateLabels(predictions, labels, "development" /* or "holdout" */)
```

This evaluates interpretation of supplied evidence. It does not estimate the probability of a profitable trade, calculate P&L, validate a strategy, or establish that source claims are true. A correct `raised` guidance classification can coexist with a losing option trade.

## Input records

Each prediction has exactly these fields:

```json
{"eventId":"source-id@request-sha256","questionId":"dilution","choice":"present","probabilities":{"present":0.8,"denied":0.1,"unknown":0.1},"model":"jev-1.13.0","promptVersion":"gecko-evidence-v1","observedAt":1789833600000,"decidedAt":1789833601000}
```

Each human label has exactly these fields:

```json
{"eventId":"source-id@request-sha256","questionId":"dilution","label":"present","split":"holdout","labelledAt":1789833602000}
```

All times are UTC Unix milliseconds. `observedAt` is when the evidence was first observed, including any later supplied excerpt; `decidedAt` is the actual prediction-record time. `labelledAt` is the actual annotation time, never a copied article timestamp or a convenient later date. The examples above are illustrative, not measurements.

Question IDs and their complete class sets come from `QUESTIONS` in `questions.ts`: `catalyst`, `guidance`, `commitment`, `dilution`, `thesis_relation`, and `evidence_scope`. Preserve `unknown` when the supplied text cannot support a label. Label the exact question and available evidence, not later outcomes or a preferred trading thesis.

`fixtures/jev-labels.example.jsonl` contains twelve fabricated labels over two fabricated events. It is a schema template only, with no corresponding measured Jev predictions. Its IDs intentionally identify synthetic data. Copy actual IDs from a live prediction export when preparing a real label set; do not rename synthetic data to appear live. The evaluator's minimal input schema cannot authenticate provenance.

## Run locally

These commands are offline and require no API key:

```powershell
node --import tsx src/research/jev/evaluation-selftest.ts
node --import tsx src/research/jev/jev-cli.ts --evaluate --predictions predictions.jsonl --labels labels.jsonl --split holdout --output new-semantic-report.json
```

The CLI reads JSONL and optionally writes a new report file; the pure function itself does neither. Run each model and prompt version separately. The tests use handwritten synthetic probabilities and labels and do not call Jev or establish model accuracy.

## Metrics and coverage

- **Accuracy:** exact chosen-label agreement divided by matched prediction/label rows.
- **Multiclass Brier:** average of `sum((p[class] - indicator[class == label]) ** 2)` across rows, with no division by number of classes. Its range for exact probability distributions is 0 to 2; smaller is better.
- **Log loss:** average `-ln(p[label])`, using natural logarithms. If any true label received zero probability, the result is the JSON-safe string `"infinity"`; `zeroProbabilityLabels` counts such rows. Probabilities are never silently clipped.
- **Sample size:** matched question rows, not independent market events or trades. Multiple questions about one source are correlated. Overall metrics weight matched rows equally.
- **Coverage:** selected-split labels, matched rows, missing predictions, prediction coverage, labelled events, partially/fully covered events, unmatched predictions of unknown split, and predictions belonging to the other split. All six questions appear separately. `labelCounts` describes all supplied labels for that question, including those without predictions.

Empty metric samples return `null`, not zero error or perfect accuracy. A denominator with no labels produces `null` coverage; labels with no predictions produce zero coverage. Missing predictions are not silently counted as successful. Coverage is relative to the supplied label manifest: entirely omitted events or labels cannot be discovered by this function. Freeze the intended candidate manifest separately and retain failed/skipped records.

The probability sum tolerance is 0.0001, matching the transport validator's rounding tolerance. Values must individually be finite and within [0, 1]. Scores use the submitted values without hidden normalization. Every class must be supplied, including zero-probability classes, and the chosen class must have maximum probability within the same tolerance (ties allowed).

## Validation and blinded interpretation

Malformed schemas, invalid timestamps, unsupported classes, duplicate/conflicting rows, observations after decisions, inconsistent observation times for one event, and mixed model/prompt cohorts throw before any report is produced. All rows are validated, including rows outside the selected split. One source event cannot occur in both development and holdout. IDs exported as `sourceEventId@<64 lowercase hexadecimal characters>` are grouped by source ID so changing an excerpt or thesis cannot move another revision into the holdout. Different source IDs referring to the same underlying news still require external grouping.

The report's `blinding.status` makes its limits explicit:

| Status | Meaning |
| --- | --- |
| `DEVELOPMENT_RETROSPECTIVE_DIAGNOSTIC` | Development metrics support iteration; they are not independent holdout evidence. |
| `NO_MATCHED_HOLDOUT_PREDICTIONS` | No holdout metrics are available. |
| `INVALID_BLINDED_HOLDOUT_RETROSPECTIVE` | At least one label for the source event existed at or before a scored prediction. Metrics remain descriptive retrospective diagnostics, but the holdout cannot be claimed as blinded. |
| `CHRONOLOGY_COMPATIBLE_HOLDOUT_NOT_PROOF_OF_PROSPECTIVE_COLLECTION` | Recorded predictions precede labels. This is a necessary chronology check, not proof of concealed labels or a genuinely prospective test. |

The leakage check includes other questions and exported revisions of the same event. Labels earlier than `observedAt` remain usable for retrospective diagnostics and always invalidate a blinded interpretation when matched; they are not silently redated or discarded.

`prospectiveCollectionVerified` always remains `false`. Supplied timestamps cannot prove source availability, authenticity, label concealment, an untouched test set, or absence of pretrained-model knowledge of historical outcomes. The pure function checks observation time against decision time, not against the current wall clock. A trusted collector must establish that neither record was fabricated or future-dated.

## Evaluation protocol and remaining work

1. Freeze a candidate/source manifest, question version, labels policy and development/holdout assignment before reviewing holdout results. Keep related announcements, revisions and issuers grouped as appropriate; the code only enforces the source-event grouping described above.
2. Have independent annotators label the actual supplied evidence, conceal predictions during annotation, adjudicate disagreements, and retain annotation history outside this minimal schema. Record genuine annotation times.
3. Use development data to choose prompts, thresholds and fallback rules. Then score a genuinely untouched holdout. A later label timestamp alone does not establish this process.
4. Measure per-question accuracy and proper scores alongside missed events, false alerts, coverage, cost and latency. Compare the same records against existing review/rule baselines. Brier and log loss are useful scoring rules; they alone do not prove calibrated probabilities. Reliability plots, uncertainty estimates and adequately sized independent samples remain separate analysis.
5. Collect forward shadow predictions with independently preserved timestamps to reduce historical model-knowledge concerns. Keep the model and prompt pinned; do not repeatedly tune against the final holdout.

Small or synthetic samples are diagnostic only. This report has no automatic acceptance threshold, and even a large sample does not qualify a model merely by its size.

A future trading-benefit comparison needs exact contracts, contemporaneous bid/ask data, predeclared entry/exit rules, ordered price paths, executable fill assumptions, fees and spread costs, and a separately held-out/forward comparison under identical capital constraints. Chronological selection, overlapping-horizon leakage controls, and multiple-testing controls would also be needed. That P&L evaluator is intentionally pending; semantic accuracy is not substituted for it.
