# Historical options data: acquisition decision and qualification evidence

Research/access window: **2026-09-17 19:32–19:42 UTC**. Sources below are official provider documentation and one explicitly public sample. No authenticated requests, purchases, new subscriptions, or orders were made. Prices and available ranges need rechecking before acquisition.

## Decision

The shortest route available **now, without credentials**, is Theta's public historical sample. Bounded HTTP Range retrieval successfully returned actual SPY option NBBO CSV rows from **2025-08-19**, including an already expired **2025-08-20** contract. This is enough to begin an importer and schema qualification. It is not enough to establish edge: the retrieved portions are incomplete, one day is not a validation sample, and sample underlying identity/timezone mapping still needs qualification.

For a deliberately small paid historical experiment, compare a **Databento metered cost estimate for selected contracts/days** against **Theta Options Standard at the currently advertised $80/month, plus any required stock-data tier**. Do not buy a broad market dump first. Theta's tick API is straightforward once its local Terminal and account are available; Databento avoids that local Terminal and can price an exact extraction before download. Cboe's interval product is useful for slower strategies and independently paired stock/option snapshots, but minute observations cannot recreate second-by-second stops or the desk's five-second freshness gate.

This document recommends a data acquisition milestone, not a trade or a claim of profitable strategy.

## What Gecko currently has

- `src/research/providers/webull/provider.ts` reads current option snapshots and contract references. Its historical bars are underlying stock bars. `client.ts` has a narrow endpoint allowlist, with no historical option-quote adapter.
- `src/data/historical.ts` and `yahoo-historical.ts` supply underlying bars. Neither contains historical option NBBO.
- `src/backtest/manual-options-replay.ts` consumes recorded `QuoteFrame` observations for one fixed plan. It explicitly labels next-frame ask/bid fills hypothetical. It does not acquire history or discover a strategy.
- `src/backtest/evidence-store.ts` explicitly identifies missing historical options evidence. The older Black–Scholes illustration in `catalyst-test.ts` and delta approximation in `microscalper-test.ts` are not observed option returns.

## Provider comparison

| Route | Historical quote coverage verified in documentation | Access/cost and current limitation |
| --- | --- | --- |
| Webull existing OpenAPI | Current snapshots; historical option bars and historical option trade ticks are documented. A historical NBBO quote endpoint, earliest date, and expired-contract retention were not established. | Existing live OPRA permission does not establish historical NBBO access. No additional historical-data cost was verified. |
| Theta v3 | Options Value: minute intervals from 2020-01-01; Standard: ticks from 2016-01-01; Pro: ticks from 2012-06-01. Historical contract-list endpoint supports date-specific discovery. | Advertised personal options monthly tiers: $40 / $80 / $160. Normal API needs an account, appropriate tier, and running Terminal. Public sample works without these. |
| Databento `OPRA.PILLAR` | `cbbo-1m`, trades, definitions and other coarse schemas extend to 2013-04-01. Tick `cmbp-1`, `tcbbo`, and `cbbo-1s` begin 2023-03-28. | Historical usage pricing remains available. Account/API key required for the extraction and account-specific cost estimate. Advertised new-account credit is $125; not assumed available to this user. |
| Cboe DataShop Option Quotes | One/custom-minute option NBBO snapshots from January 2012 to present, with stock/ETF underlying bid/ask. | Configured historical file order, downloadable CSV ZIP/SFTP. Exact cost not exposed in the static specification; no order was configured or purchased. Tick history is a separate inquiry. |

