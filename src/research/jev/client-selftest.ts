import * as assert from "node:assert/strict";
import { inspect } from "node:util";
import { JevClient, JevError, JEV_MODEL, MAX_REQUEST_BYTES, type JevRequest } from "./client.js";

const SECRET = "fixture-only-secret-must-never-be-rendered";
const request = (): JevRequest => ({
  model: JEV_MODEL,
  state: { text: "Synthetic conditional agreement." },
  questions: { commitment: { type: "choice", instructions: "Classify the agreement.", criteria: { firm: "Firm", conditional: "Conditional" } } },
});
const valid = (): Record<string, any> => ({
  model: JEV_MODEL,
  answers: { commitment: { type: "choice", choice: "conditional", probabilities: { firm: 0.1, conditional: 0.9 }, confidence: 0.7 } },
  usage: { input_tokens: 72, output_tokens: 30 },
});
const json = (value: unknown): Response => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const mock = (operation: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>): typeof fetch => operation as typeof fetch;
let checks = 0;

async function rejects(run: () => Promise<unknown>, code: string, status?: number): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof JevError);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    assert.ok(!`${inspect(error)} ${JSON.stringify(error)}`.includes(SECRET));
    assert.equal(error.cause, undefined);
    return true;
  });
  checks++;
}

let calls = 0;
const client = new JevClient(SECRET, mock(async (input, init) => {
  calls++;
  assert.equal(input, "https://api.typesafe.ai/v1/systemone");
  assert.equal(init?.method, "POST");
  assert.equal(init?.redirect, "error");
  assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${SECRET}`);
  assert.deepEqual(JSON.parse(init?.body as string), request());
  assert.ok(init?.signal);
  return json(valid());
}));
assert.equal(JSON.stringify(client), "{}");
assert.ok(!inspect(client, { showHidden: true }).includes(SECRET));
const answer = await client.evaluate(request());
assert.equal(answer.answers.commitment.choice, "conditional");
assert.equal(answer.usage.input_tokens, 72);
assert.equal(calls, 1);
checks++;

await rejects(() => client.evaluate({ ...request(), model: "jev-latest" }), "INVALID_REQUEST");
await rejects(() => client.evaluate({ ...request(), state: "😀".repeat(MAX_REQUEST_BYTES / 4) }), "REQUEST_TOO_LARGE");
await rejects(() => client.evaluate({ ...request(), questions: {} }), "INVALID_REQUEST");
const cyclic = request(); (cyclic.state as Record<string, unknown>).self = cyclic;
await rejects(() => client.evaluate(cyclic), "INVALID_REQUEST");
assert.equal(calls, 1);

for (const status of [301, 401, 403, 422, 429, 500, 529]) {
  let attempts = 0;
  const failing = new JevClient(SECRET, mock(async () => {
    attempts++;
    return new Response(`${SECRET}: provider error`, { status, headers: { location: "https://example.invalid/", "retry-after": "10" } });
  }));
  await rejects(() => failing.evaluate(request()), "HTTP_ERROR", status);
  assert.equal(attempts, 1);
}
await rejects(() => new JevClient(SECRET, mock(async () => { throw new Error(SECRET); })).evaluate(request()), "NETWORK_ERROR");
const redirected = json(valid()); Object.defineProperty(redirected, "redirected", { value: true });
await rejects(() => new JevClient(SECRET, mock(async () => redirected)).evaluate(request()), "NETWORK_ERROR");
const wrongOrigin = json(valid()); Object.defineProperty(wrongOrigin, "url", { value: "https://example.invalid/" });
await rejects(() => new JevClient(SECRET, mock(async () => wrongOrigin)).evaluate(request()), "NETWORK_ERROR");

const malformed: ((value: Record<string, any>) => void)[] = [
  (value) => { value.model = "jev-preview"; },
  (value) => { delete value.answers.commitment; },
  (value) => { value.answers.extra = value.answers.commitment; },
  (value) => { value.answers.commitment.type = "noul"; },
  (value) => { value.answers.commitment.choice = "invented"; },
  (value) => { value.answers.commitment.choice = "firm"; },
  (value) => { value.answers.commitment.probabilities = { firm: 0.1, conditional: 0.1 }; },
  (value) => { value.answers.commitment.probabilities = { firm: -0.1, conditional: 1.1 }; },
  (value) => { value.answers.commitment.probabilities.conditional = null; },
  (value) => { value.answers.commitment.probabilities.extra = 0; },
  (value) => { value.answers.commitment.confidence = 1.1; },
  (value) => { value.answers.commitment.confidence = "0.8"; },
  (value) => { value.usage.input_tokens = -1; },
  (value) => { value.usage.input_tokens = 1.5; },
  (value) => { value.usage.input_tokens = true; },
  (value) => { value.usage.output_tokens = Number.MAX_SAFE_INTEGER + 1; },
];
for (const mutate of malformed) {
  const response = valid(); mutate(response);
  await rejects(() => new JevClient(SECRET, mock(async () => json(response))).evaluate(request()), "INVALID_RESPONSE");
}
await rejects(() => new JevClient(SECRET, mock(async () => new Response(`{"secret":"${SECRET}"`, { headers: { "content-type": "application/json" } }))).evaluate(request()), "INVALID_RESPONSE");
await rejects(() => new JevClient(SECRET, mock(async () => new Response(SECRET))).evaluate(request()), "INVALID_RESPONSE");
await rejects(() => new JevClient(SECRET, mock(async () => new Response("{}", { headers: { "content-type": "application/json", "content-length": "999999" } }))).evaluate(request()), "RESPONSE_TOO_LARGE");
await rejects(() => new JevClient(SECRET, mock(async () => new Response(" ".repeat(262_145), { headers: { "content-type": "application/json" } }))).evaluate(request()), "RESPONSE_TOO_LARGE");
await rejects(() => new JevClient(SECRET, mock(async () => new Response(new Uint8Array([0xff]), { headers: { "content-type": "application/json" } }))).evaluate(request()), "INVALID_RESPONSE");

let aborted = false;
await rejects(() => new JevClient(SECRET, mock(async (_input, init) => {
  init?.signal?.addEventListener("abort", () => { aborted = true; });
  return new Promise<Response>(() => undefined);
}), 10).evaluate(request()), "TIMEOUT");
assert.equal(aborted, true);
let bodyCancelled = false;
await rejects(() => new JevClient(SECRET, mock(async () => new Response(new ReadableStream<Uint8Array>({
  start(controller) { controller.enqueue(new TextEncoder().encode("{")); },
  cancel() { bodyCancelled = true; },
}), { headers: { "content-type": "application/json" } })), 10).evaluate(request()), "TIMEOUT");
assert.equal(bodyCancelled, true);

assert.throws(() => new JevClient(""), JevError);
assert.throws(() => new JevClient("key\r\nInjected: header"), JevError);
assert.throws(() => new JevClient(SECRET, fetch, Number.POSITIVE_INFINITY), JevError);
assert.throws(() => new JevClient(SECRET, fetch, 30_001), JevError);
checks++;
console.log(`Jev client selftest passed (${checks} checks; mocked transport only, no live API requests).`);
