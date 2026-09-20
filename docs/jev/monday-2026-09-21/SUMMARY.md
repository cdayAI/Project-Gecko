# Jev live run, Monday 2026-09-21 candidates: NOT RUN

Run attempted on 2026-09-20 (UTC) in a Claude Code remote session from checkout
`codex/sept-17-19-work` (commit 90802c4). Target symbols: HOOD, AMD, SPCX, NCLH,
META, COIN, MSTR.

## Outcome

Stopped at step 1 (key check). No build, no news collection, no probe, and no
live classification were run. Zero TypeSafe/Jev requests were made, so no
inference charges were incurred by this session.

## Step 1 result: key variable not present

The step 1 check (count of environment lines whose name is `TYPESAFE_API_KEY`)
returned 0.

The variable `TYPESAFE_API_KEY` is not present in the session environment.

Environment variable names containing `JEV` or `TYPESAFE` (case-insensitive):
none. A value-level grep matched one unrelated harness policy variable
(`CCR_AUTO_MODE_ALLOW`); its name does not contain either string and it is not
a credential.

The Jev CLI reads the key only from `process.env.TYPESAFE_API_KEY`
(`src/research/jev/jev-cli.ts`, probe and live modes both throw without it), so
steps 4 and 5 could not have run.

## Observation for the operator (no action taken)

The session's system configuration states that the outbound proxy injects
credentials for `typesafe.ai` at the network layer. That is a different
mechanism from the environment variable the CLI checks. Whether the proxy
injection would actually authenticate a Jev request was not tested, because
the task's bounded instructions were to stop when the variable is absent. If
you want a run through the proxy, the CLI would need either the variable set
in the session environment or an explicit change to accept proxy-supplied
authentication. Neither was done here.

## Steps not executed

- Step 2: `npm install`, `npm run build`, `npm run jev:selftest`
- Step 3: `npm run news` collection for the seven symbols
- Step 4: probe (1 request)
- Step 5: live classification (12 request cap)
- Step 6: per-symbol headline classification tables and flags

Requests attempted: 0. Succeeded: 0. Invalid: 0. Input tokens: 0. Estimated
cost: $0.00.

Jev classifies news facts (event type, guidance changes, commercial commitment
stage, dilution, thesis relation, evidence scope). It does not predict prices.
