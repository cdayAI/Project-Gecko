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
