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
51.4% win, +0.69%, PF 1.39, both halves positive (selection +0.42%,
validation +1.21%), descriptive only because shorts were declared for
the record. Observation retained: earnings gaps down 10%+ shorted may
work as well as the longs; it counts only on the store run with
`--end-date 2026-07-24`, line "short, gap 10%+". The validation half of
the long headline holds 12 trades, so the store run is required before
any of this is more than a hypothesis. File:
docs/results/theory-t3-2026-09-22-yahoo.txt (rerun with the T7 lines,
same 392 gaps).

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

Result (2026-09-22, Yahoo, 60 days, 1,500 names, 10 bps): NOT QUALIFIED.
The fade rarely fires: of 235 gap-ups of 5-10%, 45 closed a 5-minute
candle below the pre-market low by 11:30; those shorts ran n=45, 46.7%
win, -0.19%/trade, PF 0.82, selection -0.52% and validation +0.12%, with
76% of exits at the time stop. The 3-5% fade (n=240) was negative with
the halves split (+0.14% / -0.43%). Buying gap-downs that reclaim their
pre-market high is the worst line measured so far: 5-10% n=31, 25.8% win,
-1.79%, PF 0.19; 3-5% n=101, 27.7% win, -1.06%, PF 0.24; both halves
negative on both. A gap-down that pops back above its pre-market range
keeps falling. Observation only: nine 10%+ gap-ups that failed were
88.9% winners short (+2.70%, PF 11); nine trades say nothing yet. Fading
mid-size gaps is retired; the tag legend on the night list prints this.
File: docs/results/theory-t6-2026-09-22-yahoo.txt.

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

Result on the T2 populations (2026-09-22, Yahoo, 60 days): "hold to
15:45" beats the registered exit on the AMD specification (n=15: +2.71%
per trade, PF 4.32, halves +3.33% / +2.17% against +0.36% / +1.92%) and
on any mega-cap gap of 3%+ (n=78: +1.04%, PF 2.13, halves +1.00% /
+1.06% against +0.25% / +1.05%; the validation half is a tie). "Half at
1 ATR, rest to 15:45" beats it on the AMD specification (+1.87%, PF
3.29) but not on the broader line. Read: on mega-caps the 1.5 ATR target
sells the move early. Not applied to the registered rule until the store
run agrees.

Result on the T3 populations (same run, 2026-09-22): neither variant
beats the registered exit. Earnings gaps 10%+ long: hold to 15:45
+0.66% (PF 1.41, halves +0.32% / +1.58%) against the registered +0.64%
(halves +0.16% / +1.92%); half at 1 ATR and hold +0.65%. All earnings
gaps long: hold +0.43% against +0.22%, but PF 1.26 and one half flat.
Read: earnings gaps pay the 1 and 1.5 ATR targets about as often as they
run; mega-cap catalyst gaps run. The exit stays as registered for
earnings names.

## T8 Mega-cap gap, plain rule and the hold exit (registered 2026-09-22 15:40 UTC, after the T2 rerun)

Statement: in names with 20-day dollar volume of $1B or more, every
pre-market gap up of 2% or more, with no structure or sector filter,
is positive under the registered rule. Found post hoc in the T2 rerun on
the Yahoo window (n=158, 52.5% win, +0.58%/trade, PF 1.64, halves +0.52%
/ +0.62%), so that window cannot count. Correction (2026-09-23): an
earlier version of this entry quoted a hold-to-15:45 figure for this
line (+0.88%, PF 1.80); no such line was computed, the T7 variants ran
only on the 3%+ populations. From 2026-09-23 the T2 output includes the
hold variant for the 2%+ line.

Validation: the store, sessions on or before 2026-07-24 only:
`npm run theory -- --id T2 --source store --end-date 2026-07-24`, read
"gap >= 2%, any structure" and its T7 variant lines. Pass criteria as
above on that window alone.

Result: pending the store run.

## T9 Gap attribute filters (registered 2026-09-23 14:01 UTC, before running)

Question: which observable facts at the time of entry separate the gap
trades that work from the ones that do not. Population: every pre-market
gap of 3% or more in the universe, replayed with the registered rule
(long for gaps up, short for gaps down, half at 1 ATR, rest at 1.5 ATR),
reported by population: long 3-5%, 5-10%, 10%+, the star spec; short
3-5%, 5-10%, 10%+. Six filters, each applied alone:

- F1 stop within 1 ATR of the entry (the 09:30 candle's opposite extreme
  is at most 1 ATR away; ONON on 2026-09-22 was 1.9 ATR)
- F2 the 09:30 candle's volume at least 3x an average 5-minute bar of the
  prior five sessions
- F3 SPY moving with the trade at entry (above its 09:30 open for a long)
- F4 entry by 09:45
- F5 the 09:30 candle closed in its top third (bottom third for shorts)
- F6 pre-market volume at least 10% of an average day's volume (the
  store only; Yahoo carries no pre-market volume)

Pass for a filter on a population: filtered n >= 30, expectancy > 0,
PF >= 1.3, and filtered expectancy above the unfiltered population's in
both date halves. 42 filter lines are run, so some will pass by chance:
a pass here is a candidate, and only a pass on the store sessions before
2026-07-25 (`--end-date 2026-07-24`) puts a filter on the scanner.

Result: pending.

## T10 Earnings drift, swing (registered 2026-09-23 14:01 UTC, before running)

Statement: after a scheduled earnings report, a reaction day of +5% or
more that closes in the upper half of its range keeps drifting: long at
the next session's open, held 5 sessions, is positive (post-earnings
announcement drift). Reaction day: the report date when the report was
before the open, the next session when after the close; when the time is
not supplied, the larger of the two days' moves, with entry at the open
after both days so the choice uses no future data. Stop on a close
2 ATR against the entry. Daily bars (Yahoo, about 14 months) and the
Nasdaq calendar for every session in that span; 10 bps per side.

Metric: headline "long, reaction +5%+, hold 5 sessions"; 10- and
20-session holds and reaction-size buckets descriptive; the short mirror
(-5% or worse, closing in the lower half) for the record.

Result: pending.

## Operator store runs (149 sessions of Schwab bars, on the operator's machine)

```powershell
npm run theory -- --id T2 --source store
npm run theory -- --id T3 --source store
npm run theory -- --id T4 --source store --end-date 2026-07-24
npm run theory -- --id T1 --source store
npm run theory -- --id T6 --source store
npm run theory -- --id T2 --source store --end-date 2026-07-24
npm run theory -- --id T3 --source store --end-date 2026-07-24
```

Results land in docs/results/ and the evening push carries them. T4 with
the end date is the T5 validation; the other three simply have more
sessions than Yahoo can give.
