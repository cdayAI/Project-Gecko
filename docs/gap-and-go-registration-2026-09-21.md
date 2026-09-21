# Catalyst gap-and-go test: registration (2026-09-21, ~16:40 UTC)

Registered before any run. Underlying-share directional diagnostic of the
rule written into the trade sheet on 2026-09-21. Not an options result;
not a live approval. Results are appended below and retained whatever
they show.

## Hypothesis H-GAP-GO

On sessions where a liquid optionable stock's last pre-market print is at
least 3% away from the prior close AND beyond its prior 20-session high
(long) or low (short), the first completed 5-minute candle from 09:30 that
closes beyond the pre-market extreme (evaluated at candle close, earliest
09:35, latest 11:30) predicts enough continuation to earn a positive net
return with: stop on a 5-minute close back through the 09:30 candle's
opposite extreme; half exited at +1 ATR(14) from entry, the rest at +1.5
ATR; remainder closed at 15:45; skip if the 09:30 open is more than 1.5%
beyond the pre-market extreme.

## Rules (frozen)

Implemented in `src/backtest/gap-and-go-cli.ts`. Fills at the next bar's
open after the signal candle, plus or minus slippage; stop exit at the
stop candle's close plus or minus slippage; targets filled at the target
price when a bar's range reaches it (limit order); stop checked before
targets inside a bar. Slippage 5 basis points per side base, 10 in the
double-cost stress. One entry per symbol per session. Point-in-time
statistics only: 20-session high/low and ATR(14) from daily bars strictly
before the session.

## Data and window

Yahoo 5-minute bars with pre/post market over the last 59 days
(2026-07-23 through 2026-09-18, 41 sessions) and daily bars for the
point-in-time statistics. Universe: the top 1,500 names by 20-day dollar
volume from data/universe/universe.json built 2026-09-21 (price >= $5,
average dollar volume >= $30M, listed options). Survivorship: the
universe is as of today; names delisted during the window are absent.

## What is not modeled (Yahoo limits)

No pre-market volume floor (Yahoo pre-market bars carry no volume). No
sector confirmation. No catalyst check. The live scanner applies all
three, so this test is the rule WITHOUT its qualitative filters: a
harder test than the live version, not an easier one.

## Reports

All signals: n, win rate, average win and loss in percent of entry,
expectancy per trade, profit factor, net at $1,000 notional per trade,
both halves of the window, best-session removal, long vs short, gap
buckets (3-5%, 5-10%, 10%+), above 52-week high or not. Also a "top 3 per
session by gap size" variant that mimics taking only the strongest names.

## Gates (research priority only)

At least 30 signals; expectancy above zero net; positive in both halves;
positive at double slippage; positive after removing the best session;
profit factor above 1.0 on all signals. Any failure means NOT QUALIFIED.
No parameter search follows.

## Disclosures

- The rule was written today after watching AMD run 584 to 604 in the
  first 15 minutes on 2026-09-21. That session is outside the window, but
  the design is informed by market behavior generally; this is a first
  test of the exact ruleset, not an unseen holdout of it.
- The window is the same one the ORB test used (that rule set failed on
  it). The gap-and-go rule was not tuned on any of it.
- Yahoo pre-market prints can be thin; a gap measured from one or two
  pre-market trades may not exist at 09:30. The 1.5% open filter and the
  09:35 confirmation are the only protections in this test.

## Results (2026-09-21, ~17:15 UTC)

Runs completed with zero failed symbols: 1,500 names, base slippage 5 bps
per side and a 10 bps stress. Because the 59-day request was made at
~12:45 ET, the raw output included 11 trades from the partial session of
2026-09-21 (the session the rule was designed on, with exits forced at
the last available bar). Those are excluded below; the registered window
is 2026-07-24 through 2026-09-18 (the 59-day lookback started one session
later than the registration stated). 858 candidates met the gap and
structure screen; 437 never printed a confirming close by 11:30; 18 were
skipped for opening beyond 1.5% of the pre-market extreme; 392 trades.

