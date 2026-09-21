# Forward log and daily packet

The forward log is the record that decides which setups are real. The
daily packet is how the scans, the headlines behind every candidate and
Jev's classifications reach the research partner in one push.

## Morning (08:50 ET)

```powershell
gecko
git pull origin claude/epic-johnson-a4kh4c
npm run packet -- --provider schwab --push
```

This runs `scan:gap` (Schwab, whole universe), `scan:swing`, pulls the
last 24 hours of attributed headlines for every candidate (Yahoo, no
key), runs Jev over them (bounded to 12 requests, via the Windows vault),
writes everything to `docs/daily/YYYY-MM-DD/`, and pushes it to
`codex/daily-YYYY-MM-DD`. Then say "packet is up" and the partner reads
it from that branch. Files:

- `README.md`: provider and tape line, star rows, other gap rows, swing
  verdict, Jev status, forward-log summary
- `scan-gap.txt`, `scan-swing.txt`: the full scanner output
- `news.md`: headlines per candidate with publisher, time and link
- `jev.md`: Jev's six-question classification per headline (catalyst
  type, guidance change, commercial commitment, dilution, thesis
  relation, evidence scope), when a key was available

## After the close

Log every decision, taken or watched, then push a closing packet:

```powershell
npm run log -- add --date 2026-09-22 --symbol XYZ --side long --source gap --tier star --gap 12.4 --sector "SMH +1.8%" --catalyst "what you believed the reason was" --taken yes --instrument stock --qty 20 --entry 51.20 --entry-time 09:40 --stop 49.80 --target1 53.10 --target2 54.05 --exit 53.10 --exit-time 10:25 --exit-reason target1 --fees 0
npm run log -- add --date 2026-09-22 --symbol ABC --source gap --tier watch --gap 6.1 --catalyst "none found" --taken no --entry 22.10 --entry-time 09:40 --stop 21.40 --exit 21.95 --exit-time 15:45 --exit-reason time --notes "watched; rule replay"
npm run log -- report
npm run packet -- --provider schwab --push --label close
```

Rules for the log: `--taken yes` only for real fills, at the actual fill
prices; watched setups get the rule's replay prices so the two groups
can be compared; `--catalyst` is what you believed at decision time, not
what you learned later; an option leg uses the OCC symbol as
`--instrument` and per-contract prices. `npm run log -- close --id <id>
--exit ... --exit-reason ...` finishes an open record. `npm run log --
list` shows the last 30.

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
