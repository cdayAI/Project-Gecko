# Forward log and daily packet

The forward log is the record that decides which setups are real. Two
commands a day carry everything between the operator and the research
partner: the night list after 20:00 ET and the morning run at 08:50 ET.

## Evening (after 20:00 ET)

```powershell
git pull origin claude/epic-johnson-a4kh4c
npm run evening -- --provider schwab --push
```

Builds the night list for the next session in `docs/daily/<next session>/`
and pushes `docs/daily` and `docs/log` to `codex/daily-<next session>`.
About 15 minutes, most of it the swing scan (`--no-swing` skips it).
Say "night list is up"; the partner grades it and pushes
`docs/daily/<next session>/review.md` to the working branch, which the
morning `git pull` brings down.

- `plan.md`: tier 1, gap candidates for the morning validation: after-hours
  movers (3% or more on 20k shares), names reporting after the close or
  before the next open (Nasdaq calendar), continuation names (8% day,
  closed in the top quarter of the range, through the 20-day level). Each
  row carries the close, the star level (close +10%), the 20-day high,
  ATR targets, the sector ETF's day, the contract the rule would use at
  tonight's marks, headline count, Jev's label and the top headline.
  Tier 2 is the bounce book with both breadth gates. Tier 3 is a reminder
  that 5-10% gap rows are paper. The header carries the tape, macro
  events, the earnings list and today's monitor record.
- `plan.json`: the same candidates, read by the morning packet.
- `plan-news.md`, `plan-jev.md`, `plan-swing.txt`: the evidence.

## Morning (08:50 ET)

```powershell
git pull origin claude/epic-johnson-a4kh4c
npm run morning
```

Runs the packet (`scan:gap` over the whole universe with Schwab,
headlines, Jev, and the validation table against the night list:
CONFIRMED star, GAPPED but not star with the reason, NO GAP, NEW), pushes
it to `codex/daily-YYYY-MM-DD`, then starts the live monitor at 09:30 in
the same window. Say "packet is up". Files: `README.md` (validation
table, star rows, other gap rows, Jev status, forward-log summary),
`scan-gap.txt`, `news.md`, `jev.md`, and `live.txt`, rewritten every 30
seconds by the monitor.

## During the session

The monitor (`npm run live` on its own, if the morning window was closed)
reads the packet's gap rows (pre-market high and low, ATR, long for gap
up, short for gap down), pulls Schwab minute bars through the vault every
30 seconds, and applies the registered rule candle by candle: skip if the
open is more than 1.5% beyond the pre-market extreme, entry on the first
5-minute close beyond it from 09:35, stop on a 5-minute close through the
09:30 candle's opposite extreme, half at 1 ATR, rest at 1.5 ATR, time
exit 15:45. Each row shows WAITING, IN, SKIPPED or DONE with the entry,
stop and target prices and the last four candles; watch rows are marked
paper only. `--once` prints one snapshot; `--symbols ONON,ECO` narrows it
or adds names that are not in the packet; `--interval 20` refreshes
faster. It never places orders.

## After the close

The evening command carries `live.txt`, so the partner writes the log
records from the monitor's entries and exits plus the fills you report.
Send fills as symbol, side, size, entry and exit prices with times. The
log commands remain for anything manual:

```powershell
npm run log -- add --date 2026-09-22 --symbol XYZ --side long --source gap --tier star --gap 12.4 --sector "SMH +1.8%" --catalyst "what you believed the reason was" --taken yes --instrument stock --qty 20 --entry 51.20 --entry-time 09:40 --stop 49.80 --target1 53.10 --target2 54.05 --exit 53.10 --exit-time 10:25 --exit-reason target1 --fees 0
npm run log -- add --date 2026-09-22 --symbol ABC --source gap --tier watch --gap 6.1 --catalyst "none found" --taken no --entry 22.10 --entry-time 09:40 --stop 21.40 --exit 21.95 --exit-time 15:45 --exit-reason time --notes "watched; rule replay"
npm run log -- report
```

Rules for the log: `--taken yes` only for real fills, at the actual fill
prices; watched setups get the rule's replay prices so the two groups
can be compared; `--catalyst` is what you believed at decision time, not
what you learned later; an option leg uses the OCC symbol as
`--instrument` and per-contract prices. `npm run log -- close --id <id>
--exit ... --exit-reason ...` finishes an open record. `npm run log --
list` shows the last 30.

`npm run packet` still exists on its own (`--provider schwab --push`,
`--no-swing`); runs after 09:30 ET are labelled `-intraday` or `-close`
automatically so they never overwrite the morning packet, and an
after-open scan is a recap of the day's movers, not tomorrow's gap list.

## What the log answers, and when

The report groups by taken/watched, stock/option, source, tier, and
whether a catalyst was named. The comparisons that matter: star rows vs
watch rows, and named-catalyst vs none. Thirty closed records per group
before reading anything into it. The registered backtests could not see
catalysts or pre-market volume; the log can, and it is the only evidence
that can promote a setup from "possibly chance" to "edge", or retire it.

## How the partner reads it

```
git fetch origin codex/daily-YYYY-MM-DD && git checkout origin/codex/daily-YYYY-MM-DD -- docs/daily docs/log
```

The packet branch is a transport branch; the partner merges packets back
into the working branch so the log stays in one place.
