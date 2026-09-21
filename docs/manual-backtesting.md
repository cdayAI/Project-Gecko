# Auditable manual-desk diagnostics

Two independent tools are supplied. Neither imports the live trading orchestrator, broker factory, order router, `.env`, or an LLM. Neither places orders.

1. `manual-backtest-cli.ts` tests a fixed **underlying-only** opening-range hypothesis using actual public historical five-minute bars. It never manufactures option premiums or calls stock P&L option P&L.
2. `manual-options-replay-cli.ts` can replay one frozen, exact-contract desk plan against recorded option quotes. It is not a strategy optimizer, portfolio options backtester, or fill record. Actual historical option evidence is currently missing.

## Commands

From the repository root:

```sh
node --import tsx src/backtest/manual-backtest-selftest.ts
node --import tsx src/backtest/manual-options-selftest.ts
node --import tsx src/backtest/manual-backtest-cli.ts --start=2026-08-03 --end=2026-09-17 --symbols=SPY,QQQ,TSLA
node --import tsx src/backtest/manual-backtest-cli.ts --replay=data/backtests/manual-2026-09-17T17-53-41-131Z
```

Dates specify Eastern session dates. `--end` is exclusive; the current ET session is never included. Fetching uses the unchanged `YahooHistoricalBars` downloader with caching off. Dates must lie inside its bounded recent intraday window. Defaults are the last 45 calendar days ending before today's session, SPY/QQQ/TSLA. A failed symbol is recorded and makes the command exit with code 2; no other provider, synthetic sample, or daily data is substituted.

The replay command performs no network calls. It checks plan/input byte hashes, re-evaluates saved inputs, and requires identical results. Source hashes record the implementation at first capture. A later code correction is not silently represented as the original implementation; inspect recorded hashes when comparing runs. Hashes provide corruption/change detection, not a trusted external timestamp or proof that data are authentic.

## Fixed underlying hypothesis

This is a deliberately small test of price behavior, not the complete legacy strategy or the discretionary trades discussed in chat. Parameters were specified before the first download and were not tuned after seeing results.

| Rule | Setting |
|---|---|
| Universe | SPY, QQQ, TSLA fixed before retrieval |
| Direction | Long shares only; no borrowing, margin, or short positions |
| Opening range | Three complete five-minute bars, 09:30 to 09:45 ET |
| Range eligibility | Width 0.1% to 5% of range midpoint |
| Signal | First completed post-range five-minute close strictly above range high |
| Earliest possible entry | 09:50 ET at immediate next bar open, never at signal close |
| Entry cutoff | 11:00 ET, exclusive |
| Chase cap | Next raw open above range high and at most 0.25 range widths above it |
| Invalidation | Opening range low |
| Target | Entry including friction plus twice its distance to range low |
| Time exit | 11:30 ET opening price |
| Sizing | $25 planned stop loss including modeled costs, $1,000 notional cap, available cash, integer shares |
| Portfolio | One position across all symbols; simultaneous signals use alphabetical tie-break |
| Reentry | At most the first signal per symbol per session, even if rejected |
| Daily loss gate | Refuse new entries after $50 realized daily loss; gap losses can exceed a planned stop |
| Costs | Adverse 2 basis points per side with a $0.005/share minimum, plus $1/order |
| Split | First 70% of requested calendar interval discovery, final 30% chronological holdout; fresh $5,000 portfolio in each |

The cost settings are explicit conservative research assumptions. They are not Webull fee quotes, calibrated spreads, or measured fill quality. No catalyst, premarket gap, VWAP, event, or market-regime filter is claimed.

## Event order and missing data

All symbols share one chronological event stream. At each timestamp:

1. Previous bars finish. Only now can their high, low, and close resolve an intrabar stop/target or generate a signal. Ambiguous bars touching both stop and target use stop first.
2. Any scheduled time exit uses the new bar's open before examining that bar's later extrema. A stop gapped through fills at the worse open plus adverse exit friction. Favorable target gaps receive no price improvement.
3. Qualifying pending signals may fill at the immediate next bar open subject to existing exposure, realized daily losses, cash, size and chase limits. Future intrabar profits cannot finance another entry at the same open.
4. Five-minute liquidation equity is marked using adverse exit friction and fees. Reported drawdown is explicitly sampled, not a claim about worst intrabar drawdown.

Intrabar fill timestamps are unknown from OHLC bars; simulated exits are recognized at bar close, with the source interval start retained. This conservatively delays recycling cash. A crossed high/low still does not prove a fill or available liquidity.

Malformed/duplicate bars cause a failure. A missing opening bar or a later observed discontinuity disables new signals for that symbol/session. Missing immediate next bars expire pending signals. A held position encountering a gap closes at the first available open with reason `data-gap`, not at an invented stop price. If the input ends while held, the position remains explicitly unresolved and portfolio completion fails. Missing whole sessions cannot be separated from holidays without an exchange calendar.

## Actual first run

Evidence directory: `data/backtests/manual-2026-09-17T17-53-41-131Z`.

Plan persisted at 2026-09-17 17:53:41 UTC before retrieval. Each of SPY, QQQ and TSLA returned **2,496 actual five-minute bars**, spanning August 3 through September 16, 2026. Total 7,488 normalized bars across 32 sessions. Holdout starts September 3. No symbol failed and no position was unresolved.

| Partition | Sessions | Trades | Gross before modeled costs | Slippage | Fees | Net | Win rate | Profit factor |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Discovery | 23 | 15 | $15.37 | $4.61 | $30.00 | **-$19.24** | 33.33% | 0.59 |
| Holdout | 9 | 7 | $4.60 | $1.92 | $14.00 | **-$11.33** | 28.57% | 0.39 |

