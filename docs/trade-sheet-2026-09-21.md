# Trade sheet, Monday 2026-09-21 (all times ET)

Companion to docs/monday-plan-2026-09-21.md (registered 2026-09-20). Quotes
are Friday's Cboe delayed closing marks; they set price caps, not fills.
Sizing is the operator's $1,000-per-position rule. "Planned loss" assumes
the stop executes near the stated level; the full premium is the maximum.

## Pre-open checklist (09:00-09:25)

1. SPY futures within 1.2% of Friday's close (761.69). Outside that: no
   trades, reassess at 10:00.
2. Bitcoin at or above $80,000 (Friday close ~$80,941). Below $78,500:
   cancel trade 1.
3. Scan headlines for HOOD/COIN (SEC tokenization follow-ups), AMD/semis
   (US-China export-control or licensing news ahead of Thursday's summit),
   SPCX (any index or lock-up news), META, NCLH/CCL (oil).
4. Goolsbee speaks 10:30. Do not place a new entry 10:25-10:35.
5. Let the 09:30-09:45 opening range form. No entries before 09:45.

## Sheet

| # | Trade | Exact option (OCC symbol) | Enter when (underlying) | Entry window | Underlying entry zone | Max option price | Qty (cost) | Exit at target | Exit at stop | Time exit | Cancel if |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | HOOD long | 02-Oct-2026 $120 call, HOOD261002C00120000 (Fri 5.60/5.80, delta 0.52) | Completed 5-min close above 120.60 with BTC >= $80,000; or pullback to 116.50-117.50 that holds, then 5-min close back above 118.50 | 09:45-11:30 | 120.60-121.50 (breakout) or 118.50-119.20 (pullback) | $5.90 | 1 ($590). Alt: 25-Sep $120 call HOOD260925C00120000 max $4.15 x2 ($830) | Underlying 125.00 (20d high 125.25): call ~$8.50 (+44%). Sept call ~$6.80. First resistance 123.44 (upper Bollinger band): if it stalls there twice, take +30% | 5-min close below 116.00, or bid <= 65% of entry: call ~$4.10, planned loss ~$175 (Sept x2 ~$390). Full loss $590/$830 | Tue 16:00 if HOOD has not traded above 122; hard exit Wed 11:30 | Opens above 123.00 (no chase); BTC < $78,500; SPY gap rule |
| 2 | AMD long | 02-Oct-2026 $560/$580 call debit spread, buy AMD261002C00560000 (21.50/22.20) sell AMD261002C00580000 (13.35/13.90) | 5-min close above 560.00 with SMH green; or pullback holding 548.50-552.00 (upper Bollinger band 548.62) then 5-min close back above 556.00 | 09:45-11:30 | 560.00-562.00 (breakout) or 556.00-558.00 (pullback) | $8.90 net debit | 1 spread ($890). Alt: 25-Sep $560/$580 (AMD260925C00560000 / AMD260925C00580000) max $8.00, 1 spread ($800) | Underlying 578.00-580.00 (ATH 580.91): spread ~$14.00 (+57%). Rest a sell-to-close limit at $14.00 once filled | 5-min close below 541.50 (Friday low), or spread <= 55% of entry (~$4.90): planned loss ~$440. Full loss $890/$800 | Thu 01-Oct 15:45 (Oct spread); Fri 25-Sep 15:30 (Sept spread) | Opens above 570.00; SMH down > 1.5% pre-market; negative NVDA/MU/export-control headline |
| 3 | SPCX short (puts) | 02-Oct-2026 $150 put, SPCX261002P00150000 (Fri 4.20/4.35, delta -0.40, OI 1,815) | Completed 5-min close below 149.90 (Friday low). Entry only while SPCX >= 148.50 | 09:45-11:30, none after 11:30 | 148.50-149.90 | $4.75 | 2 ($950). Alt: 25-Sep $150 put SPCX260925P00150000 max $2.90 x3 ($870) | Sell 1 at underlying 145.30 (SMA20): put ~$7.00 (+47%). Sell 1 at 142.50 (SMA200 142.79): put ~$9.20 (+94%) | 5-min close above 153.50: put ~$3.10 (-35%), planned loss ~$330. Full loss $950/$870 | Wed 11:30 if neither target hit | Opens above 156.90 (20d high / upper band 156.81); holds above 152.00 through 11:30; volume surging into Monday's close means the index flow was Monday, stand aside |
| 4 | META short (puts) | 25-Sep-2026 $650 put, META260925P00650000 (Fri 7.50/8.00, delta -0.33, OI 2,333) | Completed 5-min close below 660.80 (Friday low) | 09:45-11:30 | 658.00-660.80 | $8.20 | 1 ($820). Alt: 02-Oct $640 put META261002P00640000 max $9.50 x1 ($950) | Underlying 639.00 (Friday low minus one ATR): put ~$13.00 (+58%). Rest a sell-to-close limit at $13.00 | 5-min close above 675.00: put ~$4.00 (-51%), planned loss ~$420. Full loss $820/$950 | Wed 11:30 | Opens above 672.00; SPY gap rule |
| 5 | NCLH short (puts) | 02-Oct-2026 $14 put, NCLH261002P00014000 (Fri 0.40/0.46, delta -0.44, OI 299) | Preferred: bounce into 14.35-14.45 that fails, then 5-min close below 14.25. Secondary: 5-min close below 14.05 (RSI 25 on the lower band: breakdowns here get squeezed, so prefer selling the bounce) | 09:45-11:30 | 14.10-14.25 (failed bounce) or 13.95-14.05 (breakdown) | $0.48 | 20 ($960). Limit orders only; spread is 13% of premium | Underlying 13.30: put ~$0.85 (+77%). Rest a sell-to-close limit at $0.85 | 5-min close above 14.50: put ~$0.27 (-44%), planned loss ~$420. Full loss $960 | Fri 25-Sep 15:45 regardless (CCL reports Mon 29-Sep) | Oil down > 3% pre-market; gaps below 13.80 (no chase) |

## Execution mechanics

- Entries: buy to open with a limit at or below the max option price. If
  the fill does not come within two 5-minute bars of the trigger, cancel
  the order and skip the trade.
- Targets: as soon as filled, rest a sell-to-close limit at the option
  target. If the underlying target prints first, sell at the bid.
- Stops: on a completed 5-minute close beyond the underlying stop, sell to
  close with a limit 5% below the current bid. Do not wait for the option
  stop if the underlying stop has printed.
- Max 3 positions open, no more than 2 in the same direction. Stop for the
  day at -$500 realized. Close all Sept-25 expiries by Wed 11:30 unless at
  target (Powell Wed, summit and GDP/durables/claims Thu, PCE Fri).

## Indicator context (daily bars through Friday 2026-09-18)

| Symbol | RSI14 | MACD hist (12,26,9) | Bollinger %B (20,2) | Upper / lower band | SMA20 / 50 / 200 | ATR14 |
|---|---:|---:|---:|---|---|---|
| HOOD | 60 | -0.28 rising | 0.85 | 123.44 / 99.15 | 111.29 / 103.17 / 94.90 | 7.21 (6.0%) |
| AMD | 66 | +8.43 rising | 1.10 (above band) | 548.62 / 432.89 | 490.75 / 495.85 / 354.62 | 22.33 (4.0%) |
| SPCX | 59 | +0.41 falling | 0.82 | 156.81 / 133.86 | 145.33 / 134.63 / 142.79 | 6.88 (4.5%) |
| META | 66 | +7.80 falling | 0.80 | 701.13 / 528.09 | 614.61 / 607.38 / 624.16 | 21.79 (3.3%) |
| NCLH | 25 | -0.03 rising | 0.15 | 17.72 / 13.49 | 15.60 / 17.77 / 19.69 | 0.52 (3.7%) |
| SPY | 49 | -1.16 rising | 0.36 | 773.58 / 755.02 | 764.30 / 759.73 / 716.28 | 6.55 (0.9%) |

What was actually used to select and set levels: 5/20/60-day returns and
relative strength versus SPY; price versus the 20/50/200-day averages;
distance from the 20-day high or low and the 52-week high; ATR(14) for
target and stop distances; Friday's relative volume and closing strength;
the opening range and completed 5-minute closes through Friday's high or
low for triggers; session VWAP as the side-of-trade filter; option delta,
IV30, open interest and bid/ask drag from the Cboe chains. RSI, MACD and
Bollinger Bands are computed above for reference. They are transformations
of the same closes and volatility, so they agree with the measures above
by construction and do not count as independent confirmation.

## Scoring

Record per trade: no trigger / triggered and filled (price, quantity) /
triggered and not filled / cancelled; exit price and reason; net of fees.
Review after Friday's close.
