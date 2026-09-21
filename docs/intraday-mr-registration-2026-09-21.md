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