| Slice (base 5 bps) | n | Win | Expectancy/trade | PF | Net at $1k/trade |
|---|---:|---:|---:|---:|---:|
| ALL SIGNALS (registered) | 392 | 47.7% | +0.17% | 1.16 | +$681 |
| First half (< 08-21) | 284 | 50.0% | +0.27% | 1.25 | +$761 |
| Second half (>= 08-21) | 108 | 41.7% | -0.07% | 0.94 | -$79 |
| ALL at 10 bps | 392 | 46.4% | +0.08% | 1.07 | +$311 |
| ALL at 10 bps without best session (08-19) | | | | | -$113 |
| LONG | 239 | 50.6% | +0.19% | 1.18 | +$442 |
| SHORT | 153 | 43.1% | +0.16% | 1.13 | +$239 |
| gap 3-5% | 174 | 40.2% | -0.16% | 0.83 | -$272 |
| gap 5-10% | 144 | 48.6% | +0.12% | 1.10 | +$167 |
| gap 10%+ | 74 | 63.5% | +1.06% | 1.81 | +$786 |
| gap 10%+ at 10 bps | 74 | 60.8% | +0.97% | 1.72 | +$721 |
| gap 5%+ | 218 | 53.7% | +0.44% | 1.36 | +$953 |
| LONG above 52-week high | 34 | 64.7% | +0.58% | 1.45 | +$196 |
| Top 3 per session by gap | 102 | 54.9% | +0.43% | 1.33 | +$441 |
| Top 3, first half / second half | 56 / 46 | 62.5% / 45.7% | +0.69% / +0.11% | 1.59 / 1.08 | +$388 / +$53 |
| Top 3 at 10 bps | 102 | 52.0% | +0.34% | 1.25 | +$348 |

Exit mix, position-weighted: time exit 54%, stop 33%, target 1 9%,
target 2 4%. Best session 2026-08-19 contributed +$447 of the +$681
total; worst session 2026-09-14, -$187.

### Gate evaluation

The registered rule (all signals) fails the both-halves gate (second half
negative) and fails best-session removal under double cost. H-GAP-GO as
written is NOT QUALIFIED. It is not a losing rule either: a small positive
tilt that is fragile and decayed in the second half.

### Observations retained, not promoted (post hoc)

- Expectancy rises monotonically with gap size. Gaps of 3-5% lose after
  costs; 10%+ gaps earned about 1% per trade with a 1.8 profit factor and
  held at double cost. Taking only the three largest gaps per session
  was positive in both halves at base cost and survived best-session
  removal. These slices are hypotheses for the next registration, not
  evidence for this one.
- The ATR targets were almost never reached intraday; more than half of
  positions closed at 15:45. The P&L of the rule lives in the time exit,
  which says the exit design (a full ATR from a 09:40 entry) is
  mismatched to a same-day hold. Changing it is a new experiment.
- The 40-name smoke sample's "shorts lose" did not replicate at scale
  (long +0.19%, short +0.16%): a reminder about small samples.
- Today's 11 partial-session trades, for the record only: INTC +4.7%,
  ARM +6.1%, GRAL +4.7%, AMD +1.7%, WBD +0.7%, NVO +0.2%, QUBT -0.7%,
  MSTR -1.3%, COIN -1.6%, VICR -2.7%, CRML -4.3%.

### Consequence for the trade sheet

Do not treat the sheet's gap-and-go entry as a validated edge. Forward
test it: log every scan and every trade taken or skipped; prefer the
largest gaps (10%+, or the top three of the session) with structure and
an identifiable catalyst; keep option size small until the forward log
has 30 instances. Next registration candidate: minimum gap 10% or top 3
per session, with the exit redesigned for a same-day hold.

## H-GAP-WR: win-rate study, registered 2026-09-21 ~19:50 UTC before running

Objective set by the operator: the highest win rate that still clears
costs. Same data as above (Yahoo 5-minute bars, 1,500 names), sessions
2026-07-24 through 2026-09-18; the partial session of 2026-09-21 is
excluded. Selection window: the first 20 sessions (2026-07-24 through
2026-08-20). Validation window: the remaining sessions (2026-08-21
through 2026-09-18), not used for selection. Slippage 10 bps per side
(double the base test) throughout.

Selection criterion, fixed now: highest selection-window win rate among
variants with profit factor >= 1.30, expectancy > 0 and at least 60
trades in the selection window. Report the chosen variant on the
validation window, the whole grid, the base variant, and a one-lever-
at-a-time table (each lever changed alone from the base) on both
windows.

Grid (480 variants):
- minimum gap: 3%, 5%, 10%
- structure: beyond the prior 20-session high/low (base); beyond the
  prior 252-session high/low
- direction: long only; long and short
- exit: base (half at +1 ATR, rest at +1.5 ATR, out 15:45); +1% limit
  target, out 15:45; +2% limit target, out 15:45; time exit at 10:30
  close, no target; time exit at 12:00 close, no target
