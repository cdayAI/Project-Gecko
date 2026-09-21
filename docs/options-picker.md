# Options candidate picker

`src/desk/picker.ts` builds a bounded research shortlist from a `ResearchPacket`
or `Candidate[]`. It does not activate plans, place orders, infer an entry trigger,
or claim that a contract has positive expected returns.

```ts
import { pickOptions, renderOptionsPickerMarkdown } from "../src/desk/picker.js";

const report = pickOptions(packet, {
  planningEquity: 5000,
  maxDebitUsd: 250,
  maxFullLossUsd: 250,
  directions: { TSLA: "LONG", HOOD: "SHORT", SMCI: "NONE" },
});
const markdown = renderOptionsPickerMarkdown(report);
```

The caller can persist the returned JSON and Markdown to a report directory.
This module has no filesystem, authentication, provider or order calls. There
is no separate CLI in this initial component. Run the offline checks with
`node --import tsx src/desk/picker-selftest.ts`.

## Defaults and interpretation

| Constraint | Default |
|---|---:|
| Planning equity, not verified buying power | $5,000 |
| Maximum premium debit per alternative | $250 |
| Maximum full-loss allowance per alternative | $250 |
| Quantity | 1 contract |
| Assumed fees per contract per side | $0.10 |
| Calendar days to expiration, using Eastern date | 1–45 |
| Absolute delta | 0.35–0.65 |
| Minimum reported session volume | 100 |
| Minimum reported open interest | 100 |
| Maximum selected underlyings | 5 |
| Direction selector | BOTH |

These are explicit engineering research constraints, not backtested optimal
parameters. The fee assumption must be reconciled against broker/exchange fees;
quotes, spreads and execution costs remain relevant even with zero commissions.
The full-loss allowance is `ask × 100 × quantity + two assumed sides of fees`.
The quantity can be configured from 1 to 10, subject to both dollar caps. A
shortlist is a set of alternatives, not authorization to buy all five or a
portfolio allocation. Account permissions, buying power and correlated exposure
remain the manual desk's responsibility.

Direction selectors are `LONG` (buy calls), `SHORT` (buy puts), `BOTH`, or `NONE`.
An uppercase symbol-specific selector overrides the global selector. SHORT
does not mean selling an option. BOTH expresses no directional conviction;
the highest-ranked passing contract wins for that underlying.

## Data and identity gates

Every selected contract must pass `evaluateQuotePair` against the source
candidate's **snapshot**, not a cached chain price or substitute underlying
snapshot. This requires verified standard multiplier-100 contract identity,
observed option delay zero, finite positive uncrossed quotes and sizes, source
quote ages at most five seconds, source quote skew at most two seconds, and an
underlying last trade at most five seconds old. The shared gate caps spreads at
both 5% of midpoint and $0.10. Its 500 ms tolerance concerns provider clock skew,
not permission to use a future receipt timestamp.

Packet, underlying, chain and option receipt timestamps must not be after the
evaluation time. Future evaluation times are rejected. The default evaluation
time is **Date.now()**, never the packet's timestamp: saved historical packets
normally produce data rejections. Explicit historical evaluation is allowed for
offline analysis and labeled HISTORICAL_RESEARCH once more than five seconds
behind the wall clock. Such results are not current entry prices. Validity also
expires with the underlying last trade, even if its bid/ask updated later.

Only 1–45 DTE single long calls/puts are considered; there is no 0DTE selection or
option-return backtest here. Missing delta, invalid delta sign, missing volume/OI,
unaffordable ask-plus-fees and duplicate identities are rejected. IV absence
does not by itself reject a contract but is reported as missing evidence.
Source volume/OI and Greek timestamps are not independently certified by this
gate. Quote size is not a fill guarantee or executable capacity model.

## Ranking, evidence and rejection report

The picker returns at most one contract per underlying and at most five roots.
Its deterministic 0–100 selection score weights narrower spread 45 points,
delta proximity to 0.50 25 points, reported volume 15 points and open interest
15 points. Volume and OI use logarithmic saturation at 1,000 and 5,000. Ties use
lower full-loss allowance, then symbol/OSI order. These weights compare contract
characteristics and are not an expected-return, thesis-strength or probability
model. The source research attention score does not determine this ranking.

Each underlying has selection status, examined/passing contract counts,
rejection counts, and up to ten data-quality reason samples. Common codes are
`NO_OPTION_DATA`, `DATA_QUALITY_BLOCK`, `DTE_OUT_OF_RANGE`,
`DELTA_OUT_OF_RANGE`, `VOLUME_OR_OPEN_INTEREST_INSUFFICIENT`,
`NOT_AFFORDABLE`, `NO_AFFORDABLE_CONTRACT`, `DIRECTION_EXCLUDED`, and
`RANK_CUTOFF`. An empty shortlist is a valid result.

Source candidate warnings are retained as counterevidence. Headlines require
publisher, title, HTTP(S) URL, a publication time available as of evaluation,
and an as-of receipt timestamp. They remain attributed source claims. This
component does not independently verify them or establish absence of earnings.
Absolute IV at or above 75% adds a volatility-contraction note; it is not called
expensive without relative IV/realized-volatility evidence.

The stock/options comparison reports local delta-equivalent share exposure,
stock notional at ask, expiry/time-decay differences and missing short-stock
permissions where relevant. Local delta equivalence is not equivalent payoff
or risk. Planned stop risk and probability of profit remain null. A usable
trade plan still requires an underlying trigger, invalidation, maximum entry,
stop, targets, time exit, event review and current account-level risk checks.
