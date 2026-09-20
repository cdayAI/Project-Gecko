# Bounded foreground Jev news review

The new `--watch` consumer can classify newly saved news while a separate collector runs. This is near-real-time ledger polling, not an exchange/news streaming entitlement and not an order engine. It imports no broker or execution code. Nothing starts automatically on install, login, build or status inspection.

The pipeline is: authorized source collector → attributed NewsLedger → fresh-event/health gate → Jev classification → append-only local research alert → separate source verification, Schwab quote and trade-plan checks → human decision.

## What is implemented

- Default 1-second file polling, 5-minute maximum source publication age and 180-second maximum health age. Source must be explicitly allowed and its latest health must be `ok` or `partial`. Missing, failed, future or stale health blocks that source. A healthy collector does not establish a provider latency guarantee or complete coverage.
- Date-only publication surrogates, future evidence, duplicate/syndicated events and stale stories cannot trigger inference. A late story does not become fresh because the collector just downloaded it.
- Changed revisions get different request keys. Unchanged cached evidence causes neither another inference request nor another run/review file. New revisions preserve prior result and alert history.
- The session requires explicit duration, request ceiling, source list and dedicated directory. `session.json` stores the original deadline and configuration. Restarts keep the same deadline and lifetime count of durable reservations. Changed configuration or a missing/corrupt manifest fails closed.
- `.watch.lock` permits one worker; existing shadow `.run.lock` serializes inference. Reservations are synced to disk before transport. Provider failures or unresolved reservations stop the whole session with `REVIEW_REQUIRED`; no automatic retry, even if the error might have been unbilled. The request ceiling is not a dollar ceiling.
- `alerts.jsonl` contains source URL, symbol, claim type, exact source/collection/evaluation/emission times, latency measurements and labels. It explicitly states `headline_only` or `social_commentary`, `sourceClaimVerified:false` and `orderEligible:false`. No buy/sell direction, trading probability or target is derived from a catalyst class.
- Alerts recheck publication age and source health when emitted. A recovered old result is saved as `STALE_FOR_LIVE_REVIEW`, never promoted to a fresh signal. An alert that was fresh at emission also ages; consumers must recheck its timestamps before review.
- `heartbeat.json` shows latest operational status, source-health age, eligible count and remaining allowance. Status inspection additionally requires a fresh heartbeat, an unexpired session and a live lock PID. A killed process, missing lock or stale heartbeat is reported inactive. This observation still does not establish healthy market data.
- Ctrl+C stops between requests and interrupts waiting. An already dispatched Jev request can take up to the client's 10-second timeout. Crash locks are never cleared automatically; inspect the owning process and journal first.

## Explicit bounded run, only after authorizing the allowance

From the repository directory, this example allows at most 20 requests for 30 minutes. It is an example, not a running service or a renewed spending authorization:

```powershell
.\scripts\Invoke-Jev.ps1 -Mode watch -MaxRequests 20 -DurationMinutes 30 -Sources yahoo -NewsDirectory data/news -Directory data/jev-watch/session-20260921-a
```

The DPAPI wrapper loads the existing local key only for the explicit live command and restores its process environment afterward. No key belongs in the command or chat. `-Mode status` is the default, does not load the vault and makes no network request:

```powershell
.\scripts\Invoke-Jev.ps1 -Mode status -NewsDirectory data/news -Directory data/jev-watch/session-20260921-a
```

The worker console prints changing health/status/counts. To see research cards locally, use a second terminal after the first alert creates the file:

```powershell
Get-Content -LiteralPath data/jev-watch/session-20260921-a/alerts.jsonl -Tail 10 -Wait
```

Each JSON line contains the symbol, headline, selected labels, source link, emission timestamp and freshness status. Ctrl+C stops the local viewer. This sends no messages to external services.

Use the identical watch arguments to resume an interrupted session. A finished session cannot acquire another allowance by restarting. A genuinely new session requires a newly authorized request/time allowance and new directory. Do not run ordinary `--live`, probes, demos or other writers against a watch session's `model` subdirectory. A manifest prevents accidental session reset; it is not tamper-proof accounting against a person who edits files.

The worker does not start a collector. The existing `news` CLI supports explicitly bounded polling; collector credentials, rate limits, costs and coverage are separately configured and verified. Yahoo search is a research fallback with unknown delivery latency. X and Benzinga require their own credentials/entitlements; installing this worker does not provide them. `primary` is a curated-source channel, not a new paid news feed. This first watch mode reads headlines already in the ledger; dynamic full-text extraction and per-ticker thesis context are not implemented.

## What still separates this from a trading alert service

The Jev response is a semantic classification of untrusted source claims. It cannot confirm article truth, materiality, novelty already priced in, a technical trigger, a fair option premium or profitable expectancy. The live consumer does not automatically connect to the Schwab quote helper, completed-bar confirmation, current positions, portfolio risk or execution journal. Those independent checks remain mandatory before an actionable manual trade plan. There is no notification transport, dashboard, installed service or scheduled auto-start in this change.

Total reaction time is source publication-to-delivery + collector interval/request latency + file poll wait + Jev latency + verification/market checks + human action. A 229 ms model median from a prior small batch is only one term and is not an end-to-end service guarantee. The worker is deliberately sequential, currently at most one new model request per cycle; concurrency requires separately tested lifetime reservation accounting.

## Local validation

`npm run jev:selftest` includes mocked transport, shadow journal, semantic-evaluation and watch tests. `npm run jev:watch-test` runs the watch tests alone; `npm run check:manual` includes the import-boundary check and watch suite. Fixtures are temporary and synthetic, with no API key reads or network calls. They verify cap/deadline persistence, freshness/source failure, duplicates, revisions, provider failure, stop handling, locks, malformed/mixed state, stale-alert recovery and heartbeat liveness. This validation is not a live feed or trading acceptance test.
