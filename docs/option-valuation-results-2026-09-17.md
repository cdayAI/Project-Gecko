# Option valuation research: price leads, forecast weaknesses and current access

This work separates an underlying forecast, an option payoff valuation and executable profit. The new prototype addresses the first two as explicit research. It does not turn an unvalidated model into a trading signal.

## Concrete findings

The frozen study examined 36 structures from 2,312 Cboe September 25 contracts across AMD, HOOD, LEN, META, NVDA, QQQ, SMCI, SPY and TSLA. It retrieved 21,385 daily bars, starting September 2016 where available and ending September 16, 2026; HOOD has shorter history. Inputs were frozen before payoff outputs. No strike, regime or horizon was retuned after seeing these results.

Three long calls had quoted premiums below the preliminary model's scenario ceilings:

| Contract | Observed delayed ask/share | Scenario ceiling/share | Premium plus modeled reserve for one unit | Current decision |
|---|---:|---:|---:|---|
| SPY September 25 $763 call | $4.54 | $6.40 | $456.70 | Unvalidated; above provisional $250 debit-risk allowance |
| NVDA September 25 $220 call | $3.60 | $4.90 | $362.59 | Unvalidated; above provisional allowance |
| QQQ September 25 $717 call | $6.68 | $7.70 | $670.93 | Unvalidated; above provisional allowance |

These are research leads, not buy recommendations. The ceilings are outputs of historical-return scenarios and declared costs. They are not market fair values, executable limit prices, profit targets or guaranteed gains. The $250 allowance is an engineering planning default, not a user-confirmed broker/account constraint; it was not raised to admit a positive-looking result.

All 18 adjacent-strike debit spreads failed either quote-quality checks or the model price comparison. For example, the TSLA September 25 $367.50/$370 call spread had a natural debit of $1.20 versus a scenario ceiling of $0.88. SMCI's $40.50 call was quoted at $1.70 versus $1.12. A small premium does not itself establish favorable economics. This bounded ATM/adjacent-strike comparison does not prove that every possible strike or spread width is unattractive.

## The prediction check matters more than the apparent discount

At every historical test date, the conditional return model trained only on completed earlier outcomes. It used the historical test date's own lagged regime, not today's label. A simple unconditional return distribution supplied the comparison. The conditional model's average distribution score was slightly worse in seven of nine symbols. QQQ and SPY improved only about 0.44% and 0.51%, without a significance claim.

The conditional intervals intended to contain 80% of outcomes actually contained roughly 63%-78%, depending on symbol. SMCI had the weakest coverage, around 63%. This is evidence of inadequate tail calibration, not support for a confident win probability. More complex conditioning has not earned trust. The three price leads remain unqualified for this reason even apart from budget and stale data.

## What changed technically

- `valuation-history.ts`: unconditional and lagged trend/volatility scenarios, nonoverlapping six-session outcomes, matured endpoints, fixed sampling grid and explicit insufficient-support results. Historical state uses the close before entry; current state uses the last completed close before September 17.
- `valuation-calibration.ts`: rolling-origin return-distribution tests with CRPS and central-80% interval coverage, strict training embargo, and retained skips. This tests a forecast, not historical option profitability.
- `valuation-pricing.ts`: exact terminal intrinsic payoff math for calls, puts and debit spreads; observed ask or long ask minus short bid; funding and fee/slippage reserves; invalid-input rejection; theoretical debit-risk sizing.
- `valuation-cli.ts`: fixed nine-symbol/one-expiry experiment, 36 retained structures, source and input hashes, every historical scenario and forecast, all rejected selections, exact replay. Every execution status remains blocked.

The scenario ceiling takes the smaller of two lower resampled payoff means, deducts fixed cost reserve and solves funding at the resulting price. Four-observation blocks and the 0.05/72 percentile account descriptively for 36 structures and two models. This is not a calibrated confidence interval: state filtering changes spacing, dependence and rare unseen tails remain problems, and corporate-action adjustments have not been independently verified.

