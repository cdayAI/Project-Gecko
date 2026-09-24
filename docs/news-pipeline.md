# Attributed news intake for the manual desk

This module collects evidence for human review. It never sends an order, posts to a chat, signs up for a data product, or calls an LLM. The CLI performs one bounded poll and exits by default. Explicit `--watch` enables sequential polling, not a provider stream.

## Read-only sources

| Source | Implemented read | Required local configuration | Coverage limits |
| --- | --- | --- | --- |
| Yahoo | Existing research `fetchHeadlines` search adapter | None; optional explicit company aliases | Best-effort sample, up to 20 headlines per requested symbol. URL and publication time required. Exact uppercase ticker, cashtag or configured company alias must match the headline. Search results alone do not establish relevance. |
| SEC | `data.sec.gov/submissions/CIK##########.json` | `SEC_USER_AGENT` with operator/contact email; explicit symbol-to-CIK JSON mapping | Current submissions file only, up to 1,000 inspected rows and the requested event limit. No archive crawl or body download. Only configured forms; default forms cover earnings/current reports and common registration/prospectus filings. Acceptance timestamp must specify its timezone. Returned CIK/tickers are checked against the mapping. |
| X | `api.x.com/2/tweets/search/recent` | `X_BEARER_TOKEN` from an entitled account; optional author allowlist | One page, up to 100 posts, recent-search window capped below seven days. Cashtag query excludes reposts but may include replies. No private messages, group history, arbitrary browsing, stream or automatic pagination. A returned next page or partial error marks source health partial. |
| Benzinga | `api.benzinga.com/api/v2/news` with `displayOutput=headline` | `BENZINGA_API_KEY` and suitable news entitlement | One page, up to 100 headlines with provider ticker tags. Full text is not requested. Reaching the page bound marks coverage partial. No entitlement or redistribution right is implied. |

Credentials enter adapter constructors from environment variables. They are not CLI arguments or stored events. Provider errors omit URLs, headers, response bodies and nested error messages. This matters particularly for Benzinga, whose documented authentication uses a query parameter. HTTP redirects are refused. Missing credentials return `auth-required` without sending a request; the CLI exits with status 2. Do not paste credentials into chat.

Public SEC endpoints do not require API credentials, but the adapter requires a declared operator contact and spaces requests by at least 150 ms within a poll. Coordinate all processes sharing an IP with the SEC's aggregate fair-access limit; multiple workers are not a way around that limit. No contact identity is invented by this module.

## Usage

Run from the repository root. `--once` is optional and is the default. Repeated reads require explicit `--watch`.

```sh
node --import tsx src/research/news/news-cli.ts --source yahoo --symbols TSLA,NVDA --aliases data/news-aliases.json --max-age-minutes 240 --once
node --import tsx src/research/news/news-cli.ts --source sec --symbols TSLA --ciks data/news-ciks.json --max-age-minutes 1440 --once
node --import tsx src/research/news/news-cli.ts --source x --symbols TSLA,NVDA --authors chosen_account --max-age-minutes 30 --once
node --import tsx src/research/news/news-cli.ts --source benzinga --symbols TSLA,NVDA --max-age-minutes 60 --once
node --import tsx src/research/news/news-cli.ts --source yahoo --symbols TSLA,NVDA --aliases data/news-aliases.json --watch --interval-ms 60000 --cycles 5
node --import tsx src/research/news/news-cli.ts --source x --symbols TSLA --watch --interval-ms 60000 --max-requests 3
node --import tsx src/research/news/news-cli.ts --health
node --import tsx src/research/news/news-selftest.ts
```

Alias file shape: `{"TSLA":["Tesla"],"NVDA":["Nvidia"]}`. CIK file shape: `{"TSLA":"0001318605"}`. Supply mappings deliberately and review them; the adapter does not infer or search for a similarly named issuer. A map mismatch returns source failure instead of silently attaching another company's filing.

`--directory` defaults to `data/news`; `--limit` defaults to 20 per symbol, with a 100-row combined cap for X/Benzinga. The request is limited to 20 explicit tickers. `--max-age-minutes` defaults to 1,440 and cannot exceed 31 days. X's provider window is narrower. The module reads `.env` locally through dotenv when the CLI runs; no credential is printed.

