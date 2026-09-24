# Scorecard 2026-09-23: the 09:24 ET packet replayed with the tested rule (paper)

Bars: yahoo. Prices are the rule's, without slippage; star, large and watch rows take half at 1 ATR and the rest at 1.5 ATR, mega-cap rows hold to 15:45. Returns are on the stock.

| Sym | Tier | Side | Trigger | Result | Entry | Exit | Return | Catalyst in the packet |
|---|---|---|---|---|---:|---:|---:|---|
| INFQ | watch | long | 5m close > 15.10 | no trigger (day 13.69 to 15.06, close 13.81) | | | | none in the packet |
| QUBT | watch | long | 5m close > 9.60 | no trigger (day 9.05 to 9.76, close 9.12) | | | | none in the packet |
| QNT | watch | long | 5m close > 55.45 | stop 09:35 | 56.67 09:35 | 54.29 09:35 | -4.21% | none in the packet |
| IONQ | watch | long | 5m close > 47.10 | no trigger (day 41.63 to 46.05, close 42.55) | | | | none in the packet |
| QBTS | watch | long | 5m close > 18.77 | no trigger (day 16.75 to 18.92, close 16.82) | | | | none in the packet |
| CBRL | watch | long | 5m close > 51.52 | no trigger (day 44.52 to 49.16, close 47.55) | | | | none in the packet |
| PFG | large | short | 5m close < 100.11 | no trigger (day 111.57 to 115.54, close 113.92) | | | | none in the packet |
| PAYX | watch | short | 5m close < 104.49 | time 15:45 | 104.30 10:05 | 105.33 15:45 | -0.99% | none in the packet |
| VOYG | watch | short | 5m close < 34.02 | skipped: opened 33.23, more than 1.5% beyond the extreme | | | | none in the packet |
| SBSW | watch | short | 5m close < 10.70 | time 15:45 | 10.68 09:45 | 10.53 15:45 | +1.40% | none in the packet |

Today: 10 calls, 3 triggered. triggered calls: 3 trades, 1 won (33%), -1.27% per trade, PF 0.27, -$38 at $1000 per trade.

## Running record (every scored session)

Sessions scored: 2 (2026-09-22, 2026-09-23)
- all triggered calls: 8 trades, 3 won (38%), -0.30% per trade, PF 0.76, -$24 at $1000 per trade
- star (the tested spec): 1 trades, 0 won (0%), -4.40% per trade, PF 0.00, -$44 at $1000 per trade
- mega-cap (T2/T8, store validation pending): none yet
- large, not star: none yet
- watch (5-10%, no edge in the tests): 7 trades, 3 won (43%), +0.28% per trade, PF 1.34, +$20 at $1000 per trade
