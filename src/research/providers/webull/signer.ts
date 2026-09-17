// Webull OpenAPI request signing.
//
// Verified against the official Python SDK, webull-openapi-python-sdk 3.0.1:
//   webull/core/auth/composer/default_signature_composer.py
//   webull/core/auth/algorithm/sha_hmac256_new.py
//   webull/core/utils/common.py
//   webull/core/headers.py
//
// Algorithm (SDK "sha_hmac256_new", header x-signature-version 1.0):
//   1. sign headers: x-app-key, x-timestamp (YYYY-MM-DDTHH:MM:SSZ, UTC),
//      x-signature-version "1.0", x-signature-algorithm "HMAC-SHA256",
//      x-signature-nonce (uuid), plus "host" (endpoint host, signed only,
//      not sent as a custom header).
//   2. merge query params into that map (keys lowercased for headers;
//      a colliding key joins values with "&"), stringify values.
//   3. string = path + "&" + join(sorted "k=v", "&") [+ "&" + SHA256HEX_UPPER(body)]
//   4. percent-encode string with Python quote(safe='') semantics: only
//      A-Z a-z 0-9 - _ . ~ stay literal.
//   5. signature = base64(HMAC-SHA256(key = appSecret + "&", msg = encoded))
//
// The public docs page describes an older HMAC-SHA1/MD5 variant. The SDK
// forces the SHA-256 variant regardless of the request's declared signer,
// so that is what we implement. Confirm with one live read-only call
// (see docs/research-engine.md) before relying on it.

import { createHash, createHmac, randomUUID } from "node:crypto";

export const WEBULL_SIGN_VERSION = "1.0";
export const WEBULL_SIGN_ALGORITHM = "HMAC-SHA256";

export interface WebullSignInput {
  readonly host: string;               // e.g. api.webull.com
  readonly path: string;               // e.g. /market-data/stocks/snapshots/list
  readonly query: Readonly<Record<string, string>>;
  readonly body: string | null;        // exact JSON string that will be sent, or null
  readonly appKey: string;
  readonly appSecret: string;
  readonly timestamp?: string;         // override for tests
  readonly nonce?: string;             // override for tests
}

export interface WebullSignedHeaders {
  readonly "x-app-key": string;
  readonly "x-timestamp": string;
  readonly "x-signature-version": string;
  readonly "x-signature-algorithm": string;
  readonly "x-signature-nonce": string;
  readonly "x-signature": string;
}

// Python urllib.parse.quote(s, safe='') equivalent: UTF-8 percent-encode
// everything except unreserved characters, uppercase hex.
export function pythonQuoteAll(s: string): string {
  const bytes = Buffer.from(s, "utf8");
  let out = "";
  for (const b of bytes) {
    const c = String.fromCharCode(b);
    if (
      (b >= 0x30 && b <= 0x39) || // 0-9
      (b >= 0x41 && b <= 0x5a) || // A-Z
      (b >= 0x61 && b <= 0x7a) || // a-z
      c === "-" || c === "_" || c === "." || c === "~"
    ) {
      out += c;
    } else {
      out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
    }
  }
  return out;
}

export function isoTimestampNoMillis(d: Date = new Date()): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function buildStringToSign(input: WebullSignInput, timestamp: string, nonce: string): string {
  const params: Record<string, string> = {
    "x-app-key": input.appKey,
    "x-timestamp": timestamp,
    "x-signature-version": WEBULL_SIGN_VERSION,
    "x-signature-algorithm": WEBULL_SIGN_ALGORITHM,
    "x-signature-nonce": nonce,
    host: input.host,
  };
  for (const [k, v] of Object.entries(input.query)) {
    const existing = params[k];
    params[k] = existing !== undefined ? `${existing}&${v}` : v;
  }
  const sortedPairs = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`);
  let s = input.path ? `${input.path}&${sortedPairs.join("&")}` : sortedPairs.join("=");
  if (input.body !== null && input.body.length > 0) {
    const bodyHash = createHash("sha256").update(input.body, "utf8").digest("hex").toUpperCase();
    s = `${s}&${bodyHash}`;
  }
  return pythonQuoteAll(s);
}

export function signWebullRequest(input: WebullSignInput): WebullSignedHeaders {
  const timestamp = input.timestamp ?? isoTimestampNoMillis();
  const nonce = input.nonce ?? randomUUID();
  const stringToSign = buildStringToSign(input, timestamp, nonce);
  const signature = createHmac("sha256", `${input.appSecret}&`).update(stringToSign, "utf8").digest("base64");
  return {
    "x-app-key": input.appKey,
    "x-timestamp": timestamp,
    "x-signature-version": WEBULL_SIGN_VERSION,
    "x-signature-algorithm": WEBULL_SIGN_ALGORITHM,
    "x-signature-nonce": nonce,
    "x-signature": signature,
  };
}