- stop: close through the 09:30 candle's opposite extreme (base); close
  through the pre-market extreme
- signal cutoff: confirming candle by 09:40 (the 09:30 or 09:35 candle);
  by 11:30 (base)
- sector confirmation: none (base); the candidate's sector ETF closed its
  09:30 candle above (long) or below (short) its prior close

The open-chase filter (skip if the 09:30 open is more than 1.5% beyond
the pre-market extreme) applies to every variant. Sector ETF mapping is
the scanner's static table (src/research/sectors.ts); names without a
mapping use SPY.

Disclosures: 480 comparisons on roughly 200 selection-window trades is a
large search on a small sample; the validation window (about 18
sessions) is the only defense and is itself small. The chosen variant is
a forward-test hypothesis; the one-lever table is the more trustworthy
output. No further search after this run.

## H-GAP-WR results (2026-09-21, ~20:15 UTC)

815 candidate contexts over 39 sessions (2026-07-27 through 2026-09-18;
the first two sessions lacked enough pre-market bars). All 480 variants
at 10 bps per side are in docs/gap-grid-10bps-2026-09-21.csv.

Chosen by the declared criterion: gap >= 5%, 20-day structure, both
directions, +1% limit exit, stop at the pre-market extreme, confirmation
by 09:40, no sector gate. Selection: n=125, 87.2% win, +0.28%, PF 1.57.
**Validation: n=29, 65.5% win, -0.30% per trade, PF 0.65. FAILS.**

Every variant in the top twelve by selection win rate is negative on the
validation window (PF 0.39 to 0.85). They share the same construction: a
small fixed target with a wide stop. That buys a high win rate in a
trending period (selection, late July to August 20) and gives it back in
a choppy one (validation, after the September 16 rate hike). The base
rule was also negative in the validation window (-0.17%, PF 0.86).

One lever at a time from the base (selection / validation):

| Lever | Selection | Validation | Held? |
|---|---|---|---|
| gap >= 10% | 63.2% win, +1.03%, PF 1.80 (n=57) | 52.9%, +0.79%, PF 1.50 (n=17) | yes |
| 52-week structure | 58.8%, +0.13%, PF 1.09 (n=34) | 66.7%, +1.99%, PF 4.47 (n=12) | too few to say |
| long only | 48.7%, +0.10%, PF 1.10 | 52.4%, +0.03%, PF 1.03 | neutral |
| +1% limit exit | 73.9%, +0.06%, PF 1.10 | 55.6%, -0.39%, PF 0.55 | no |
| +2% limit exit | 59.9%, +0.12%, PF 1.14 | 47.2%, -0.28%, PF 0.72 | no |
| 10:30 time exit | 55.3%, +0.54%, PF 1.76 | 36.1%, -0.16%, PF 0.82 | no |
| 12:00 time exit | 47.5%, +0.09%, PF 1.09 | 36.1%, -0.17%, PF 0.85 | no |
| pre-market-extreme stop | 52.1%, +0.31%, PF 1.30 | 44.4%, -0.08%, PF 0.94 | no |
| confirmation by 09:40 | 49.5%, +0.28%, PF 1.24 | 43.1%, +0.08%, PF 1.06 | neutral |
| sector ETF confirmation | 48.0%, +0.09%, PF 1.08 | 39.1%, -0.31%, PF 0.76 | no (slightly worse) |

### Conclusion

H-GAP-WR is NOT QUALIFIED. On 39 sessions of data the gap-and-go win
rate cannot be raised by exit or stop design without destroying
expectancy out of sample. The one robust lever is gap magnitude: the
10%+ bucket is the only slice positive in both windows (n=57 and n=17,
so still thin). What is built from this: the scanner separates trade
candidates (gap >= 10% with structure) from watch-only names (5 to 10%)
and drops 3 to 5% gaps by default. The entry, stop and exit rules stay
as registered (first 5-minute close beyond the pre-market extreme, stop
through the 09:30 candle, +1 and +1.5 ATR, 15:45). Expect about 55 to
63% win on the stock for the 10%+ bucket, lower for the option.

Ways to improve that remain, none of them a parameter: more history
(Schwab minute bars on the operator's machine may reach further back
than Yahoo's 60 days; worth checking), pre-market volume as a filter
(available live on Schwab, not in this test), catalyst quality (the news
ledger and Jev, not backtestable here), and the forward log.
