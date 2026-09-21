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
