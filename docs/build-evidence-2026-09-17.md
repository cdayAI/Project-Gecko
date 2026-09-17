# Manual research desk implementation evidence

Date: September 17, 2026. Local branch: `codex/manual-trading-desk`, built on the unmerged research PR head `33a07c6219ae54d3a1e29a26dddb04bdff944aee`.

## Built and checked

| Workstream | Implemented | Evidence and boundary |
|---|---|---|
| Read-only Webull | Actual IV field, per-quote provenance, exact standard100 contract references, data-only fixed hosts/routes, endpoint pacing, bounded retries | 4 signing, 26 quality and 24 parser/transport checks; observed sanitized fixtures. TypeScript authentication not run |
| Options shortlist | At most five roots with exact contracts, affordability/delta/liquidity/freshness gates, explicit rejection reasons and countercases | 47 fixture checks. Mechanical ranking, not confidence or proven alpha; bounded optional live refresh |
| Manual monitor | Versioned plans, local board and alerts, time/price invalidation, latched exit warnings, expiring eligibility, quote recording, persistent daily halt | Included in 26 desk checks; 7-frame synthetic demo and isolated CLI replay passed |
| Manual journal | Actual-fill import, execution-ID dedupe/conflict detection, FIFO partial closes, allocated fees, actual open exposure and net realized reports | Included in desk checks. Standard100 long-option scope; broker CSV mapping/account synchronization not established |
| News/events | Yahoo, SEC, X and Benzinga adapters; source links, publication/receipt times, versioning, deduplication, point-in-time reads and health | 50 deterministic checks; authenticated paid feeds not exercised |
| Continuous news polling | Explicit foreground watch, no overlapping polls, minimum60s interval, paid-source request/cycle budgets, shutdown health | Included in news tests. No collector left running |
| Backtesting | Fixed chronological underlying diagnostic; hashed evidence, next-open fills, costs, gap and same-bar ambiguity rules | 12 synthetic engine checks plus actual historical run and exact replay |
| Options quote replay | Frozen exact-contract plan, next-frame ask entry, bid exit, declared friction, data gaps leave P&L unknown | 8 synthetic engine checks. Historical option quote dataset absent |

`npm run check:manual` completed successfully at approximately 18:13 UTC. TypeScript compilation passed and the manual monitor's local import graph (20 modules) did not reach broker implementations, execution modules or the legacy main entry point. Counts total **197 component checks**. The command output is saved locally in `data/validation/manual-2026-09-17.json`; it is not live brokerage acceptance.

Default `npm run dev` and `npm start` now enter the data-only manual desk. The old application remains under explicit `legacy:dev` and `legacy:start` scripts. Its existing deployment configuration and unresolved execution-risk gaps are not qualified by this work.

## Historical result

Fixed SPY, QQQ and TSLA universe. Actual Yahoo five-minute data, August 3 through September 16, 2026. 7,488 bars, 32 sessions. The rules and September3 holdout boundary were persisted before retrieval. No parameter tuning followed the result.

| Partition | Trades | Gross | Modeled slippage and fees | Net |
|---|---:|---:|---:|---:|
| Discovery | 15 | $15.37 | $34.61 | **-$19.24** |
| Holdout | 7 | $4.60 | $15.92 | **-$11.33** |

These are **hypothetical underlying-share returns, not options returns**. Costs are declared assumptions (2bps/side with a minimum per-share slippage, plus $1/order), not a Webull fee quote. The simple hypothesis did not show positive after-cost results. The holdout is now observed and must not be reused as unseen evidence after strategy changes.

Evidence: `data/backtests/manual-2026-09-17T17-53-41-131Z/`. It includes a pre-fetch plan, source hashes, timestamped normalized data and hashes, simulated events/trades, report and manifest. Exact replay reproduced all 22 trades. No failed symbols or unresolved positions were reported. See [methodology](manual-backtesting.md).

## Actual news read

At 18:12:27 UTC, the new Yahoo adapter requested headlines for TSLA, NVDA, AMD, HOOD and SMCI. It received50 results, accepted22 eligible rows, appended21 attributed events, deduplicated1 and rejected28 on relevance/age/attribution filters. Records and source health are in local `data/news/`. This is a functioning best-effort source, not proof of guaranteed real-time news delivery or complete coverage.

## Current operation and external prerequisites

The starter configuration exists at `data/desk/config.json`, with $5,000 planning equity, no active plans, unknown buying power/reconciliation and unverified options permission. The local doctor found no Webull app key/secret, X bearer token or Benzinga key in this checkout's environment. Earlier session credentials were used in a separate transient probe and were not written into this project. No credentials were persisted by this implementation.

No continuous service is running, no paid provider is activated, and no orders or outbound group messages were sent. Data artifacts remain local under the existing ignored `data/` directory. Source changes remain local until separately published; no remote CI was triggered.

Remaining work is concrete:

1. Supply existing credentials through the local secret environment and perform bounded authenticated acceptance of this TypeScript adapter; verify feed and account-specific permissions without placing orders.
2. Establish historical option bid/ask and underlying data coverage, including costs, expirations and survivorship. Sparse snapshots and share OHLC cannot establish options expectancy.
3. Define additional strategy hypotheses and evaluate new, untouched periods. Do not promote the negative first ORB diagnostic into live alerts.
4. Connect validated intraday strategy triggers and attributed evidence review to plan creation. The shortlist and explicit-plan monitor exist, but automatic strategy-to-plan generation and new model calls are not active.
5. Qualify broker-specific manual-fill import or read-only account reconciliation, notification delivery to the operator, holiday calendars, operational retention and supervised deployment.
6. Add multi-leg and overnight lifecycle as separately tested extensions. Current desk support is standard100 long calls/puts, with same-session exits and expiry after the session.

The [manual runbook](manual-trading-desk.md), [news guide](news-pipeline.md), [picker guide](options-picker.md) and [backtest guide](manual-backtesting.md) specify commands, limitations and file formats.