This small hypothesis **did not show positive after-cost performance** in either partition under the declared model. It does not establish that options or another ORB definition would win or lose. The holdout is now observed; it is no longer an unseen test set for future tuning. No annualized Sharpe, confidence score, probability forecast, or deploy/readiness claim is emitted.

Artifacts include the pre-fetch plan, source-file hashes, normalized bar files, per-input hashes and timestamps, complete simulated trades/events, a human-readable report and manifest. The existing downloader does not expose raw HTTP response bodies, so raw response retention is not claimed. Generated data remain local under the repository's existing data ignore rule.

## Exact-contract option replay

```sh
node --import tsx src/backtest/manual-options-replay-cli.ts --plan=path/to/single-plan.json --frames=path/to/quotes.jsonl
```

The plan uses `src/desk/types.ts` `ManualPlan`, passed through the desk's `parsePlan`. Frames use its `QuoteFrame`. The input is a single plan object, not an entire desk configuration. The pure API is:

```ts
replayManualOption(plan, frames, configOverrides?)
```

This mode supports long calls or long puts with same-session exits and expiration after the session. It requires the plan creation timestamp to precede every supplied observation. Receipt times must strictly increase; the runner never sorts a misordered recording into apparent validity. A first qualifying observation generates a signal; entry cannot happen until a subsequent qualifying frame. Entry uses its ask plus $0.01/share adverse slippage, bounded by maximum entry premium. Exits use observed bid minus $0.01/share, with $0.10/contract/side modeled fees. Default full premium risk cap is $250 and planned risk cap $50; those are declared replay defaults, not verified broker policy.

The model requires exact contract identity, verified standard 100-share multiplier, non-delayed option provenance, per-quote timestamps, synchronized fresh underlying last/quotes and positive quoted sizes sufficient for the proposed quantity. Entry spread qualification uses the research quote-quality gate. A wide exit spread is not a reason to pretend liquidation is unavailable when a valid bid exists; the adverse observed bid is used. No midpoint fill, expiration payoff, or option price inferred from a stock move is used.

Missing/invalid exit data or a frame gap exceeding 10 seconds while held terminates the replay as **UNRESOLVED_DATA_GAP**, with P&L `null`; later favorable quotes do not cure the missing path. Ending before an exit gives **UNRESOLVED_OPEN_POSITION**, also with P&L `null`. Even continuously sampled quotes cannot prove that an unobserved trade, stop trigger or quote change did not occur between samples. Tick or event-driven quote histories improve fidelity.

Plans requiring news return **BLOCKED_NEWS_EVIDENCE** because this small quote-only replay does not yet ingest timestamped news availability. They are not silently treated as news-qualified. Synthetic frames are rejected unless `--allow-synthetic` is explicitly supplied, then the result is labeled **SYNTHETIC_ENGINE_TEST_NOT_PERFORMANCE**. Normal recordings are labeled **HYPOTHETICAL_QUOTE_REPLAY_NOT_EXECUTED**. No actual historical option performance has been produced in this work; the option selftests are engineering fixtures only.

## Data needed to backtest options meaningfully

- Point-in-time contract listings including expiration, strike, call/put, multiplier, corporate-action adjustments, and when each contract became available.
- Historical option bid/ask and displayed size with exchange timestamps and receipt/availability timestamps, plus feed/entitlement identity. Delayed quotes cannot be relabeled live. Last trades alone are insufficient.
- Synchronized underlying quotes/trades and timestamped bars for triggers and invalidation. Do not pair current stock prices with stale option premiums.
- IV and Greeks at the decision time if selection uses them, including methodology; prior-session OI explicitly dated. Never use today's OI to select yesterday's trade.
- Catalyst and macro data with publication and first-seen timestamps. Later revised values must not leak into historical decisions.
- Broker fee schedules, measured or defensible fill/slippage rules, liquidity checks, contract adjustments, assignment/exercise and expiration treatment for any mode extending beyond same-session long-option exits.
- A frozen strategy/contract-selection specification, a point-in-time eligible universe, sufficient diverse history, discovery/holdout boundaries, and records of all attempted variants. Multiple hand-picked winners are not a backtest.

## Legacy audit observations

Legacy paths are unchanged. The standalone diagnostic does not certify them:

- `src/backtest/runner.ts` processes a complete symbol history before the next symbol. Compounding its results into the next symbol can put later realized outcomes into earlier historical sizing. Its `maxTradesPerDay` option is declared but not enforced.
- That runner filters trigger bars strictly before 11:30 while testing a time exit at or after 11:30 inside the filtered set. The scheduled time branch is unreachable; the fallback uses the last available close.
- Both legacy runners record the signal bar's start as entry time despite pricing from the next bar open. This confuses availability and fill timestamps.
- `backtest-yahoo-cli.ts` describes chronological candidate selection but loops the supplied symbol list and increments a daily `opened` count; it does not merge actual position lifetimes or entry times across symbols.
- Legacy stop fills use the stop level plus a fixed tick even when the next open gaps through it. The Yahoo path checks cutoff-bar highs/lows before a scheduled exit, admitting information after the desired exit time.
- Legacy sizing does not impose a shared cash/notional cap; no explicit commissions/fees are subtracted. Neither path establishes options returns.

The standalone selftests cover event chronology, next-bar execution, portfolio tie ordering, no future suffix influence, scheduled exits, ambiguous-bar ordering, gap-through stops, missing data, malformed bars, costs, cash/risk caps and byte-hash verification. Option tests separately cover next-frame ask/bid arithmetic, missing paths, future/delayed quotes, sizes, plan availability, identity, premium risk and synthetic labeling.
