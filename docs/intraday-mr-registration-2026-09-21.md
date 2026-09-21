# Intraday mean-reversion pilot: registration (2026-09-21, ~20:40 UTC)

Registered before any run. Operator objective: a family that can produce
5 to 15 trades per session at a 75 to 85% win rate while still clearing
costs (profit factor >= 1.3 at 10 bps per side). Mechanism: buying dips
in strong stocks intraday is liquidity provision, the same mechanism as
the qualified multi-day bounce, and the family where high win rates
live. Long only (no borrow, and puts do not pay for 1% moves).

Data: the cached Yahoo 5-minute bars (with pre/post) and daily bars for
the top 1,500 liquid optionable names, sessions 2026-07-27 through
2026-09-18 (39). Selection: sessions through 2026-08-20. Validation:
after. This is a PILOT: 39 sessions cannot qualify an intraday rule at
this frequency; the purpose is to see whether the family shows the
profile at all and to fix definitions before longer Schwab history is
pulled (docs: history:pull).

## H-FILL: faded gap-down in an uptrend

Signal day: prior close above the 200-session average; open (first RTH
bar's open) between 1% and 5% below the prior close; the 09:30 candle
closes above its open (buyers showed up). Entry at the 09:35 bar's open.
Target: a limit at the midpoint between the open and the prior close
(half gap fill). Stop: 5-minute close below the 09:30 candle's low.
Time exit: 12:00 close. Variants reported: target = full fill (prior
close); time exit 15:45; stop = 5-minute close below the open minus
0.5 ATR(14).

## H-DIP: morning dip reclaim in an uptrend

Signal day: prior close above the 20- and 200-session averages; absolute
gap under 1% (no news); between 09:35 and 10:30 the stock trades at least
0.5 ATR(14) below the open, then a 5-minute candle closes above the prior
candle's high (reclaim). Entry at the next bar's open. Target: a limit at
the session open price. Stop: 5-minute close below the intraday low at
signal. Time exit: 12:00 close. Variants: time exit 15:45; target at open
plus 0.25 ATR.

## Reporting

Per hypothesis and variant: signals per session, n, win, expectancy,
profit factor on selection, validation and all; a 10-slot book ranked by
the size of the dip (largest first); exit mix. Slippage 10 bps per side.

## Gates for continuing to the longer-history test

Validation win rate >= 65% with validation PF >= 1.2 for at least one
variant per hypothesis. A family that fails both is dropped. Nothing here
is a live approval; the 39-session pilot is far too small for that and
is disclosed as such.

## Results (2026-09-21, ~21:05 UTC)

58,949 name-sessions over 40 sessions (2026-07-24 through 2026-09-18),
1,500 names, 10 bps per side. Selection: first 20 sessions; validation:
the remaining 20.

| Variant | Signals/day | All: win / exp / PF | Validation: win / exp / PF |
|---|---:|---|---|
| FILL half-fill, stop 09:30 low, out 12:00 | 40.6 | 53.5% / -0.14% / 0.63 | 56.8% / -0.12% / 0.68 |
| FILL full-fill, stop 09:30 low, out 12:00 | 63.1 | 49.0% / -0.12% / 0.76 | 52.3% / -0.07% / 0.85 |
| FILL half-fill, stop 09:30 low, out 15:45 | 40.6 | 54.0% / -0.15% / 0.62 | 57.0% / -0.12% / 0.69 |
| FILL half-fill, stop open - 0.5 ATR, out 12:00 | 41.7 | 62.5% / -0.09% / 0.76 | 67.9% / -0.02% / 0.94 |
| DIP target open, stop signal low, out 12:00 | 56.0 | 38.9% / -0.27% / 0.47 | 39.6% / -0.26% / 0.47 |
| DIP target open, out 15:45 | 56.0 | 38.8% / -0.28% / 0.52 | 39.7% / -0.30% / 0.49 |
| DIP target open + 0.25 ATR, out 12:00 | 59.3 | 35.7% / -0.27% / 0.48 | 36.0% / -0.27% / 0.48 |

Ten-slot books (largest dips per session) do not change the picture:
H-FILL best book 65.0% win, PF 0.85 (validation 69.9%, PF 0.99); H-DIP
books 37-39% win, PF about 0.5.

### Gate evaluation

H-DIP fails every variant by a wide margin (win rates under 40%, PF
under 0.6). Dropped. The morning dip in a strong stock on a no-news day
does not revert by noon at this definition; it continues.

H-FILL fails as registered: the best variant reaches 67.9% validation
win rate but PF 0.94 (gate 1.20). The family has the shape the operator
asked for (two wins for every loss) and not the economics: average wins
of 0.45 to 0.65% against average losses of 1.0 to 1.4% leave a negative
expectancy after 10 bps per side. One post-hoc slice is suggestive and is
recorded as such, not promoted: the open - 0.5 ATR stop variant taking
the 15 largest gap-downs per session was 71.1% win, +0.08%, PF 1.23 on
the validation window (n=266), and 2 to 3% gaps under that variant were
75.0% win on validation with negative expectancy overall.

### Consequence

Nothing from this pilot is built into a scan. H-FILL (open - 0.5 ATR
stop, half fill, out 12:00, top 15 per session by gap size, gaps 2 to
5%) is the registered candidate for the longer-history test once
`npm run history:pull` has filled the store from Schwab; that test will
also model 5 bps per side for large caps, where the assumption is
realistic, since at these payoff ratios the cost assumption decides the
result. Until then the intraday book remains the 10%+ catalyst gap
tier only.

### What the pilot says about the operator's target

Five to fifteen trades a day at 75 to 85% has not been demonstrated by
any family tested here with a positive profit factor. Measured
frontier so far, validation windows, after costs: about 65 to 71% at
3 to 12 trades a day (multi-day bounce family, PF 1.3 to 1.6; more than
100 candidates on panic days); 75% only with the rare panic gates (PF
2.6, about one active day a month); intraday dip buying 62 to 71% at
5 to 15 a day but not profitable at 10 bps; catalyst gaps 55 to 63% at
1 to 3 a day. Longer intraday history is the next lever; it is a data
problem before it is a rule problem.

## Store run: 69 sessions from Schwab 5-minute history (2026-09-21, ~21:00 UTC)

Rerun from the operator's Schwab store (docs/results/mr-store.txt,
mr-store.jsonl). Only 69 sessions (2026-06-11 through 2026-09-18) were
usable because the pilot's 400-day daily lookback did not supply 205
prior sessions for earlier dates; fixed to 600 days after this run.
101,535 name-sessions, 10 bps per side, median split at 2026-07-30.

| Variant | Signals/day | All: win / exp / PF | Validation: win / exp / PF |
|---|---:|---|---|
| FILL half-fill, stop 09:30 low, out 12:00 | 38.4 | 56.7% / -0.17% / 0.60 | 57.2% / -0.11% / 0.69 |
| FILL full-fill, stop 09:30 low, out 12:00 | 61.2 | 51.7% / -0.14% / 0.75 | 53.0% / -0.06% / 0.86 |
| FILL half-fill, stop open - 0.5 ATR, out 12:00 | 39.4 | 65.2% / -0.14% / 0.68 | 66.5% / -0.04% / 0.88 |
| DIP (all three variants) | 60-64 | 37-39% / -0.25 to -0.29% / 0.49-0.53 | same |

Ten-slot books: best validation PF 1.06-1.07 (full-fill and open - 0.5
ATR variants), expectancy about zero. Same shape as the 40-session
pilot: high win rates for H-FILL, losers about twice the size of
winners, negative or zero expectancy at 10 bps. Both hypotheses fail
their gates again. Dropped at these definitions.
