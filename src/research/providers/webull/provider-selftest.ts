// Offline mocked transport plus observed sanitized parser fixtures. No auth or network.
import assert from "node:assert/strict";
import { WebullClient } from "./client.js";
import { WebullProvider, parseWebullContractReferences, parseWebullOptionSnapshots } from "./provider.js";
import { OBSERVED_OPTION, OBSERVED_REFERENCE } from "./observed-fixture.js";
import { evaluateQuotePair } from "../../quote-quality.js";

export async function runWebullProviderSelfTest(): Promise<{ passed: number }> {
  let passed = 0;
  const now = 1789661473000;
  const refs = parseWebullContractReferences({ data: [OBSERVED_REFERENCE] }, now);
  assert.equal(refs[0].verified, true); passed++;
  const cache = new Map(refs.map((ref) => [ref.symbol, ref]));
  const option = parseWebullOptionSnapshots([OBSERVED_OPTION], now, cache)[0];
  assert.equal(option.iv, .6917); assert.equal(option.quoteTime, 1789661471189);
  assert.equal(option.bidSize, 12); assert.equal(option.provenance?.delayMinutes, 0); passed++;
  assert.equal(parseWebullOptionSnapshots([OBSERVED_OPTION], now)[0].contractVerified, false); passed++;
  assert.equal(parseWebullOptionSnapshots([OBSERVED_OPTION], now + 86_400_001, cache)[0].contractVerified, false); passed++;
  assert.equal(parseWebullOptionSnapshots([{ ...OBSERVED_OPTION, delay_minutes: undefined }], now)[0].provenance?.delayStatus, "unknown"); passed++;
  assert.equal(parseWebullContractReferences({ data: [{ ...OBSERVED_REFERENCE, multiplier: "10" }] }, now)[0].verified, false); passed++;
  assert.equal(parseWebullContractReferences({ data: [{ ...OBSERVED_REFERENCE, underlying_symbol: "HOOD" }] }, now)[0].verified, false); passed++;
  assert.throws(() => parseWebullContractReferences([OBSERVED_REFERENCE], now)); passed++;
  assert.throws(() => parseWebullContractReferences({ data: [OBSERVED_REFERENCE, OBSERVED_REFERENCE] }, now)); passed++;
  assert.throws(() => parseWebullOptionSnapshots({ result: [OBSERVED_OPTION] }, now)); passed++;

  const calls: { url: URL; options: RequestInit | undefined }[] = [];
  let fakeNow = now;
  const waits: number[] = [];
  let omitOption = false;
  // The stock row is synthetic; contract and option rows above are observed.
  const mockFetch: typeof fetch = async (input, options) => {
    const url = new URL(String(input)); calls.push({ url, options });
    assert.equal(url.host, "api.sandbox.webull.com"); assert.equal(options?.redirect, "error");
    let body: unknown;
    if (url.pathname === "/trading/instruments/options/contracts/list") {
      assert.equal(url.searchParams.get("option_symbols"), OBSERVED_OPTION.symbol);
      body = { data: [OBSERVED_REFERENCE] };
    } else if (url.pathname === "/market-data/options/snapshots/list") {
      body = omitOption ? [] : [{ ...OBSERVED_OPTION, quote_time: Date.now() - 10 }];
    } else if (url.pathname === "/market-data/stocks/snapshots/list") {
      body = [{ symbol: "SMCI", price: "40", bid: "39.99", ask: "40.01", bid_size: "100", ask_size: "100",
        quote_time: Date.now() - 10, last_trade_time: Date.now() - 10 }];
    } else throw new Error("Unexpected path");
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const config = { appKey: "OFFLINE_KEY", appSecret: "OFFLINE_SECRET", env: "sandbox" as const };
  const runtime = { fetch: mockFetch, now: (): number => fakeNow,
    sleep: async (ms: number): Promise<void> => { waits.push(ms); fakeNow += ms; } };
  const client = new WebullClient(config, runtime);
  await assert.rejects(client.get("/trading/accounts/list", {}));
  await assert.rejects(client.post("/trading/orders/place", {}));
  await assert.rejects(client.post("/auth/tokens/create", {}));
  assert.equal(calls.length, 0); passed++;
  assert.throws(() => new WebullClient({ ...config, host: "example.com" }, runtime)); passed++;
  await assert.rejects(client.get("/market-data/options/snapshots/list", { symbols: Array(21).fill(OBSERVED_OPTION.symbol).join(",") })); passed++;
  const provider = new WebullProvider(client);
  assert.deepEqual(await provider.getContractReferences([OBSERVED_OPTION.symbol]), [OBSERVED_OPTION.symbol]); passed++;
  const [stocks, options] = await Promise.all([provider.getSnapshots(["SMCI"]), provider.getOptionQuotes([OBSERVED_OPTION.symbol])]);
  assert.equal(evaluateQuotePair(stocks[0], options[0], Date.now()).status, "DATA_PASS");
  assert.equal(calls.length, 3); assert.ok(calls.every((call) => call.options?.method === "GET")); passed++;
  assert.equal(evaluateQuotePair(stocks[0], { ...options[0], quoteTime: Date.now() - 6000 }, Date.now()).status, "DATA_BLOCK"); passed++;
  omitOption = true;
  assert.equal((await provider.getOptionQuotes([OBSERVED_OPTION.symbol])).length, 0); passed++;
  assert.ok(waits.some((ms) => ms >= 800)); passed++;
  assert.throws(() => new WebullClient({ ...config, accessToken: "OFFLINE_TOKEN", accessTokenExpiresAt: now - 1 }, runtime)); passed++;
  const expiring = new WebullClient({ ...config, accessToken: "OFFLINE_TOKEN", accessTokenExpiresAt: fakeNow + 1 }, runtime);
  fakeNow += 2;
  await assert.rejects(expiring.get("/market-data/stocks/snapshots/list", { symbols: "SMCI" }), /expired/); passed++;

  let retryCalls = 0;
  const retryClient = new WebullClient(config, { ...runtime, fetch: async () => {
    retryCalls++;
    return new Response(retryCalls < 3 ? "upstream-private-body" : "[]", { status: retryCalls < 3 ? 429 : 200, headers: { "retry-after": "0" } });
  } });
  assert.deepEqual(await retryClient.get("/market-data/stocks/snapshots/list", { symbols: "SMCI" }), []);
  assert.equal(retryCalls, 3); passed++;
  let failingCalls = 0;
  const failure = new WebullClient(config, { ...runtime, fetch: async () => {
    failingCalls++; return new Response("upstream-private-body", { status: 429, headers: { "retry-after": "3600" } });
  } });
  await assert.rejects(failure.get("/market-data/stocks/snapshots/list", { symbols: "SMCI" }), (error: unknown) =>
    error instanceof Error && error.message.includes("HTTP 429") && !error.message.includes("private"));
  assert.equal(failingCalls, 1); passed++;
  for (const [env, minimumSpacing] of [["sandbox", 2010], ["prod", 1010]] as const) {
    let clock = now;
    const times: number[] = [];
    const paced = new WebullClient({ ...config, env }, { now: () => clock, sleep: async ms => { clock += ms; },
      fetch: async () => { times.push(clock); return new Response("[]"); } });
    await paced.get("/market-data/stocks/snapshots/list", { symbols: "SPY" });
    await paced.get("/market-data/stocks/snapshots/list", { symbols: "SPY" });
    assert.ok(times[1] - times[0] >= minimumSpacing); passed++;
  }
  return { passed };
}
if (process.argv[1]?.endsWith("provider-selftest.ts") || process.argv[1]?.endsWith("provider-selftest.js")) {
  runWebullProviderSelfTest().then((result) => process.stdout.write(JSON.stringify({ component: "webull-provider-selftest", ...result }) + "\n"))
    .catch((error: unknown) => { process.stderr.write(String(error) + "\n"); process.exitCode = 1; });
}