## Continuous collection and request bounds

`--watch` waits at least `--interval-ms` after each completed cycle; the minimum and default are 60,000 ms. Polls never overlap, so a slow read lengthens the cadence rather than queuing catch-up requests. Intervals above the JavaScript timer limit are rejected rather than wrapping into fast polling. Yahoo/SEC may run until interrupted only when `--watch` is explicitly present. Without it, all sources perform at most one cycle.

For X or Benzinga, `--watch` must include a positive `--cycles` or `--max-requests` bound. Both may be supplied; the first limit reached stops the collector. The scheduler fixes each cycle's maximum request cost before the first cycle: one for X/Benzinga, the explicit ticker count for Yahoo/SEC. It reserves that full amount before starting each cycle and never refunds reservations after partial reads, missing authentication or exceptions. Source health separately reports actual request attempts, or a labeled conservative bound when an unexpected exception prevented reporting. This monotonically increasing reservation counter cannot exceed `--max-requests`. A cycle that cannot fit the remaining budget is not started.

Bounds apply to this invocation, not to account-wide spending. A manual restart creates a new budget. Do not configure automatic restarts for a paid collector under the assumption that its previous request cap persists. A request cap is not a dollar cap: provider billing may depend on returned posts or product entitlements. This module does not buy access or change provider spending settings.

Auth, rate-limit, configuration and provider-error statuses stop collection; they do not trigger automatic paid retries. Bounded partial reads can continue while the caller's explicit limits allow. Unexpected provider exceptions produce a sanitized durable health row. A ledger-write failure attempts a separate health append and stops; if storage itself is unwritable, the CLI fails rather than claiming a successful poll.

SIGINT/SIGTERM interrupt the scheduling wait and abort SEC/X/Benzinga HTTP reads. Yahoo reuses the existing research fetcher; an in-flight single-symbol call may finish before shutdown, but no next symbol or poll starts. Its existing request timeout is 10 seconds. When watch mode stops, it writes `unavailable` health with the stop reason; source failure retains its failure status. Historical events remain readable with their original timestamps. The CLI does not daemonize, create a scheduled task or start another process.

## Event meaning and persistence

`NewsItem` and `NewsEvent` live in `src/research/news/types.ts`. Events contain source/source ID, symbols, title or social-post text, canonical source URL, publisher, author when available, relevance basis, claim status and source timestamps. Article bodies are not stored.

- `publishedAt`: the source's publication/acceptance timestamp, in Unix milliseconds. It is never replaced by collection time. Missing or ambiguous timestamps cannot become entry evidence.
- `fetchedAt`: observed completion time of the bounded ingestion batch. Individual adapters also stamp their response receipt. It is not a claim of provider delivery latency.
- `firstSeenAt`: first successful insertion into this local ledger. It survives later revisions and process restarts.
- `sourceUpdatedAt`: provider revision time when available, currently Benzinga.
- `claimStatus`: `reported`, `commentary`, `rumor`, or `filing-notice`. There is no automatic `verified` status. Lexical rumor detection is a conservative flag, not a comprehensive truth classifier. Absence of the flag is not confirmation.

`events.jsonl` is append-only. Repeated source IDs with identical content are skipped; changed content becomes a new revision with the same stable event ID and original first-seen timestamp. Canonical URL matching marks cross-source copies with `duplicateOf`, preserving attribution without counting the copy as independent corroboration. Social posts linking the same article are not semantic deduplicated; no clustering or independent-source count is claimed. Tracking query parameters and URL fragments are removed; other URL parameters are preserved.

The ledger uses a local exclusive write lock and flushes appended rows to disk. A lock or malformed ledger stops the operation. It does not silently skip corrupt records or automatically delete another process's lock. A ledger over 50 MB requires an operator archival decision; automatic rotation is not implemented. Only one writer should operate on a given ledger. Events and source-health writes are separate durable appends, so an interrupted run may have events without a matching successful health row; consumers must not infer source health from those events.

Age, future-time, attribution and requested-symbol checks happen after a provider read, against observed completion time. Records older than the configured maximum age or more than 60 seconds in the future are rejected. Rejection counts remain visible in source health. A news story fetched today but published last month stays old.

