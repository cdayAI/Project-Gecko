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

Result (2026-09-22, Yahoo, 2026-07-25 to 2026-09-22, 1,500 names, 10 bps):
NOT QUALIFIED. 308 events (197 up days, 111 down days). Day 2 gapped in
the day-1 direction only 31% of the time; median gap against it -0.82%.
Long rule n=88, 43.2% win, -0.16%/trade, PF 0.86 (selection PF 0.60,
validation PF 1.26); 62% of exits were the 15:45 time exit, 25% stops.
Short rule n=47, 31.9% win, -0.74%, PF 0.60. The CONT tag stays on the
night list as information, not as a reason to trade. Rerun on the store
(`--source store`) for the 149-session answer; the file is
docs/results/theory-t1-2026-09-22-yahoo.txt.

## T2 Mega-cap catalyst gap, the AMD type (registered 2026-09-22 15:20 UTC)

Statement: in names with 20-day average dollar volume of $1B or more, a
pre-market gap of 3% or more above the 20-day high with the sector ETF
green pre-market follows through under the gap rule. The star spec's 10%
gap floor is the wrong size for mega-caps; AMD on 2026-09-21 gapped 4.0%
(582 against 559.82), above its prior high, with SMH +1.8% pre-market, and
closed +9.95%.

Metric: headline line "gap >= 3%, above the 20-day high, sector green";
2% and 4% floors and the unfiltered lines are descriptive.

Result (2026-09-22, Yahoo, 60 days, 101 names with 20-day dollar volume
of $1B or more, 10 bps): NOT QUALIFIED on count, positive on everything
else. The AMD specification: n=15, 60.0% win, +1.20%/trade, PF 2.46,
selection +0.36% (PF 1.31) and validation +1.92% (PF 4.72), both
positive; exits target1 20%, target2 10%, time 43%, stop 27%. Descriptive
lines: any mega-cap gap of 3%+ n=78, 55.1% win, +0.73%, PF 1.80; any 2%+
n=158, 52.5% win, +0.58%, PF 1.64; 4%+ with the AMD filters n=14, +1.18%,
PF 2.34. The mega-cap population behaves unlike the universe, where the
same rule lost (PF 0.73 / 0.78). Fifteen trades in 60 days cannot qualify
anything; the store run (`npm run theory -- --id T2 --source store`,
149 sessions) is the one that can. File:
docs/results/theory-t2-2026-09-22-yahoo.txt.

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

Result (2026-09-22, Yahoo, 41 sessions from 2026-07-25, 1,500 names,
10 bps): "long, gap 10%+" PASS; "long, all earnings gaps" NOT QUALIFIED.
1,213 reporters in the universe, 392 gapped 5%+ on the report session
(354 reporters had no bars, mostly Yahoo refusals while two runs shared
the connection; treat n as a floor). Long, all gaps 5%+: n=100, 56.0%
win, +0.22%, PF 1.14, selection negative. Long, gap 10%+: n=44, 59.1%
win, +0.64%/trade, PF 1.43, selection +0.16% (PF 1.10, n=32) and
validation +1.92% (PF 2.62, n=12), both positive; exits target1 18%,
target2 9%, time 45%, stop 27%. Against the no-catalyst reference for
10%+ gaps (45% and 54% win, -0.28% and +0.55%), the earnings catalyst
adds about 10 points of win rate. 5-10% earnings gaps lost on both sides,
like every other 5-10% gap. Shorts: all n=83 not qualified; 10%+ n=35,
51.4% win, +0.69%, PF 1.39, descriptive. The validation half holds 12
trades, so the store run is required before this is more than a
hypothesis. File: docs/results/theory-t3-2026-09-22-yahoo.txt.

What it changes on the night list: an ER-tagged name that gaps 10% or
more in the morning carries the only catalyst-specific positive base
rate measured so far; it still needs the star conditions (above the
20-day high, sector green) for the registered spec, and the two are
logged separately so the log can tell them apart.

## T4 After-hours mover follow-through (registered 2026-09-22 15:20 UTC)

