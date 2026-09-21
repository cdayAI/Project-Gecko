# Multi-day swing tests: registration (2026-09-21, ~17:40 UTC)

Registered before any run. Two hypotheses with different mechanisms from
the intraday gap-and-go rule, plus a regime overlay. Underlying-share
diagnostics on daily bars; not options results. Results are appended
below and retained whatever they show. No parameter search after results.

## Data

Yahoo daily bars, roughly three years back from 2026-09-18, for every
name in data/universe/universe.json (1,734 liquid optionable US stocks as
of 2026-09-21) plus SPY. Signals require, on the signal day, a
point-in-time 20-session average dollar volume of at least $30M so that a
name would have belonged to a liquid universe at the time. Survivorship
bias remains: names that were liquid earlier but have since delisted or
faded are absent, and names that became liquid recently are tested over
their whole history. Disclosed, not corrected. 200-session warm-up for
the long averages.

## H-PULL: pullback in a strong uptrend (buy the dip)

Signal day t, all from data through t: close above the 50-day average
which is above the 200-day; 60-session return in the top 20% of all names
with data that day (relative strength, cross-sectional); the day's low
touches or crosses the 20-day average (low <= SMA20) after the low held
above the SMA20 on each of the prior five sessions. Entry: next session's
open. Exits, evaluated on closes: stop when close < SMA20 x 0.97; target
when close >= entry + 2 x ATR(14 at signal); time after 10 sessions in
the trade. Long only.

## H-BOUNCE: oversold bounce above the 200-day (liquidity provision)

Signal day t: close above the 200-day average; three consecutive lower
closes (close t < t-1 < t-2 < t-3); the three-day decline is at least
1.5 x ATR(14 at signal). Entry: next session's open. Exits on closes:
target when close > 5-day average; stop when close < entry - 2 x ATR;
time after 5 sessions. Long only.

## H-REGIME overlay

Each hypothesis reported with and without a gate: SPY close above its
50-day average on the signal day.

## Costs and reporting

Slippage 10 basis points per side base, 20 in the stress. Per-trade
expectancy, win rate, average win and loss, profit factor, net at $1,000
per trade; by calendar quarter; with and without the regime gate; net
without the best month; share of net from the single best symbol; double
cost. Also a capped portfolio variant: at most 5 positions open, $1,000
each, new signals ranked by relative strength (H-PULL) or size of the
three-day drop (H-BOUNCE) when there are more signals than slots.

## Gates (research priority only, never live approval)

At least 100 trades; expectancy above zero net; profit factor above 1.10;
positive in at least three of every four consecutive quarters covered;
positive at double cost; positive after removing the best month; best
single symbol below 10% of net. Any failure means NOT QUALIFIED for that
hypothesis. The regime-gated variant is evaluated with the same gates as
a separate line; it may qualify when the ungated does not, and that is
reported as such, not as a tuned result.

## What gets built

Only a hypothesis that passes its gates is built into a daily scan
(`scan:swing`) that lists today's signals with contract picks. A failing
hypothesis is recorded and not built.

## Disclosures

- Definitions are textbook (relative-strength pullback to the 20-day;
  three-down-day bounce above the 200-day). They were fixed before any
  data was examined for this test. Thresholds (top 20%, 0.97, 2 ATR,
  1.5 ATR, 10 and 5 sessions) are conventional choices, not fitted.
- Exits at the close on the exit day include overnight gaps; no
  intraday stop is modeled. Entries at the next open include the
  overnight gap after the signal.
- Long only. Short versions are not tested here.
