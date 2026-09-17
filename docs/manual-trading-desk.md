# Manual trading desk

This entry point collects data, evaluates explicitly versioned options plans, records local alerts, and reconciles manually supplied fills. It never submits, modifies, previews, drafts or cancels broker orders. The user executes in the broker application.

The first implementation supports standard multiplier-100 long calls and puts, same-session exits before 16:00 ET, and expirations after the trading session. Multi-leg execution, 0DTE, overnight lifecycle and automated brokerage reconciliation are not implemented here. The older execution system is not part of this runtime.

## Current evidence

- TypeScript Webull parsing and quote qualification are covered by observed sanitized payloads and offline transport tests. Authenticated acceptance of this new TypeScript client remains outstanding.
- A separate bounded Webull probe worked earlier in the session. Its credentials were not persisted into this checkout; `desk --doctor` currently reports the local Webull credentials absent.
- Yahoo news completed a bounded public read. SEC, X and Benzinga adapters need their declared contact or authenticated feed access as applicable. No paid source has been activated.
- The initial fixed underlying ORB diagnostic lost $19.24 in discovery and $11.33 in holdout after its declared costs. See [method and evidence](manual-backtesting.md). These are not option returns and do not qualify an entry strategy.
- Live research monitoring has not been deployed. The demo is synthetic software validation. No user trades or actual fills are fabricated.

## Run locally

```sh
npm ci --ignore-scripts
npm run check:manual
npm run desk -- --doctor
npm run desk:demo
npm run desk -- --init
```

`--init` creates `data/desk/config.json` only if it does not exist. The planning equity is $5,000. Buying power and reconciliation time start unknown, and options permission starts unverified. Initial engineering defaults are $250 full-premium risk per position, $50 planned stop risk, $500 aggregate premium, $250 per correlation group and a $100 daily loss halt. These are reviewable limits, not verified broker settings or a return forecast. The $0.10/contract/side fee input is a placeholder assumption that must be replaced with applicable costs; actual fees are required in journal fills.

Default `npm run dev` and `npm start` now invoke the manual desk. `npm run legacy:dev` and `npm run legacy:start` retain the old trading application for explicit future work. Do not use its existing deployment configuration for the manual desk.

Local credentials are read from environment variables or an ignored `.env`. Never paste or commit credentials. Webull's transport permits only fixed official hosts and an allowlist of data endpoints. Its only permitted POST retrieves bars. Token creation, token files, account and order routes are excluded. Signed requests are the default. Accounts requiring 2FA need a separately approved token flow; the transport can accept an explicit in-memory token and expiry, but automatic renewal and CLI token provisioning are not implemented.

With configured credentials and explicit plans:

```sh
npm run desk -- --config data/desk/config.json
npm run desk:watch -- --config data/desk/config.json --interval-ms 2500
```

The first command performs one cycle; the second stays in the foreground until stopped. `--cycles N` bounds a watch run. Polls do not overlap. Requests occur during weekday regular-session hours; an exchange holiday/early-close calendar is still missing, so fresh quote checks are also required. The monitor does not claim an options streaming feed.

