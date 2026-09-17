# Gecko

Gecko's current development path is a **manual options research desk**: attributed news, qualified Webull quotes, conditional local alerts, actual-fill journaling and reproducible strategy diagnostics. The operator makes all trading decisions and executes manually. `npm run dev` and `npm start` now enter this data-only desk.

Start with [the manual desk guide](docs/manual-trading-desk.md), [news collection](docs/news-pipeline.md), and [backtesting evidence](docs/manual-backtesting.md). The initial simple underlying ORB diagnostic lost money after its declared costs in both discovery and holdout; no profitable options strategy is established. Live TypeScript Webull qualification and historical options evidence remain external work.

The [research mandate](docs/RESEARCH_MANDATE.md) governs further work. The frozen four-family campaign (`npm run research:edge -- --prepare`, then `--run=<saved-directory>`) compares eight symbols with conservative fills and costs, retains every failed hypothesis, and never calls stock returns options profits. [Historical options acquisition evidence](docs/historical-options-data.md) documents a successfully retrieved public sample and the remaining data requirements.

The [September 17 four-family result](docs/edge-screen-results-2026-09-17.md) rejected every tested hypothesis after costs. This is exploratory underlying evidence, not options P&L; 229 passing software checks do not change that result.

[Current-option valuation research](docs/option-valuation-results-2026-09-17.md) now compares actual delayed option premiums with historical expiry-payoff scenarios and audits the underlying forecast through rolling tests. It identified three preliminary price leads, but weak forecast calibration, cost/risk limits and data gaps prevent trade qualification. `npm run research:value -- --replay=<saved-study-directory>` reproduces the saved experiment.

```sh
npm ci --ignore-scripts
npm run build
npm run desk -- --doctor
npm run desk:demo
npm run backtest:manual
```

The older automated stock/0DTE system remains below for reference, with `legacy:dev` and `legacy:start` entry points. Its reconciliation and hard-risk gaps have not been cleared by the manual-desk checks. The legacy deployment configuration still targets that older application; use the separate manual runbook.

> ## Disclaimer: use at your own risk
>
> This software places real orders with real money when configured to do so. Day trading and 0DTE options trading are extremely risky; you can lose your entire account, and leveraged instruments can lose value faster than any stop-loss can react.
>
> - This project is **not financial advice** and comes with **no warranty** of any kind (see [LICENSE](LICENSE)).
> - Nothing here guarantees profitability. Backtest results do not predict live results.
> - The authors and contributors accept **no liability** for any losses incurred by running this software.
> - Always start with `LIVE_TRADING=false`, backtest, shadow trade, and understand every line of the risk layer before risking a single dollar.
> - Automated trading may have regulatory and broker-agreement implications in your jurisdiction. That is your responsibility to verify.

## What it does

Three layers stacked into one bot:

- **Engine A: Opening Range Breakout (equities).** A premarket scanner finds liquid stocks gapping more than 2% on news. The 9:30-9:45 ET high/low defines the opening range; breakouts are traded with a stop at the opposite side of the range (or VWAP), a 2R take-profit, and an 11:30 ET time-stop. Additional engines (0DTE SPY scalps, mean reversion, earnings catalysts, pairs) follow the same `Strategy` interface.
- **Engine B: 0DTE SPY options.** Only on strong-trend mornings, buys ATM same-day SPY calls or puts on a pullback to VWAP. Hard-capped contract count, trade count, and a 14:00 ET time-stop.
- **Intelligence layer.** A Claude-powered "agent brain" validates every candidate trade with full market context (regime, breadth, sector strength, multi-timeframe confluence, news) and produces a conviction score that gates and sizes the entry. A self-tuner recomputes win rates per setup bucket after every N closed trades and adjusts thresholds within bounds.

A dedicated risk layer sits in front of everything: per-trade risk caps, a daily loss limit that halts all trading, a day-trade (PDT) counter, a kill switch checked before every order, and an automatic trading pause if the market data stream disconnects.

## Requirements

