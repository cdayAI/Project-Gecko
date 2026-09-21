// Offline authorization-boundary regression. Uses only fake auth and mocked fetch.
// Run: node --import tsx src/brokers/schwab/rest-readonly-selftest.ts

import assert from "node:assert/strict";
import { createLogger, Logger } from "../../core/logger.js";
import type { SchwabAuth } from "./auth.js";
import { SchwabRest } from "./rest.js";
import type { SchwabOrderRequest } from "./types.js";

export async function runReadonlyRestSelfTest(): Promise<{ passed: number }> {
  const originalFetch = globalThis.fetch;
  const originalWarn = Logger.prototype.warn;
  const originalError = Logger.prototype.error;
  const capturedLogs: string[] = [];
  let authCalls = 0;
  let fetchCalls = 0;
  let passed = 0;
  const fakeToken = "OFFLINE_TEST_TOKEN_NOT_A_CREDENTIAL";
  const privateMarker = "OFFLINE_PRIVATE_RESPONSE_MARKER";
  const auth = {
    async getAccessToken(): Promise<string> {
      authCalls += 1;
      return fakeToken;
    },
  } as unknown as SchwabAuth;
  const client = new SchwabRest(auth, { marketDataOnly: true });
  const fakeOrder: SchwabOrderRequest = {
    session: "NORMAL", duration: "DAY", orderType: "LIMIT",
    orderStrategyType: "SINGLE", price: 1,
    orderLegCollection: [],
  };
  const blockedCalls: readonly [string, () => Promise<unknown>][] = [
    ["account numbers", () => client.getAccountNumbers()],
    ["account with positions", () => client.getAccount("OFFLINE_ACCOUNT")],
    ["account without positions", () => client.getAccount("OFFLINE_ACCOUNT", false)],
    ["user preferences", () => client.getUserPreference()],
    ["place order", () => client.placeOrder("OFFLINE_ACCOUNT", fakeOrder)],
    ["preview order", () => client.previewOrder("OFFLINE_ACCOUNT", fakeOrder)],
    ["get order", () => client.getOrder("OFFLINE_ACCOUNT", "OFFLINE_ORDER")],
    ["cancel order", () => client.cancelOrder("OFFLINE_ACCOUNT", "OFFLINE_ORDER")],
    ["list orders", () => client.listOrders("OFFLINE_ACCOUNT")],
    ["filtered orders", () => client.listOrders("OFFLINE_ACCOUNT", { status: "WORKING", maxResults: 1 })],
    ["movers", () => client.getMovers("EQUITY_ALL", "VOLUME")],
  ];

  function checkMarketRequest(input: Parameters<typeof fetch>[0], init?: RequestInit): URL {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.origin, "https://api.schwabapi.com");
    assert.ok(["/marketdata/v1/quotes", "/marketdata/v1/pricehistory", "/marketdata/v1/chains"].includes(url.pathname));
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error", "authenticated requests must reject redirects");
    assert.equal(init?.body, undefined);
    assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${fakeToken}`);
    assert.ok(init?.signal instanceof AbortSignal);
    return url;
  }

  try {
    // Intercept every fetch before invoking any client method. The original
    // transport is never called, including on an unexpected route or failure.
    globalThis.fetch = async (): Promise<Response> => {
      fetchCalls += 1;
      throw new Error("Forbidden call reached the offline transport stub");
    };
    for (const [name, call] of blockedCalls) {
      await assert.rejects(call, /market-data-only client blocked/, name);
      assert.equal(authCalls, 0, `${name}: blocked before authentication`);
      assert.equal(fetchCalls, 0, `${name}: blocked before transport`);
      passed += 1;
    }

    assert.deepEqual(await client.getQuotes([]), {});
    assert.equal(authCalls, 0);
    assert.equal(fetchCalls, 0);
    passed += 1;

    const optionSymbol = "SPY   260925C00600000";
    const quotes = { TEST: { symbol: "TEST", quote: { bidPrice: 1, askPrice: 1.01 } } };
    const history = { symbol: "TEST", candles: [], empty: true };
    const chain = { symbol: "TEST", status: "SUCCESS", callExpDateMap: {}, putExpDateMap: {} };
    const expectedRequests = [
      { path: "/marketdata/v1/quotes", query: { symbols: `TEST,${optionSymbol}` }, body: quotes },
      { path: "/marketdata/v1/pricehistory", query: {
        symbol: "TEST", periodType: "day", period: "1", frequencyType: "minute",
        frequency: "5", needExtendedHoursData: "false", needPreviousClose: "true",
      }, body: history },
      { path: "/marketdata/v1/chains", query: {
        symbol: "TEST", contractType: "ALL", strikeCount: "2", includeUnderlyingQuote: "true",
      }, body: chain },
    ];
    globalThis.fetch = async (input, init): Promise<Response> => {
      fetchCalls += 1;
      const url = checkMarketRequest(input, init);
      const expected = expectedRequests.shift();
      assert.ok(expected, "unexpected market-data request");
      assert.equal(url.pathname, expected.path);
      assert.deepEqual(Object.fromEntries(url.searchParams), expected.query);
      return new Response(JSON.stringify(expected.body), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    };
    assert.deepEqual(await client.getQuotes(["TEST", optionSymbol]), quotes);
    passed += 1;
    assert.deepEqual(await client.getPriceHistory({
      symbol: "TEST", periodType: "day", period: 1, frequencyType: "minute",
      frequency: 5, needExtendedHoursData: false, needPreviousClose: true,
    }), history);
    passed += 1;
    assert.deepEqual(await client.getOptionChain({
      symbol: "TEST", contractType: "ALL", strikeCount: 2, includeUnderlyingQuote: true,
    }), chain);
    passed += 1;
    assert.equal(expectedRequests.length, 0);
    assert.equal(authCalls, 3);
    assert.equal(fetchCalls, 3);

    // Capture retry logs as well as thrown errors: neither may expose response
    // bodies, status text, credentials, request URLs or raw transport errors.
    const captureLog = (message: string, data?: Record<string, unknown>): void => {
      capturedLogs.push(JSON.stringify({ message, data }));
    };
    Logger.prototype.warn = captureLog;
    Logger.prototype.error = captureLog;
    const failures: Response[] = [];
    globalThis.fetch = async (input, init): Promise<Response> => {
      fetchCalls += 1;
      checkMarketRequest(input, init);
      const response = new Response(`${privateMarker}: ${fakeToken}`, {
        status: 403, statusText: privateMarker,
      });
      failures.push(response);
      return response;
    };
    await assert.rejects(() => client.getQuotes(["TEST"]), {
      message: "Schwab market data HTTP 403",
    });
    assert.equal(failures.length, 3, "HTTP failure exhausts the bounded retry count");
    assert.ok(failures.every((response) => !response.bodyUsed), "HTTP failure bodies stay unread");
    assert.equal(authCalls, 4);
    passed += 1;

    const beforeNetworkFailure = fetchCalls;
    globalThis.fetch = async (input, init): Promise<Response> => {
      fetchCalls += 1;
      checkMarketRequest(input, init);
      throw new TypeError(`${privateMarker}: redirect to https://example.invalid/?token=${fakeToken}`);
    };
    await assert.rejects(() => client.getQuotes(["TEST"]), {
      message: "Schwab market data request failed (network, timeout or redirect)",
    });
    assert.equal(fetchCalls - beforeNetworkFailure, 3);
    assert.equal(authCalls, 5);
    assert.equal(capturedLogs.length, 6, "each failed attempt is captured for the log privacy check");
    for (const line of capturedLogs) {
      assert.ok(!line.includes(privateMarker));
      assert.ok(!line.includes(fakeToken));
      assert.ok(!line.includes("https://"));
    }
    passed += 1;
    return { passed };
  } finally {
    globalThis.fetch = originalFetch;
    Logger.prototype.warn = originalWarn;
    Logger.prototype.error = originalError;
  }
}

const isMain = process.argv[1]?.endsWith("rest-readonly-selftest.ts") ||
  process.argv[1]?.endsWith("rest-readonly-selftest.js");
if (isMain) {
  const log = createLogger("schwab-rest-readonly-selftest");
  runReadonlyRestSelfTest().then((result) => {
    log.info("Offline Schwab market-data-only checks passed", result);
  }).catch((error: unknown) => {
    log.error("Offline Schwab market-data-only self-test failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  });
}
