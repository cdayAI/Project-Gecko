# Research engine

The research engine is the pre-trade half of Gecko. It scans a universe,
pulls quotes, daily statistics, headlines, the macro calendar, and option
chains, prices a handful of defined-risk structures against a per-trade
risk budget, and writes a **research packet** (JSON + Markdown) under
`data/research/`. It never places, modifies, or cancels orders.

```
npm run research -- --symbols SPY,QQQ,LEN
npm run research -- --universe both --provider webull
npm run research -- --symbols GNRC --no-chains --no-news --equity 5000 --risk-pct 2
npm run research:selftest        # Webull signer vs official SDK vectors
```

## What a packet contains

For every candidate:

- Snapshot with provenance: source, capture time, source timestamp, and a
  delayed flag. Delayed marks are labelled and never presented as entry prices.
- Daily statistics from bars: ATR14, SMA20/50, 20-day high/low, average
  volume, relative volume, gap, range position, 52-week position.
- Catalysts: recent headlines with publisher and time (Yahoo Finance),
  next earnings date when the provider exposes one, macro releases today
  and over the next five days (built-in calendar in `intelligence/economic-calendar.ts`).
- Option structures: ATM long call/put and call/put debit spreads across
  up to three expirations (near, weekly, monthly; the most liquid
  expiration by open interest in each bucket). Each shows debit at mid and
  at the ask, maximum loss, maximum gain, reward:risk, breakeven, bid/ask
  drag, net delta and theta, and how many contracts fit the risk budget.
  Structures whose long leg has no bid, whose debit consumes the full
  width, or whose long leg is deeper than 0.90 delta are dropped.
- A mechanical attention score (0 to 100) with its reasons. It ranks what
  to look at first. It is not a probability, a forecast, or a signal.
- Warnings: delayed data, after-hours drift versus the regular close (option
  marks predate the move), earnings inside five days, macro release today,
  nothing fits the budget.

Outputs:

```
data/research/YYYY-MM-DD/<packet-id>.json   full packet
data/research/YYYY-MM-DD/<packet-id>.md     human-readable
data/research/packets.jsonl                 one line per run (index)
```

## Providers

`RESEARCH_PROVIDER` (or `--provider`) selects the data source. All three
implement `src/research/providers/provider.ts`.

| Provider | Quotes | Daily bars | Movers | Option chains | Earnings dates | Needs |
|---|---|---|---|---|---|---|
| `cboe` (default) | delayed 15 min, snapshot file | Yahoo Finance | no | yes, delayed, full chain with IV and Greeks | no | nothing |
| `webull` | delay determined from observed metadata, not environment | implemented, live acceptance pending | implemented, live acceptance pending | observed reference/snapshot parsers; batches of 20; OPRA non-display subscription | implemented | `WEBULL_APP_KEY`, `WEBULL_APP_SECRET` |
| `schwab` | yes | yes | yes | yes, one call per underlying | no | Schwab OAuth (`npm run auth`) |

### Cboe delayed (verified 2026-09-16)

`https://cdn.cboe.com/api/global/delayed_quotes/options/{SYMBOL}.json` returns
the underlying's current price, day range, previous close, volume, IV30, and
every listed contract with bid, ask, last, volume, open interest, IV, delta,
gamma, theta, vega. It is a 15-minute delayed snapshot; after the close it
holds the last regular-session marks. Good for structure analysis and strike
selection. Not good for entry pricing.

### Webull OpenAPI

Endpoints, hosts, and request signing were verified against the official
`webull-openapi-python-sdk` 3.0.1 source (not the older docs page, which
describes an HMAC-SHA1 variant the SDK no longer uses):

| Purpose | Method and path | Notes |
|---|---|---|
| Stock/ETF snapshot | `GET /market-data/stocks/snapshots/list?symbols=&category=US_STOCK&extend_hour_required=` | up to 100 symbols; observed category for equities and ETFs |
| Daily bars | `POST /market-data/stocks/bars/list` body `{symbols:[],category,timespan:"D",count}` | the old `/bars/get` is gone |
| Gainers / losers | `GET /market-data/screeners/gainers-losers/list?rank_type=DAY_1|PRE_MARKET&sort_by=CHANGE_RATIO&direction=` | |
| Most active | `GET /market-data/screeners/top-actives/list?rank_type=TURNOVER` | |
| Option contracts | `GET /trading/instruments/options/contracts/list?category=US_OPTION&option_symbols=` | observed exact-contract response, standard100 reference qualification; broad discovery completeness unqualified |
| Option snapshot | `GET /market-data/options/snapshots/list?symbols=&category=US_OPTION` | 20 symbols per call; actual `imp_vol`, sizes, quote times and delay retained |
| Earnings calendar | `GET /market-data/fundamentals/earnings-calendars/list?symbol=&category=US_STOCK` | |