- Node.js 20 LTS or newer
- An Interactive Brokers account plus the [IBKR Client Portal Gateway](https://www.interactivebrokers.com/campus/ibkr-api-page/cpapi-v1/) (Java) running locally
- An [Anthropic API key](https://console.anthropic.com/) for the intelligence layer
- Optional: a Telegram bot token and/or Discord webhook for alerts

## Quick start (dry run)

```bash
git clone https://github.com/cdayAI/Project-Gecko.git
cd Project-Gecko
npm install

cp .env.example .env
# Edit .env: set BROKER, ANTHROPIC_API_KEY, and keep LIVE_TRADING=false

npm run build
npm run legacy:dev
```

With `LIVE_TRADING=false` the bot runs the full pipeline (scanning, signals, risk checks, brain validation) and logs what it *would* do without submitting any orders. Keep it that way until you have validated the system end to end.

### First-time broker auth (IBKR)

Start the Client Portal Gateway, log in once via the browser, then capture the session:

```bash
npm run auth:ibkr
```

The session token is written to `data/ibkr-tokens.json` (gitignored) and kept alive by the bot. See `deploy/README.md` for the full walkthrough, including running headless on a VPS.

## Commands

| Command | Purpose |
|---|---|
| `npm run build` | Type-check and compile |
| `npm run dev` | Run the bot from source (respects `LIVE_TRADING`) |
| `npm run start` | Run the compiled bot |
| `npm run auth:ibkr` | Capture an IBKR Gateway session token |
| `npm run auth` | Schwab OAuth flow (legacy) |
| `npm run backtest` | Event-driven backtest on broker historical bars |
| `npm run backtest:yahoo` | Backtest using free Yahoo Finance bars |
| `npm run shadow` | Shadow (paper) trading against live data |
| `npm run stress` | Failure-mode stress tests |
| `npm run report` | End-of-day P&L attribution report |
| `npm run trace` | Signal-by-signal audit trail |
| `npm run research` | Build a research packet (quotes, stats, headlines, option structures) for a symbol list or the movers universe; read-only |
| `npm run research:selftest` | Verify the Webull request signer against official SDK vectors |

## Architecture

```
src/
  core/           # Config, structured JSON logger, shared types
  brokers/        # Broker-agnostic interface; IBKR (primary) + Schwab (legacy)
  data/           # Historical bars, quote cache, Yahoo fallback
  research/       # Pre-trade research engine: providers (Cboe delayed, Webull, Schwab), scanner, option analyzer, packets
  scanner/        # Premarket gap scanner, 0DTE option chain monitor
  intelligence/   # Agent brain, LLM classifier, self-tuner, regime/breadth/news
  strategies/     # ORB, 0DTE SPY, mean reversion, earnings, pairs
  execution/      # Order building, routing, fill watching, position tracking
  risk/           # Risk manager, daily stop, PDT tracker, position sizers
  backtest/       # Event-driven simulator + metrics (Sharpe, max DD, R-dist)
  shadow/         # Paper broker, replay harness, stress tests
  monitoring/     # Telegram/Discord alerts, daily report, trace CLI
  utils/          # WS manager, retry, rate limiter, JSONL persistence, time, math
```

Design constraints, coding standards, and the full strategy specifications live in [CLAUDE.md](CLAUDE.md), which also serves as the instruction file for AI coding agents working on this repo.

Deliberate non-goals: no web framework, no database (append-only JSONL under `data/`), no ORM, no DI container. The dependency surface is intentionally tiny (`dotenv` and `ws`).

## Safety model

- `LIVE_TRADING=false` is the default; nothing is submitted until you flip it.
- `KILL_SWITCH=true` halts all order submission immediately.
- Daily loss limit (`DAILY_LOSS_LIMIT_PCT`) halts trading for the day when hit.
- Per-trade risk is capped at `MAX_RISK_PER_TRADE_PCT` of account equity.
- Concurrent position counts are capped per asset class.
- A day-trade counter guards against PDT violations even after the 2026 SEC rule change, since brokers implement it on their own timelines.
- Stream disconnects longer than 60 seconds pause all trading until reconnect.

## Deployment

`deploy/README.md` documents a full VPS setup (Ubuntu 24.04): bootstrap script, IBKR Gateway install, PM2 process management, logrotate, and firewall. `ecosystem.config.cjs` defines the two PM2 processes (gateway + bot).

## Contributing

Issues and PRs are welcome. Read [CLAUDE.md](CLAUDE.md) first; it defines the coding standards (strict TypeScript, explicit return types, no `console.log`, validate every API response at the boundary) and the things this project deliberately does not do. Run `npm run build` before submitting.

## License

[MIT](LICENSE)