The transport reserves requests per endpoint, pacing sandbox to at least 2,010 ms and production to at least 1,010 ms between calls to the same endpoint, with bounded retries. These reflect [Webull's documented limits](https://developer.webull.com/apis/docs/rate-limits/), checked September 17, 2026. Other processes sharing the same app key also consume its quota; run one collector per key and share its records. Exact contract references are refreshed periodically. Broad chain pagination/date-range completeness remains unqualified.

Outputs under `data/desk`:

| File | Purpose |
|---|---|
| `board.md`, `board.json` | Latest local board, risk figures, reasons and precise eligibility expiration |
| `health.json` | OK, ERROR or STOPPED, with observation time |
| `plans.jsonl` | Immutable versions; changing fields requires a new version |
| `alerts.jsonl` | State transitions; repeated unchanged status does not spam new alerts |
| `quotes.jsonl` | Paired timestamped observations for later replay |
| `fills.jsonl` | Actual broker/manual execution records, never inferred from alerts |
| `daily-halt.json` | Persisted loss halt for the ET session |
| `journal-report.json` | Realized P&L after allocated fees and remaining open exposure |

The board is a static snapshot, not a live execution screen. Every ELIGIBLE state expires within two seconds or sooner if the input's freshness expires. A stopped or unhealthy collector invalidates reliance on that board. A quote is not a guaranteed fill. The market may move between publication and manual execution.

SIGINT/SIGTERM stop new cycles and publish STOPPED status. Request timeouts bound outstanding network calls. A lock blocks simultaneous writers. After a crash, inspect the process before removing its stale lock. Logs are append-only; archival/retention service deployment remains to be configured.

## Plan fields and state transitions

`src/desk/types.ts` defines the plan schema. `src/desk/fixtures.ts` contains an explicitly synthetic example. Plans require:

- ID/version, symbol, exact OCC contract, strategy and direction.
- Creation, entry-open, entry-expiry and time-exit timestamps as UTC epoch milliseconds.
- Underlying trigger, maximum chase and invalidation.
- Maximum option entry debit, option bid stop, option bid target and whole-contract quantity.
- Correlation group, thesis, counterevidence and evidence references.
- Confidence labelled UNVALIDATED. No invented win probability.

News-dependent plans set `requireNews: true` and pin references as `event-id@revision`. Events must be visible as of evaluation, published within 24 hours and backed by a source-health check less than five minutes old. A corrected event revision invalidates the old reference. This is an attribution and freshness gate, not automatic factual confirmation. Social commentary remains unverified evidence.

WATCHING can become ELIGIBLE, DATA_BLOCKED, RISK_BLOCKED, EXPIRED or INVALIDATED. Expiry/invalidation are terminal for that version. The journal alone establishes OPEN and CLOSED states. Stop, target, invalidation or time exit raises EXIT_WATCH; recovery does not silently clear a triggered exit requirement. A closing fill resolves it. A single-contract position is never split fractionally.

Eligibility requires verified account permissions, recently reconciled positions/buying power, qualified standard contracts, fresh synchronized quotes, adequate displayed size and acceptable spreads. New fills invalidate the account snapshot until buying power is refreshed. Concurrent eligible plans reserve aggregate and correlated premium. Open risk is calculated from actual remaining lots, not original planned quantity. Missing marks or unmonitored positions block new risk. Overnight lots require a daily equity baseline and block new entries in this initial intraday implementation.

Loss limits are advisory gates for new alerts, not broker controls on manual activity. Triggered daily halts persist across restarts. This application cannot stop the operator trading independently or guarantee a stop execution.

## Manual fill import

```sh
npm run desk -- --import-fills path/to/fills.jsonl
npm run desk -- --report
```

Each line (or entry in a JSON array) must provide `id`, `source` (`broker` or `manual`), `executedAt`, `contract`, `multiplier: 100`, `standardContract: true`, `side` (`BUY_TO_OPEN` or `SELL_TO_CLOSE`), `quantity`, `price`, `fees`, `planId`, `planVersion`, and `correlationGroup`. IDs must identify executions, not aggregate order IDs. Verify the contract metadata against the broker record. Supply actual execution time and fees, including partial executions.

The importer validates the complete resulting ledger before appending, deduplicates identical IDs, rejects conflicting IDs/future fills/oversells, and matches FIFO within a contract and recommendation version. Entry and exit fees are allocated once across partial closures. Fees on still-open lots remain in their open cost basis. Buying power is not inferred from a $5,000 planning assumption or from option marks.

This is a normalized import format, not a claim that a Webull CSV export has been mapped or that the account has been reconciled automatically. A broker-specific importer/read-only account sync remains to be qualified against real supplied records.

## News and replay

To create a bounded research shortlist, use `npm run desk:pick -- --packet=path/to/research-packet.json`. Old quotes yield explicit rejections. With local credentials, `--refresh-webull` refreshes up to four shortlisted contracts for each of five roots from a packet less than 15 minutes old. It preserves source times and runs qualification at publication. This bounds discovery to twenty contracts; it does not establish an optimal strike or directional edge. See [picker methodology](options-picker.md). No plans are activated by this command.

Use the [news guide](news-pipeline.md) for source-specific setup and bounded polling. The market-data runner reads the shared `data/news` ledger without waiting for a news/model request on each quote. Collect news in a separate foreground process. No Discord/Telegram messages are sent by these commands. No AI API charges are incurred by the manual runner or tests.

To replay alert transitions into a fresh isolated directory:

```sh
npm run desk -- --config path/to/frozen-config.json --replay path/to/quotes.jsonl --directory data/desk-replay/new-run
```

Recorded receipt timestamps must increase. Replay cannot reuse an existing alert/quote output directory or inherit future transition state. News reads fold the latest revision available at that historical time. Replay of alerts alone does not invent executions or profit.

For option quote replay, use `npm run backtest:options -- --plan=path/to/one-plan.json --frames=path/to/quotes.jsonl`. See the [backtesting guide](manual-backtesting.md) for costs, missing-path treatment and limitations. Complete historical option data are still absent; current sparse probe snapshots cannot establish strategy expectancy.

## Remaining integration work

Authenticated TypeScript acceptance, paid-feed access, a validated options strategy, historical bid/ask data, live intraday strategy-to-plan generation, operator alert delivery, automatic account/fill reconciliation, multi-leg/swing lifecycle and supervised service deployment remain unfinished. Existing Claude code is not called by this new path; attributable evidence review and model cost budgets must be qualified separately. Build and fixture checks prove component behavior, not these external capabilities.
