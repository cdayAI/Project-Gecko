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

## Results (2026-09-21, ~18:40 UTC)

Runs completed over 1,691 names with usable history (43 had fewer than 260
sessions), signal window 2024-07-12 through 2026-09-21, base 10 bps per
side and a 20 bps stress. Full per-slice output is in the session log;
the gate-relevant lines:

| Line | n | Win | Expectancy | PF | Net at $1k/trade |
|---|---:|---:|---:|---:|---:|
| H-PULL all | 4,350 | 39.3% | -0.04% | 0.99 | -$1,741 |
| H-PULL gated (SPY > 50d) | 3,227 | 38.9% | +0.05% | 1.02 | +$1,623 (without best month -$2,868) |
| H-PULL all at 20 bps | 4,350 | 38.2% | -0.24% | 0.92 | -$10,574 |
| H-BOUNCE all | 17,317 | 60.9% | +0.26% | 1.17 | +$45,141 |
| H-BOUNCE all at 20 bps | 17,317 | 58.1% | +0.06% | 1.04 | +$10,093 |
| H-BOUNCE all without best month (2026-07) | | | | | +$32,360 |
| H-BOUNCE best symbol share (NBIS) | | | | | 3% of net |
| H-BOUNCE gated (SPY > 50d) | 11,983 | 58.6% | +0.07% | 1.05 | +$8,881 (at 20 bps -$15,316) |
| H-BOUNCE when SPY < 50d | 5,334 | 66.0% | +0.68% | 1.45 | +$36,260 (at 20 bps +$25,408) |
| H-BOUNCE 5-slot book, ranked by drop, ungated | 730 | 55.8% | -0.11% | 0.94 | -$803 |

H-BOUNCE quarters (all): 2024Q3 +0.52, Q4 +0.06, 2025Q1 -0.37, Q2 +0.89,
Q3 +0.37, Q4 +0.16, 2026Q1 -0.04, Q2 +0.37, Q3 +0.71 (percent per trade).
Exit mix: target 75%, stop 8%, time 16%; average hold 3.3 sessions.

### Gate evaluation

H-PULL fails (negative ungated, gated result depends on one month and
one symbol, negative at double cost). NOT QUALIFIED. Not built.

H-BOUNCE (ungated) passes every registered gate: n far above 100,
expectancy +0.26%, profit factor 1.17, positive in at least three of
every four consecutive quarters, positive at double cost (+0.06%, PF
1.04, thin), positive without the best month, best symbol 3% of net.
QUALIFIED for research priority and for a scan. The SPY > 50-day gate
made it worse, not better; the registered gate direction was wrong for
a liquidity-provision strategy.

### Observations retained (post hoc), and what was built from them

- Ranked by size of drop, a 5-slot book was negative without any gate.
  Cutting the same trades by how many names qualified that day
  (breadth) explains it: fewer than 10 signals a day, -1.13% per trade
  (PF 0.56); 10-29, -0.19%; 30-74, +0.15%; 75 or more, +0.76% (PF 1.59).
  Breadth 30+ with drops of 2.5 ATR or more: +0.91%, PF 1.77, n=2,802.
  A 5-slot book taken only on breadth >= 30 days, ranked by drop: +0.40%
  per trade, PF 1.25, n=424 over 134 days; on breadth >= 75 days +0.84%,
  PF 1.67, n=175 over 38 days. Mechanism: market-wide oversold days
  bounce; isolated large drops are news and continue.
- Drop size is monotonic on its own (1.5-2 ATR +0.08%, 2-3 +0.37%,
  3+ +0.90%), the opposite of the earlier adverse-selection guess.
- Results conditioned on holding period are look-ahead and not usable.
- Built: `npm run scan:swing` (src/research/swing-scan.ts). Prints the
  breadth count with a TRADE / STAND ASIDE verdict at 30 (strong at 75),
  the SPY regime, and candidates ranked by drop with an at-the-money
  call 14-35 days out. The breadth gate is a post-hoc finding and is
  registered here as H-BOUNCE-2 for forward testing; the scan shows it
  as guidance, and every signal day is logged with its breadth so the
  forward record can confirm or reject it.

### Limits

Survivorship: the universe is today's liquid names, which flatters a
dip-buying strategy (names that fell out after a "dip" are absent). The
effect size is unknown; the forward log is the correction. Entries and
exits carry overnight gaps; no intraday stop. Long only. The option
version is untested: an average edge of a few tenths of a percent per
trade over three sessions is a stock result; at-the-money calls on
breadth days with 2.5+ ATR drops are the only slice where an option
plausibly clears its spread, and that is a hypothesis.
