# Out-of-sample ORB test: registration (2026-09-20)

Registered 2026-09-20 at approximately 18:20 UTC, before any run over the
universes below. This is an underlying-share directional diagnostic of the
Engine A hypothesis as implemented. It is not an options result and it is
not a live-trading approval. Results are appended below the registration
and are retained whatever they show.

## Hypothesis H-ORB-GAP

On sessions where a $5 to $100 stock opens at least 2% away from the prior
close, the first completed 5-minute close outside the 09:30 to 09:45 ET
opening range (range width 0.5% to 5% of price) between 09:45 and 11:30 ET
predicts enough continuation to earn a positive net return after modeled
costs, with the stop at the opposite range boundary, a 2R target, an 11:30
time stop, 1% of equity risked per trade and at most 3 trades per session
across the universe.

## Rules

Exactly `src/backtest/backtest-yahoo-cli.ts` at `main` (f9ba533). The only
changes on this branch are instrumentation: a per-run `--slippage` flag,
a `--out` JSONL trade dump, a per-symbol funnel and a direction breakdown,
plus the Yahoo request throttle the June reconstruction had dropped. No
strategy parameter was changed. Fills at next-bar open plus or minus
slippage; stop takes priority when stop and target fall inside one bar;
$5,000 starting equity; 5-minute bars.

## Window

Yahoo's 5-minute history limit sets the window: 2026-07-22 through
2026-09-18, 42 sessions. None of it existed when the June rules and
watchlist were chosen on May data. Halves for the split test: H1 is
2026-07-22 to 2026-08-19, H2 is 2026-08-20 to 2026-09-18.

## Universes (fixed before running)

- U1, June-locked 7 (names chosen in May on May data; in-sample names,
  out-of-sample time): F, MARA, NIO, PLTR, RIOT, RIVN, SOFI.
- U2, backtester default 10: AFRM, AMC, F, GME, MARA, NIO, PLTR, RIOT,
  RIVN, SOFI.
- U3, broad 61, chosen by liquidity and volatility reputation with sector
  coverage and without reference to returns in the window, listed
  alphabetically. Names outside $5 to $100 at the open are skipped by the
  rule itself: AAL, ACHR, AFRM, AI, AMC, ASTS, BBAI, BEAM, BIDU, BILI,
  BNTX, BTBT, CCL, CIFR, CLSK, CORZ, CRSP, DAL, DKNG, EDIT, F, GME, HIMS,
  HOOD, HUT, INTC, IONQ, IREN, JD, JOBY, LCID, LUNR, MARA, MRNA, NCLH,
  NIO, NNE, NTLA, OKLO, PINS, PLTR, PLUG, PYPL, QBTS, QUBT, RBLX, RGTI,
  RIOT, RIVN, RKLB, ROKU, SMCI, SMR, SNAP, SOFI, SOUN, TEM, U, UAL, UPST,
  WULF.

## Runs

Per universe: (a) production, concurrent 3, slippage $0.01 per side;
(b) signal diagnostic, concurrent 99, slippage $0.01; (c) double-cost
stress, concurrent 3, slippage $0.02. Nine runs total.

## Gates (research priority only, never live approval)

The hypothesis advances to prospective paper testing only if the
production run shows all of: at least 30 closed trades; net above zero;
net above zero in both H1 and H2; net above zero at double slippage; net
above zero after removing the best single session; profit factor above
1.0 in the concurrent-99 diagnostic (so the result does not depend on
slot ordering). Any failure means NOT QUALIFIED. No parameter search
follows either outcome.

## Disclosures

- A single-symbol MARA probe over the same window was observed before this
  registration while confirming Yahoo connectivity: 12 trades, +$37.53,
  11 time-stop exits, zero target hits. No rule was changed in response.
- June 2026 results on these rules (75% win rate, profit factor 2.42) were
  measured on May data with the shadow harness, which models zero costs,
  with the AI brain disabled, on a watchlist selected from that same data.
  This test is the first look at unseen data.