Sources: [Webull bars](https://developer.webull.com/apis/docs/reference/option-historical-bars/), [Webull trade ticks](https://developer.webull.com/apis/docs/reference/option-tick/), [Theta tier coverage](https://docs.thetadata.us/Articles/Getting-Started/Subscriptions.html), [Theta pricing](https://www.thetadata.net/pricing), [Databento history migration](https://databento.com/blog/opra-improvements-coming-soon), [Databento dataset/access](https://databento.com/datasets/OPRA.PILLAR), [historical usage pricing](https://databento.com/blog/introducing-new-opra-pricing-plans), [Cboe product](https://datashop.cboe.com/option-quote-intervals).

Theta stock history is a separate entitlement: its documented tick tier is Stock Pro. UTP coverage reaches 2012-06-01, but CTA-only symbols such as **SPY start 2020-01-01**. The current stock-tier price was not verified. Do not assume the $80 options tier includes tick stock NBBO/trades. Its general marketing lookback lengths and exact documented start dates differ; use the endpoint/entitlement's actual available dates when downloading. [Coverage and access table](https://docs.thetadata.us/Articles/Getting-Started/Subscriptions.html)

## Verified public retrieval

[Theta's sample page](https://docs.thetadata.us/Articles/Getting-Started/Sample-Data.html) explicitly permits download without an account or live credentials. The linked URL is `https://docs.thetadata.us/sample_data.zip`.

Observed HTTP metadata: `Content-Type: application/zip`, total **3,771,994,492 bytes**, and server date **Thu, 17 Sep 2026 19:34:08 GMT**. The ZIP central directory contained **217 members**. A bounded range reader received HTTP **206**, read ZIP metadata and only the first **16,384 uncompressed bytes** of each of four members; that targeted read transferred **79,861 bytes** in total. An earlier discovery request was also bounded and stopped after roughly 25 MB. No full archive was downloaded or stored; no whole-file checksum is claimed.

Exact members and observations:

| ZIP member | Observed first row |
| --- | --- |
| `td_sample/OPTION/SPY/quote_ticks/SPY_20250820_quotes_tick.csv` | SPY, expiry 2025-08-20, strike 652, PUT; `2025-08-19T09:30:00.128`; bid 8.64 × 1, ask 9.13 × 1 |
| `td_sample/OPTION/SPY/SPY_quote_1m.csv` | SPY, expiry 2026-03-20, strike 355, CALL; `2025-08-19T09:30:00`; bid/ask and sizes all zero |
| `td_sample/STOCK/quote_1m.csv` | `2025-08-19T09:30:00`; bid 643.10 × 5, ask 643.12 × 1; **no symbol column** |
| `td_sample/STOCK/trade.csv` | `2025-08-19T09:30:00`; trade 643.1100 × 1, sequence 339814; **no symbol column** |

The first option row is not a candidate recommendation: it has a wide spread. The zero quote demonstrates why an importer must reject invalid values. Stock levels appear consistent with SPY, but price resemblance is not proof of identity; **do not yet join these STOCK members to SPY as verified observations**.

SHA-256 of the **16,384-byte prefix only**, in the same order as the table:

```text
d7d083b947bb20042f3306aca0cf3343b62a13b41d42e20eeb017026328e4203
456103810e979b6c3431c6708295df8cb1e5263876505201daf30928873269c5
6eb84681224f8c5dd458c1381ff9451d06fe851dbca0eb4e8bb1da85f5da640b
e575e6315caa9e7042942a459ca3267f5e64d0a04c8388f594239e530c20052a
```

Reproduction approach: make a size-limited HTTP Range request for the ZIP tail, parse its central directory, find the exact member, then request bounded compressed chunks and incrementally inflate its prefix. Require HTTP 206 and an expected `Content-Range`; stop if the server returns the entire archive. A plain GET of the URL downloads about 3.77 GB. The successful diagnostic used a standard-library ZIP reader over a bounded seekable HTTP Range wrapper; a persistent TypeScript importer was **not** implemented in this research task.

## Concrete endpoints and schemas

### Webull: do not mistake bars or trades for quotes

Documented GET routes are `/market-data/options/bars/list` for recent historical bars and `/market-data/options/ticks/list` for trade ticks. OHLC/trades alone do not supply the executable bid/ask or spread at a proposed entry/exit. Existing `/market-data/options/snapshots/list` is a current snapshot. No authenticated history test was performed. [Bars](https://developer.webull.com/apis/docs/reference/option-historical-bars/), [ticks](https://developer.webull.com/apis/docs/reference/option-tick/)

Related live-acquisition constraint: current rate-limit documentation distinguishes **sandbox 30 requests/60 seconds** from **production 60/60 seconds**, per endpoint and app key, for relevant stock/option quote endpoints. This matters for a future recorder and all concurrent consumers. [Webull rate limits](https://developer.webull.com/apis/docs/rate-limits/)

### Theta: direct historical quote and universe API

Normal base is `http://127.0.0.1:25503/v3`, served by the local Terminal. It requires Java 21+ and account authentication; credentials should be supplied through a protected local mechanism, not chat or command-line history. [Terminal setup](https://docs.thetadata.us/Articles/Getting-Started/Getting-Started.html)

```text
GET /option/list/contracts/quote?symbol=SPY&date=20250819
GET /option/history/quote?symbol=SPY&expiration=20250820&strike=652.000&right=put&date=20250819&interval=tick
GET /stock/history/quote?symbol=SPY&date=20250819&interval=tick
```

These are constructed requests following the documented parameter schemas, not authenticated calls made here. List output is `symbol, expiration, strike, right`; quote output is:

```text
symbol, expiration, strike, right, timestamp,
bid_size, bid_exchange, bid, bid_condition,
ask_size, ask_exchange, ask, ask_condition
```

Quote history supports date or inclusive start/end dates; intervals below one minute require one day. Fetch date-specific contracts rather than today's chain. An interval quote is a sampled last quote; it does not imply a fresh underlying exchange event at every interval boundary. [Contract list](https://docs.thetadata.us/operations/option_list_contracts.html), [option quote schema](https://docs.thetadata.us/operations/option_history_quote.html), [stock quote schema](https://docs.thetadata.us/operations/stock_history_quote.html)

The sample timestamps have **no UTC offset**. Theta's legacy quote specification uses ET, and its current at-time API names `America/New_York`, but this bounded inspection did not establish an explicit timezone declaration for the v3 sample CSV. Require that mapping before replay; do not parse these strings using the machine's implicit timezone. [Legacy timestamp semantics](https://http-docs.thetadata.us/operations/get-v2-hist-stock-quote.html), [current at-time timezone](https://docs.thetadata.us/operations/stock_at_time_trade.html)

### Databento: exact range, bounded cost, event semantics

```text
GET  https://hist.databento.com/v0/metadata.get_dataset_range?dataset=OPRA.PILLAR
GET  https://hist.databento.com/v0/metadata.get_cost
POST https://hist.databento.com/v0/timeseries.get_range
```

The POST reads data; it is not a trading mutation. Use HTTP Basic API-key authentication and form fields `dataset=OPRA.PILLAR`, `schema=cmbp-1`, exact `symbols` obtained from historical definitions, `stype_in=raw_symbol`, UTC `start`/`end`, a bounded `limit`, and `encoding=json`. End is exclusive; JSON is newline-delimited. Price the same symbols/schema/range first; metadata is free. Cost estimates can overstate sub-ten-minute ranges. The exact latest available endpoint timestamp was not queried without an account. [Historical API](https://databento.com/docs/api-reference-historical?historical=http)

Persist `instrument_id`, dated symbol mapping, `publisher_id`, `ts_event`, `ts_recv`, bid/ask prices, sizes, and flags. Prices use fixed-point units of 1e-9 unless explicitly converted. Timestamps are nanoseconds; retain precision/ordering before converting for Gecko. For interval CBBO, `ts_recv` is the interval end and `ts_event` refers to the last trade, **not the original quote-change time**. A trade-only interval may carry a previous quote. Prefer tick `cmbp-1` for the desk's strict quote-age replay and preserve each event's action. [CBBO/CMBP schemas](https://databento.com/docs/schemas-and-data-formats/cbbo)

`OPRA.PILLAR` supplies options, not a qualified contemporaneous SPY/QQQ stock NBBO stream. Underlying stock quotes/trades need a separately specified historical feed with documented coverage and timestamps. No stock package was selected or purchased here. Use historical definitions, including expired contracts, and dated symbology resolution. A public catalog contains sample records, but no complete paired dataset was extracted from it. [Dataset](https://databento.com/datasets/OPRA.PILLAR), [dated instrument discovery](https://databento.com/docs/portal)

### Cboe: paired minute files, with an important size change

The downloadable layout supplies `underlying_symbol, quote_datetime, root, expiration, strike, option_type`, option OHLC and volume, `bid_size,bid,ask_size,ask`, and `underlying_bid,underlying_ask`. Optional fields include IV, Greeks and OI. `quote_datetime` is the end of the interval in **US Eastern**; OI is the beginning-of-day OCC value. Zero values may indicate unavailable inputs. [File layout PDF](https://datashop.cboe.com/documents/Option_Quotes_Layout.pdf)

From **2026-06-22**, the product's sizes correspond to the most recent price change inside the interval; older files used the latest quote sizes even without a price change. Model this version difference explicitly before using size as a liquidity constraint. Stock/ETF underlying quotes are included; some index underlying data needs a separate license. Public sample retrieval was unsuccessful in this run (browser retrieval error/direct HTTP 403), and no workaround was attempted. [Product and change notice](https://datashop.cboe.com/option-quote-intervals)

## Minimum importer and validation milestone

1. Persist a manifest: official URL/product, acquisition UTC, request bounds, entitlement, file hash, row count, field units, timezone, source timestamp meaning, and any incomplete retrieval. A prefix hash is not a file hash.
2. Normalize each event into contract identity, effective symbol/reference date, expiry, right, strike, **verified multiplier/deliverable**, raw source event time, receipt time where supplied, bid/ask, sizes, conditions, and raw source identifier. Acquisition time is separate from historical event time. Exclude adjusted/nonstandard contracts until their deliverables are represented.
3. Independently normalize underlying quotes and last trades. At a replay decision, use only observations already available at that instant; preserve a separate last-trade timestamp. Never forward-fill across a halt/session boundary or relabel an old quote as current.
4. Discover the universe as of each historical date, and only permit a contract after it was first observable. A whole-day contract list or end-of-day volume can leak future information. Define the original underlying universe before examining outcomes; today's surviving tickers alone bias results. Preserve delisted/renamed roots and adjustment exclusions in the manifest.
5. For minute data, build an explicitly slower replay with interval-aware assumptions. Do not fake tick freshness by assigning bar-end timestamps to stale quotes. For tick data, align causal stock/option events, account for skew and unavailable observations, then apply the existing quality gate at the simulated clock.
6. Replay predeclared setups and exact contract-selection rules with next-observation fills, spread crossing, fees, slippage, no guaranteed quoted-size execution, full-loss risk, event/overnight treatment, and chronological train/validation/test separation. Report missing periods and rejected opportunities as part of results.

Immediate completion criterion: an imported, independently identity/timezone-qualified historical option-and-underlying segment produces deterministic fixture replay and rejection tests. A useful strategy claim requires substantially more dates, varied conditions, out-of-sample results, and realistic execution costs. None of those outcomes is established by this provider research or the public sample probe.
