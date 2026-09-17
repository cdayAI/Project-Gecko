// Offline self-test for the Webull signer.
//
// Reference signatures were produced by the official Python SDK's
// default_signature_composer.calc_signature (webull-openapi-python-sdk 3.0.1)
// with the timestamp and nonce pinned. If this test fails, the TypeScript
// signer no longer matches the SDK and live calls will get 401/403.
//
// Run: npm run research:selftest

import { buildStringToSign, signWebullRequest } from "./signer.js";

interface Vector {
  readonly host: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly body: string | null;
  readonly expected: string;
}

const APP_KEY = "APPKEY123";
const APP_SECRET = "SECRETxyz";
const TS = "2026-09-16T23:59:59Z";
const NONCE = "0b6a1c2e-1111-4222-8333-444455556666";

const VECTORS: readonly Vector[] = [
  {
    host: "api.webull.com",
    path: "/market-data/stocks/snapshots/list",
    query: { symbols: "SPY,QQQ", category: "US_ETF", extend_hour_required: "true" },
    body: null,
    expected: "tsfNnXdDpMcP4Nfl61VZe1NaJVv9StQ0gwFuhnk6kTw=",
  },
  {
    host: "api.webull.com",
    path: "/market-data/stocks/bars/list",
    query: {},
    body: JSON.stringify({ symbols: ["SPY", "QQQ"], category: "US_ETF", timespan: "D", count: "15" }),
    expected: "VxC7+eQlAJVvJ4AXZ4XcqN/92o92QuPnghSJoyjZw8c=",
  },
  {
    host: "api.webull.com",
    path: "/openapi/account/list",
    query: {},
    body: null,
    expected: "HLbyyRT17/2o0wv2kL+zml+l05REZTWNfuw3IxkbFiI=",
  },
  {
    host: "api.webull.com",
    path: "/market-data/options/snapshots/list",
    query: { symbols: "SPY260918P00750000,SPY260918C00755000", category: "US_OPTION" },
    body: null,
    expected: "+RvEGd9I4nk91vs0qxdDOiWUemuM0lTQ54tW34Q2C0s=",
  },
];

export function runSignerSelfTest(): { passed: number; failed: number; failures: string[] } {
  let passed = 0;
  const failures: string[] = [];
  for (const v of VECTORS) {
    const input = { host: v.host, path: v.path, query: v.query, body: v.body, appKey: APP_KEY, appSecret: APP_SECRET, timestamp: TS, nonce: NONCE };
    const got = signWebullRequest(input)["x-signature"];
    if (got === v.expected) {
      passed += 1;
    } else {
      failures.push(`${v.path}: expected ${v.expected} got ${got}; stringToSign=${buildStringToSign(input, TS, NONCE)}`);
    }
  }
  return { passed, failed: failures.length, failures };
}

const isMain = process.argv[1]?.endsWith("signer-selftest.ts") || process.argv[1]?.endsWith("signer-selftest.js");
if (isMain) {
  const r = runSignerSelfTest();
  process.stdout.write(JSON.stringify({ component: "webull-signer-selftest", ...r }) + "\n");
  process.exit(r.failed === 0 ? 0 : 1);
}