Statement: an after-hours move of 3% or more from the close holds into the
next open (a gap of the same sign) more often than not, and the gap rule
in that direction on the next session is positive. This is the tier-1
"AH" tag on the night list.

Metric: headline line "long (after-hours up), all"; the share of moves
whose gap kept the sign is descriptive; shorts reported for the record.

Result (2026-09-22, Yahoo, 60 days, 1,500 names, 10 bps): NOT QUALIFIED.
357 after-hours moves of 3%+; the gap kept the sign 78% of the time
(median gap in the after-hours direction +2.53%), so the move does hold
into the open. Buying it does not pay: long n=73, 41.1% win, -0.55%/trade,
PF 0.62, both halves negative; 54% time exits, 36% stops. Buckets 3-5%,
5-10% and 10%+ all negative; requiring the gap to still be up at 09:25
does not help (n=62, PF 0.65). Observation retained, not a result: the
short side after an after-hours drop was positive (n=53, 52.8% win,
+0.51%, PF 1.50, both halves positive; with the gap still down at 09:25
n=44, +0.77%, PF 1.75). It was not the declared headline, so it is
registered below as T5 and must be validated on sessions this window
never saw. File: docs/results/theory-t4-2026-09-22-yahoo.txt.

## T5 After-hours drop, short the next session (registered 2026-09-22 15:00 UTC, after the T4 observation)

Statement: after an after-hours drop of 3% or more from the close, the
gap rule short on the next session (first 5-minute close below the
pre-market low, entry at the next open, stop on a close through the
09:30 high, half at 1 ATR, rest at 1.5 ATR, out by 15:45) is positive.
Found post hoc in the T4 Yahoo window (2026-07-25 to 2026-09-22), so
that window cannot count.

Validation: the store, sessions on or before 2026-07-24 only:
`npm run theory -- --id T4 --source store --end-date 2026-07-24`, read
the line "short (after-hours down), all". Pass criteria as above on that
window alone.

Result: pending the store run.

## T6 Failed-gap fade (registered 2026-09-22 15:25 UTC, before running)

Statement: a 5 to 10% gap up that closes a 5-minute candle back below
its pre-market low is a failed gap; shorting it with the mirror rule
(entry at the next candle's open, stop on a 5-minute close above the
09:30 candle's high, half at 1 ATR, rest at 1.5 ATR, time exit 15:45,
no signal after 11:30, skip if the open is already more than 1.5% below
the pre-market low) is positive. Mirror: a 5 to 10% gap down that closes
back above its pre-market high, bought. Why: every 5 to 10% bucket lost
when chased in the registered tests and in T3, and the after-hours drop
shorts (T5 observation) are the same shape.

Metric: headline line "short fade, gap up 5-10%"; the 3-5% and 10%+
fades and the long mirror are descriptive.

Result: pending.

## T7 Catalyst exits (registered 2026-09-22 15:25 UTC, before running)

Statement: on the populations that were positive with the registered
exit (T3 earnings gaps of 10%+ long; T2 mega-cap gaps of 3%+ above the
20-day high with the sector green), holding the whole position to the
15:45 time exit, or half at 1 ATR and the rest to 15:45, beats the
registered half at 1 ATR and rest at 1.5 ATR. Why: 45% of those trades
ended at the time exit, which says the move was still running.

Metric: the same trades replayed under each exit; a variant passes only
if its expectancy is higher than the registered exit's in both date
halves and its PF is at least 1.3. Printed inside the T2 and T3 output
(`--id T7` runs both).

Result: pending.

## Operator store runs (149 sessions of Schwab bars, on the operator's machine)

```powershell
npm run theory -- --id T2 --source store
npm run theory -- --id T3 --source store
npm run theory -- --id T4 --source store --end-date 2026-07-24
npm run theory -- --id T1 --source store
npm run theory -- --id T6 --source store
```

Results land in docs/results/ and the evening push carries them. T4 with
the end date is the T5 validation; the other three simply have more
sessions than Yahoo can give.
