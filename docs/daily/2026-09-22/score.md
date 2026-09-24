# Scorecard 2026-09-22: the 09:25 ET packet replayed with the tested rule (paper)

Bars: yahoo. Prices are the rule's, without slippage; star, large and watch rows take half at 1 ATR and the rest at 1.5 ATR, mega-cap rows hold to 15:45. Returns are on the stock.

| Sym | Tier | Side | Trigger | Result | Entry | Exit | Return | Catalyst in the packet |
|---|---|---|---|---|---:|---:|---:|---|
| VKTX | star | long | 5m close > 45.93 | no trigger (day 36.34 to 41.73, close 40.82) | | | | corporate_action 0.90: VKTX Stock Spikes 38% Premarket: Viking’s VK273 |
| ONON | star | long | 5m close > 30.80 | time 15:45 | 31.01 09:45 | 29.65 15:45 | -4.40% | none in the packet |
| VICR | watch | long | 5m close > 248.45 | target1 14:05, time 15:45 | 250.83 09:55 | 266.51 15:45 | +6.25% | contract 0.99: Vicor (VICR) Licenses its Power Patents to Another AI S |
| BB | watch | long | 5m close > 9.35 | no trigger (day 8.46 to 9.22, close 8.64) | | | | commentary 0.99: Is BlackBerry’s (TSX:BB) QNX Royalty Backlog Reframin |
| SHOP | watch | long | 5m close > 148.53 | time 15:45 | 149.24 09:40 | 148.70 15:45 | -0.37% | none in the packet |
| DGX | watch | short | 5m close < 227.00 | no trigger (day 227.24 to 237.29, close 234.75) | | | | commentary 0.66: Is This the Right Time to Add DGX Stock to Your Portf |
| ERIC | watch | short | 5m close < 9.72 | stop 09:40 | 9.69 09:35 | 9.71 09:40 | -0.15% | none in the packet |
| ECO | watch | short | 5m close < 77.78 | time 15:45 | 77.58 09:35 | 77.56 15:45 | +0.03% | none in the packet |

Today: 8 calls, 5 triggered. triggered calls: 5 trades, 2 won (40%), +0.27% per trade, PF 1.28, +$14 at $1000 per trade.

## Running record (every scored session)

Sessions scored: 1 (2026-09-22)
- all triggered calls: 5 trades, 2 won (40%), +0.27% per trade, PF 1.28, +$14 at $1000 per trade
- star (the tested spec): 1 trades, 0 won (0%), -4.40% per trade, PF 0.00, -$44 at $1000 per trade
- mega-cap (T2/T8, store validation pending): none yet
- large, not star: none yet
- watch (5-10%, no edge in the tests): 4 trades, 2 won (50%), +1.44% per trade, PF 12.09, +$58 at $1000 per trade
