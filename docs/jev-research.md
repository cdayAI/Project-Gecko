# Jev research integration

Prepared September 19, 2026 for manual Project Gecko research. The user's encrypted-key connection probe succeeded at 20:47:36 UTC (16:47:36 EDT), using `jev-1.13.0` and returning all six expected answer schemas. One request used 1,406 input tokens and took approximately 402 ms at the client. Model quality and trading benefit remain unverified. No monitor, order path or paid news feed is enabled. Evidence is retained in the workspace's `outputs/jev-setup/20260919-connection-verified.json`; original setup validation remains separate.

## Start here

From this checkout in a local PowerShell terminal:

```powershell
.\scripts\Invoke-Jev.ps1 -Mode status
.\scripts\Invoke-Jev.ps1 -Mode demo
```

The status command reads saved source health and eligible event counts. It does not verify a live connection. The demo uses synthetic text and handwritten responses; it proves integration behavior, not Jev accuracy. Each demo goes into a separately labelled directory.

When the key is available, enter it only in the hidden local prompt:

```powershell
.\scripts\Set-JevKey.ps1
```

After authorizing one inference request, test the connection:

```powershell
.\scripts\Invoke-Jev.ps1 -Mode probe -MaxRequests 1
```

The probe sends a small synthetic example to TypeSafe and saves the model, validated answer schema, usage and latency. It runs independently of market hours or news freshness. A successful probe establishes only the sampled authenticated inference route. It is not trading validation. See [credential handling](jev-credentials.md).

## Bounded research workflow

1. Run the existing attributed news collector for the selected universe and entitled sources. See [news pipeline](news-pipeline.md). Do not assume existing saved health is current or that a source returns complete coverage.
2. Run the semantic layer against newly collected, age-eligible events:

```powershell
.\scripts\Invoke-Jev.ps1 -Mode live -MaxRequests 10 -MaxEvents 20 -MaxAgeMinutes 1440
```

3. Read `data/jev/review-<run-id>.md` and `run-<run-id>.json`. The append-only `evaluations.jsonl` retains source evidence, question/model versions, source and observation times, attempts, interpreted labels, usage and errors. Every result remains research only; none qualifies an entry.
4. Continue quote, contract, price-action, risk and contrary-evidence checks through the existing manual workflow. This module does not replace its report gate.

One model call batches six narrow Choice questions: catalyst, management guidance, commercial commitment, potential share issuance, relation to a supplied thesis, and evidence scope. The adapter requests the pinned `jev-1.13.0`, validates the returned model and every answer, and rejects unexpected schemas rather than filling gaps. A semantic label probability is not a trade probability.

Source input uses the existing `NewsLedger`. Its default text consists of headlines, social posts or filing notices. Full articles and filing bodies are not automatically retrieved. The code preserves that limitation in the model state and research report. Dates, age and bounds are checked in code. Source publication, receipt, first observation and model decision remain distinct.

## Optional attributed excerpts and thesis

Supply newline-delimited JSON records with these exact fields (values below are synthetic):

```json
{"eventId":"source-event-id-from-ledger","sourceUrl":"https://example.com/source","observedAt":1789821000000,"text":"Exact source excerpt here.","scope":"primary_excerpt","thesis":"Optional explicit hypothesis to challenge"}
```

`scope` is `primary_excerpt` or `secondary_excerpt`; `thesis` is optional. The source URL must match the event URL and observation time cannot be in the future. This is provenance supplied by the operator, not automatic source verification. Preserve genuine observation times; do not backdate a later-discovered document. Use `-EvidenceFile excerpts.jsonl`. Input length is bounded and oversized documents must be deliberately excerpted. The system does not follow arbitrary embedded URLs or instructions.

## Failure and cost controls

- Offline status is default; key presence alone does not send a request.
- Live and probe modes require explicit request allowance. Each POST is reserved durably before transport. A whole-run lock prevents concurrent writers in one output directory.
- A request cap applies to that invocation, not to all processes or an account-wide dollar budget. Starting another invocation creates another allowance. No automatic process restart is configured.
- There are no automatic retries. Any provider failure stops further calls in the batch. A crash, timeout or malformed successful response leaves the attempt unresolved and blocks automatic repeat for that exact event/question/input combination. Inspect the journal and provider usage before any deliberate retry; do not delete evidence to make the result look successful. Some explicit HTTP rejections permit a later manually invoked retry.
- Requests are limited to 12,000 UTF-8 bytes, responses to 256 KiB, and total transport time to 10 seconds. Response/credential contents never appear in error logs.
- Completed unchanged requests are cached by event content, full model request, model/question version and excerpt context. Cached events do not consume the next work batch. Changed evidence is a new recorded evaluation.
- The estimate uses the published $0.042 per million input tokens, excluding other providers and unreported usage of failed/uncertain attempts. It is an input-only accounting estimate, not a guaranteed bill or spending ceiling. An approved sustained-run budget remains to be configured.
- A run report is a historical snapshot. There is no background collector, news subscription, scheduler, notification service or streaming feed created by this setup.

## Compare quality before using results to rank trades

```powershell
npm run jev -- --export --directory data/jev --output data/jev/predictions-new.jsonl
npm run jev -- --evaluate --predictions data/jev/predictions-new.jsonl --labels labels.jsonl --split holdout --output data/jev/evaluation-new.json
```

Output paths must be new. Synthetic demos and connection probes cannot be exported as live predictions. Versioned event IDs retain every input variant; the evaluator groups source-event variants to prevent split leakage. Labels are independently adjudicated; model responses are not ground truth. See [evaluation methodology](jev-evaluation.md) and the explicitly synthetic label schema example under `fixtures/jev-labels.example.jsonl`.

The evaluator measures label coverage, accuracy, multiclass Brier score and log loss, and flags invalid blinded-holdout chronology. It does not train a trade-ranking model, backtest options returns or generate win rates. Those steps require a sufficient independently labelled corpus, predeclared strategy rules, executable option histories and forward outcomes. All candidates, including failures and rejected setups, must be retained in that later experiment.

## Local verification

```powershell
npm run jev:selftest
.\scripts\Test-JevKeyStorage.ps1
npm run check:manual
```

The manual check includes Jev tests and inspects the import graph for broker/execution paths. These are offline component checks. `Test-JevKeyStorage.ps1` uses a synthetic key in an isolated temporary profile; it does not touch the actual vault. No hosted CI or repository publication is required for this local setup.

## Official contract references

- [TypeSafe HTTP API](https://docs.typesafe.ai/api)
- [Current model/version and pricing](https://docs.typesafe.ai/models)
- [Confidence interpretation](https://docs.typesafe.ai/confidence)
- [Known model limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13)

Docs checked September 19, 2026. Provider updates can require an explicit adapter/prompt revision and renewed evaluation.