Six complete close-to-close sessions only approximate a delayed September 17 intraday mark through September 25 expiration. Missing same-clock observations prevent exact horizon matching. Terminal intrinsic values cannot price an earlier exit. Physically settled options and short spread legs can create stock/assignment obligations; theoretical debit economics are not an assurance that unmanaged expiry is safe in a $5,000 account. [OCC/OIC exercise guidance](https://www.optionseducation.org/optionsoverview/exercising-options)

## Actual connector qualification

The Webull plugin made a successful stock snapshot request at 19:58:26 UTC on September 17. SPY returned $763.05 with quote time 19:58:26.438 UTC; QQQ returned $717.42 with quote time 19:58:26.401 UTC. Quote ages at receipt were 315 and 352 milliseconds. TSLA subsequently returned $366.29. Explicit feed coverage and delay fields were absent, so subsecond source timestamps do not prove consolidated coverage or entitlements.

Webull's exposed snapshot schema accepts only US_STOCK and US_ETF. No option quote/chain GET tool is exposed through that plugin here. Separate earlier OpenAPI OPRA proof is not the same connection.

Alpaca OPRA and stock SIP requests failed subscription checks. Its indicative option feed responded, but those modified quotes were excluded from this study. [Alpaca feed documentation](https://docs.alpaca.markets/us/docs/historical-option-data)

Actual Cboe delayed quotes were captured at 20:01:16-20:01:17 UTC for the original eight symbols, and 20:02:15 for LEN. Original option rows with bid/ask sizes, IV, Greeks, OI and volume are retained. No per-contract quote event timestamps are available. LEN's underlying last-trade string was 12:51:31, several hours older than collection if interpreted in Eastern time. LEN is explicitly stale. The other last-trade strings are near 15:45; source timezone itself is not independently certified.

## A specific event mechanism to investigate

Lennar's September 16 release reduced full-year delivery guidance from 82,000-83,000 to 80,000-81,000 homes and reported orders down 9%. The countercase includes sequential gross-margin improvement, lower construction costs and reduced completed inventory. That gives a concrete bearish hypothesis to investigate alongside contrary evidence; it does not establish a fresh short signal or a predictable drift. Its stale chain prevents current execution analysis. [Lennar release](https://newsroom.lennar.com/2026-09-16-Lennar-Reports-Third-Quarter-2026-Results)

A separate prospective hypothesis can test whether a comparable guidance change plus subsequent relative strength/weakness produces delayed repricing after the announcement jump. It needs both dated guidance documents, publication and first-receipt times, matched sector/market controls, a frozen option-selection rule and actual spread exit quotes. This current model has no historical event labels; today's release was not retroactively inserted into its training data. Research on limited attention motivates testing this mechanism but does not validate today's options implementation. [DellaVigna and Pollet](https://www.nber.org/papers/w11683)

## Legacy evidence cleanup

Review found that `catalyst-test.ts` sorts large observed moves instead of joining a verified event calendar, and its five-minute close comparisons mislabel timing. It illustrates option returns using fixed volatility rather than observed quotes. `microscalper-test.ts` overlaps signals, favors target-first intrabar outcomes and derives timeout returns from extrema. Their outputs are now prominently labeled unqualified illustrations. Unsupported earnings-strategy return and 70%-80% win-rate claims were removed from comments. Runtime strategy behavior was not promoted or altered.

## Validation and saved artifacts

The new history, pricing and calibration modules passed 49 checks. The full manual suite totals 278 checks plus TypeScript build and its runtime import-boundary check. These validate software behavior, not trading profitability.

Frozen data: `data/valuation/study-2026-09-17T20-10-02-387Z`. Raw quotes: `data/valuation/cboe-delayed-20260917T2000Z`. Connector evidence: `data/valuation/connector-readonly-20260917T195826Z.json`.

```sh
npm run check:manual
npm run research:value -- --replay=data/valuation/study-2026-09-17T20-10-02-387Z
```

Exact replay matched. Result SHA-256: `b04ea2751d46287c001f6b933796ee462ec116de499bc1d1fd21a3eabae553cc`. Data remains local and gitignored. No orders, purchases, external alerts or continuously running collector were started.
