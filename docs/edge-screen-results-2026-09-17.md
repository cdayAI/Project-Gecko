# Four strategy hypotheses: rejected in this exploratory screen

Executed September 17, 2026 at approximately 19:44:53-19:44:56 UTC. No profitable options strategy or live trade recommendation resulted.

The research mandate is in [RESEARCH_MANDATE.md](RESEARCH_MANDATE.md) and is referenced from the repository's working instructions. It requires evidence-producing work, retained failed experiments, realistic costs, point-in-time inputs and exact conditional option plans only when qualified.

## Actual experiment

Eight symbols: AMD, HOOD, META, NVDA, QQQ, SMCI, SPY and TSLA. The 19,968 five-minute bars cover 32 completed sessions from August 3 through September 16. Three symbols reuse the prior hashed evidence; five were fetched from Yahoo's public historical chart on September 17 at approximately 19:38:16 UTC. All required morning observations were present for all symbols and the 32 expected sessions. The narrow calendar excludes September 7 using the [NYSE published calendar](https://www.nyse.com/trade/hours-calendars).

Four strategy families were registered before outcomes. Each simulates a separate $5,000 directional portfolio, with $1,000 maximum notional, $25 planned stop risk, remaining planned daily loss allowance of $50, one shared position and one first signal per symbol per day. The same $5,000 is not simultaneously assigned to all four. Long and short share diagnostics are not executable account returns or long-call/long-put returns. Short borrow and margin are not modeled.

Completed bars generate signals between 09:50 and 10:55 ET; fills use the next bar open. Stops take priority when both stop and target occur within a bar. Time exit is 11:30 ET. Gaps can exceed planned loss. Missing held observations invalidate P&L rather than invent a favorable exit.

| Frozen family | Closed trades | Gross before costs | Modeled slippage | Assumed fees | Net | Net with doubled costs |
|---|---:|---:|---:|---:|---:|---:|
| Opening-range continuation | 33 | $6.94 | $9.95 | $66.00 | -$69.01 | -$136.94 |
| Failed opening-range breakout | 47 | -$38.18 | $15.34 | $94.00 | -$147.52 | -$253.17 |
| VWAP trend pullback | 49 | $3.13 | $16.14 | $98.00 | -$111.01 | -$249.87 |
| VWAP overextension reversal | 56 | -$45.73 | $19.29 | $112.00 | -$177.03 | -$300.12 |

All four fail the registered research-priority gates. Each was negative in both descriptive date partitions. Gross minus modeled slippage was also negative for the recorded trades in each family, before adding the fee assumption.

Base costs are 2 bps per side, minimum $0.005 per share, and $1 per order. These are disclosed screening assumptions, not Webull's quoted fees or an option spread model. Double-cost stress can change permissible quantities. The 185 base-scenario trades belong to four alternative simulations, not one combined account history.

## What this does and does not establish

The whole historical window is exploratory. Previous outcomes, the selected present-day universe and a short time span rule out calling it independent confirmation. No parameter search followed these results. No favorable direction/symbol subgroup is promoted as a new winner.

Five-session block uncertainty is descriptive, includes zero-trade sessions, and adjusts its lower tail for the four primary comparisons only. It does not establish a win probability, validate subgroups or remove selection bias. The full report retains every family, both cost scenarios, rejected signals, source hashes and individual trades.

This rejects these exact candidates under these assumptions. It does not prove that all options versions, catalyst filters or other strategies lose. Those are different hypotheses requiring new registration and appropriate data. Historical option quotes, decision-time contract availability and catalyst receipt times are still needed to test actual options selection and returns. A public historical SPY option sample was retrieved successfully; the [acquisition report](historical-options-data.md) identifies its identity/timezone gaps and verified provider routes. No subscription was purchased.

September 18 is a proposed future boundary, not a running experiment. No collector or qualified live alert stream was activated. A prospective options test must freeze its complete option selector and review endpoint before its actual first observation; it cannot backdate registration to September 18 if setup finishes later.

## Reproducibility and validation

Local evidence directory: `data/backtests/edge-2026-09-17T19-38-16-017Z`. Market datasets remain local and gitignored.

```sh
npm run check:manual
npm run research:edge -- --replay=data/backtests/edge-2026-09-17T19-38-16-017Z
```

Build, 229 component checks and the manual runtime import-boundary check passed. An independent review caught and corrected configuration enforcement, whole-session coverage, small-sample bootstrap degeneracy and daily planned-risk reservation before market outcomes were evaluated. Exact replay matched all four recorded results. Software tests are separate from strategy performance.

```text
Registration SHA256: 65d3a93a8ebf3e201d4eeb089ab1f92f1f3bed8bd43756c9cdebed92acf18af7
Input manifest SHA256: 4d2e52ff0c6587f0b86e582dcd8bae4e74aa150a36e41b7ca6b5b0115740ea6d
Results SHA256: b064b055a422f298bfe7ef88c23e1b4a0106132eea647596ee2ff7f381c66822
```

Local timestamps and hashes support reproducibility, not independent attestation of preregistration. Changes were kept local; no push, hosted CI, broker order or external alert was issued.