Signing (`src/research/providers/webull/signer.ts`):
`x-app-key`, `x-timestamp` (UTC, no millis), `x-signature-version 1.0`,
`x-signature-algorithm HMAC-SHA256`, `x-signature-nonce`, plus `host` are
merged with query params, sorted, joined as `k=v&...`, prefixed by the path,
suffixed by the uppercase SHA-256 of the exact JSON body when there is one,
percent-encoded with Python `quote(safe='')` semantics, then HMAC-SHA256 with
`appSecret + "&"` and base64. `npm run research:selftest` checks four
vectors generated by the SDK's own composer.

Entitlements (Webull docs, Market Data API overview): stock and ETF data
need a Nasdaq Basic or TotalView non-display OpenAPI subscription; options
need OPRA Real-Time Non-display. Observed sandbox responses can have zero delay
after entitlement activation; missing delay metadata remains unknown. Relevant
data endpoints have independent app-key quotas of 30 requests/minute in sandbox
and 60/minute in production. The client enforces per-endpoint pacing and bounded
retries. See [current Webull rate limits](https://developer.webull.com/apis/docs/rate-limits/).

The research transport uses signed-only access by default. Automatic token
creation/checks and token files have been removed. Its allowlist rejects token,
account and order routes and all host overrides or redirects. A separately
approved access token can be supplied in memory with explicit expiry when an
account requires it; automatic 2FA/renewal is not implemented here.

The [manual desk](manual-trading-desk.md) uses exact contract references and
paired fresh snapshots through `evaluateQuotePair`. Offline parser and transport
tests pass; authenticated TypeScript acceptance remains outstanding. Passing
the quality gate is not proof of strategy edge, quote execution or account approval.

First live checks once keys exist (all read-only):

1. `npm run research:selftest` passes.
2. `WEBULL_ENV=sandbox npm run research -- --provider webull --symbols SPY --no-chains --no-news`
   should log a snapshot; a 401/403 means the signature or entitlement is wrong.
3. Add `--universe movers` to exercise the screener endpoints.
4. Qualify the exact-contract path before expanding chain discovery. Preserve
   sanitized responses and compare timestamps, identity and metadata.

### Schwab

Uses the existing `SchwabRest` client. `/marketdata/v1/movers/{index}` was
added with `index`, `sort` and `frequency` values taken from schwab-py; the
response shape (`screeners[]`) comes from third-party clients and is
validated minimally until seen live.

## Sizing conventions

`RESEARCH_ACCOUNT_EQUITY` and `RESEARCH_MAX_RISK_PCT` (defaults 5000 and 2)
set the budget. "Fits budget" means one contract's worst-case loss (debit at
the ask times 100) is at or below that dollar figure. This is the maximum
possible loss on a long premium structure, which is different from a planned
stop. Long single options are shown even when they do not fit so the reader
sees why a spread is the only structure that does.

## What the engine does not do

- No probability of profit, expected move, or IV rank. Those need a
  volatility history we do not store yet.
- No LLM review. The packet is designed to be handed to a reviewer (human
  or model) as self-contained evidence; the review step is a later addition.
- No intraday bars or VWAP. Triggers and time exits are still the trader's.
- No live entry pricing. Every price carries a delay flag for a reason.

## Next steps

1. First live Webull run with real keys; confirm option contract and
   snapshot shapes and lock the parsers.
2. Store daily IV30 per symbol from the Cboe file to compute IV rank.
3. Intraday bars and VWAP from the selected provider for trigger levels.
4. A review step that sends the packet to Claude for a counter-case and
   records the response next to the packet.
5. Journal linkage: record which packet a manual trade came from, then
   compare planned versus realized after costs.