`health.jsonl` records each completed poll's status, observed completion time, request/count metrics and coverage notes. Status can be `ok`, `partial`, `auth-required`, `rate-limited`, `unavailable`, `misconfigured` or `error`. Coverage is always `bounded-poll` and provider delivery latency remains `unknown`. `ok` means a bounded read succeeded, not that all relevant market news was collected. Health must itself pass a consumer's recency check.

## Monitor integration

```ts
import { NewsLedger } from "../research/news/ledger.js";
import { ingestOnce } from "../research/news/pipeline.js";

const ledger = new NewsLedger("data/news");
const now = Date.now();
const events = ledger.readEvents({ symbols: ["TSLA"], now, maxAgeMs: 60 * 60_000 });
const health = ledger.readHealth();
// Match a ticket's evidence IDs to current revisions, and separately check
// required source status/checkedAt. Rumor/commentary cannot satisfy a
// requirement for independently confirmed catalyst evidence.
// await ingestOnce(provider, request, ledger); // explicit read-only poll
```

`readEvents` first excludes rows received or first seen after `now`, then folds to the latest revision that was available at that time and hides canonical-URL duplicates by default. Publication after `now` is also excluded. This prevents a future correction from leaking into replay. Set `includeDuplicates: true` to inspect all source copies. Optional `since` filters visible revisions by `fetchedAt`, inclusively. `readHealth(now)` supports the same historical cutoff for poll status. Consumers should track `(id, revision)` for idempotency and use an overlapping time window rather than assuming timestamp uniqueness. No source text is an instruction to the monitor or an authorization to trade.

An embedding monitor can call `runNewsPolling(provider, input, ledger, policy, hooks)` from `src/research/news/polling.ts`; hooks provide an abort signal, optional injected clock/wait for tests, and a completed-cycle callback. `parsePollPolicy` validates CLI-style limits. The CLI starts no detached background process. Existing manual desk alerts should use this ledger through its API, not parse raw rows and accidentally accept old revisions or duplicate stories.

## Verification and remaining external work

Deterministic fixture selftests exercise relevance, source attribution, timezone handling, maximum age, future-time rejection, first-seen timestamps, revisions, historical replay, restart deduplication, canonical-URL copies, malformed ledger rejection, lock contention, missing credentials, documented X fields and credential-safe HTTP errors. Polling checks cover CLI defaults, invalid bounds, the required paid-source cap, timer-overflow rejection, monotonic request reservations, no overlap, shutdown, pre-aborted paid requests and durable sanitized failures. They do not call an LLM or a paid provider.

A bounded public Yahoo smoke read on September 17, 2026 at 17:55:51 UTC returned five headlines, four with explicit/alias relevance and attribution; one unrelated result was rejected. The source reported a 17:17 UTC publication time on the sampled article. This proves a working public read at that time, not a guaranteed low-latency news feed.

The SEC adapter has fixture coverage; its live operator-contact configuration was absent during implementation. The public Tesla submissions URL was reachable through the research browser, but that is not a live adapter acceptance test. Authenticated X and Benzinga reads, subscriptions, source licensing and sustained live polling remain unverified. Full-text claim verification, social engagement analysis, private groups and automatic alert publication are not implemented here. No signup, purchase or premium request was performed, and no collector was left running.

Official API references checked September 17, 2026:

- [SEC submissions API](https://www.sec.gov/search-filings/edgar-application-programming-interfaces)
- [SEC declared user agent and fair access](https://www.sec.gov/about/webmaster-frequently-asked-questions)
- [Tesla submissions / CIK reference](https://data.sec.gov/submissions/CIK0001318605.json)
- [X recent search](https://docs.x.com/x-api/posts/search-recent-posts) calls the field selector `post.fields`, while the [query integration guide](https://docs.x.com/x-api/posts/search/integrate/build-a-query) still shows `tweet.fields`. This is a documented discrepancy, not an authenticated acceptance result. The adapter defaults to the endpoint reference's `post.fields`; an operator can explicitly set `X_FIELDS_PARAMETER=tweet.fields` for the guide version. It never silently performs a paid retry. Queries over the guide's 512-character self-serve limit are rejected before sending.
- [Benzinga News API](https://docs.benzinga.com/api-reference/news-api/get-news-items)
