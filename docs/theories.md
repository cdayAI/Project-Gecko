# Theory registry

Every trade idea that is not one of the registered specs starts here as a
theory: a statement, a pre-declared rule and metric, pass criteria, then
the result, kept win or lose. `npm run theory -- --id <id>` runs one
(`--source store` on the operator's machine replays the 149-session Schwab
store; Yahoo gives about 60 days). Results land in
`docs/results/theory-<id>-<date>-<source>.txt`. A pass on these windows is
a forward-test hypothesis for the night list, not an edge; the forward
log decides.

Common replay for every theory (src/backtest/gap-replay.ts, the rule as
registered on 2026-09-21): the first 5-minute candle (09:30 included) that
closes beyond the pre-market extreme confirms; entry at the next candle's
open; no signal after 11:30; skip if the open is more than 1.5% beyond the
extreme; stop on a 5-minute close through the 09:30 candle's opposite
extreme; half at 1 ATR, rest at 1.5 ATR; time exit 15:45; 10 bps per side.

Pass criteria, all theories: n >= 30 trades, expectancy > 0 and PF >= 1.3
on the whole window, and both date halves positive. Sub-lines (buckets)
are descriptive; only the headline line carries a verdict.

## T1 Day-2 continuation (registered 2026-09-22 15:20 UTC, before running)

Statement: a name that closes up 10% or more, in the top quarter of its
range, above its prior 20-day high, follows through the next morning. The
gap rule on day 2, long, with no gap-size requirement, is positive. Mirror
for shorts (down 10%+, bottom quarter, below the 20-day low).

Why now: VICR on 2026-09-22 (day 2 after +11.8%) triggered long at 250.38
and ran; AMD on 2026-09-22 after +9.95%. The star spec needs a 10% gap on
the day itself and misses these.

Metric: headline line "long, all"; buckets by day-2 pre-market gap.

Result: pending.

## T2 Mega-cap catalyst gap, the AMD type (registered 2026-09-22 15:20 UTC)

Statement: in names with 20-day average dollar volume of $1B or more, a
pre-market gap of 3% or more above the 20-day high with the sector ETF
green pre-market follows through under the gap rule. The star spec's 10%
gap floor is the wrong size for mega-caps; AMD on 2026-09-21 gapped 4.0%
(582 against 559.82), above its prior high, with SMH +1.8% pre-market, and
closed +9.95%.

Metric: headline line "gap >= 3%, above the 20-day high, sector green";
2% and 4% floors and the unfiltered lines are descriptive.

Result: pending.

## T3 Earnings gap-and-go (registered 2026-09-22 15:20 UTC)

Statement: a gap of 5% or more on the session after a scheduled earnings
report (Nasdaq calendar; the report date when the time is pre-market, the
next session when after-hours, both tried when the time is not supplied)
follows through under the gap rule better than gaps without a scheduled
catalyst. Reference without a catalyst filter (store, 123 sessions): 5-10%
gaps 42-46% win and about -0.2% per trade; 10%+ gaps 45% and 54% win by
half.

Metric: headline lines "long, all earnings gaps" and "long, gap 10%+";
shorts reported for the record.

Result: pending.

## T4 After-hours mover follow-through (registered 2026-09-22 15:20 UTC)

Statement: an after-hours move of 3% or more from the close holds into the
next open (a gap of the same sign) more often than not, and the gap rule
in that direction on the next session is positive. This is the tier-1
"AH" tag on the night list.

Metric: headline line "long (after-hours up), all"; the share of moves
whose gap kept the sign is descriptive; shorts reported for the record.

Result: pending.