- 5-minute bars coarsen the opening range to three bars. The concurrent-3
  slot allocation follows list order, which is alphabetical and not
  performance based; the concurrent-99 run removes that dependence.
- Share diagnostic only. Nothing here is an options return or a win
  probability.

## Amendment before any universe result (2026-09-20, ~18:25 UTC)

The first U3 attempt failed for every symbol except the previously cached
MARA: Yahoo rejects (HTTP 422) a 5-minute request whose start is exactly
60 days before a timestamp computed once at startup, because seconds
elapse before later symbols are requested. Lookback is set to 59 days.
Window is therefore 2026-07-23 through 2026-09-18, 41 sessions (July 22
would have been a partial session with no opening range bars). H1 is now
2026-07-23 to 2026-08-19, H2 unchanged. No rule or universe changed.

## Results (2026-09-20, ~18:30 UTC)

All nine registered runs completed with zero fetch failures. Every run is
negative. H1 and H2 are both negative in every run. Removing the best
single session makes every run worse. Doubling slippage makes every run
worse. Across all 393 signals in the uncapped U3 diagnostic, the 2R target
was reached zero times: exits were 48 stops (about -1R each) and 345 time
stops (net roughly flat). On this window the payoff structure of H-ORB-GAP
is "lose 1R when stopped, break even at 11:30, never collect 2R."

| Run | Trades | Win rate | Profit factor | Net | H1 | H2 | Net without best session | 2R hits |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| U1 production (c3, $0.01) | 44 | 43.2% | 0.71 | -$148.12 | -$88.27 | -$59.85 | -$223.94 | 0 |
| U1 diagnostic (c99, $0.01) | 44 | 43.2% | 0.71 | -$148.12 | -$88.27 | -$59.85 | -$223.94 | 0 |
| U1 double cost (c3, $0.02) | 44 | 36.4% | 0.59 | -$226.03 | -$124.74 | -$101.29 | -$299.40 | 0 |
| U2 production | 47 | 44.7% | 0.78 | -$114.23 | -$90.31 | -$23.92 | -$190.05 | 0 |
| U2 diagnostic | 48 | 43.8% | 0.77 | -$124.91 | -$90.31 | -$34.60 | -$200.72 | 0 |
| U2 double cost | 47 | 38.3% | 0.65 | -$197.01 | -$128.85 | -$68.16 | -$270.38 | 0 |
| U3 production | 118 | 43.2% | 0.54 | -$615.71 | -$371.65 | -$244.05 | -$669.35 | 0 |
| U3 diagnostic | 393 | 47.3% | 0.75 | -$1,058.89 | -$753.16 | -$305.73 | -$1,312.20 | 0 |
| U3 double cost | 118 | 37.3% | 0.43 | -$811.85 | -$456.86 | -$354.99 | -$858.57 | 0 |

Max drawdown: U3 production 14.1%, U3 diagnostic 25.0%. In the U1 and U2
production runs the daily cap never bound (diagnostic equals production),
so the June watchlist's result is the pure signal. Descriptive breakdowns
retained but not promoted (post hoc subgroups are not new hypotheses):
U3 diagnostic long side +$89 on 185 trades, short side -$1,148 on 208;
time-stop exits +$1,114, stop exits -$2,173.

### Gate evaluation

Production runs fail the first gate (net above zero) in all three
universes, and would also fail both-halves, double-cost and
best-session-removed. H-ORB-GAP is NOT QUALIFIED on 2026-07-23 to
2026-09-18. No parameter search was performed after these results.

### Not yet done at time of commit

Three sanity checks on the zero-target-hits finding were planned and not
run: a code check that the take-profit exit path fires at all (for
example at an absurd 0.5R, as a correctness probe only), a comparison of
this backtester's exits with the live strategy's exits in
`src/strategies/orb.ts`, and a run of the June shadow harness (live
pipeline, zero costs, brain off) over the same window. Until those are
done, the structural "never reaches 2R" reading is provisional; the
negative net result does not depend on it.

Trade dumps for every run were written to a session scratch directory and
are not committed; the runs are reproducible from the registered commands
while Yahoo's 60-day 5-minute window still covers the dates.
