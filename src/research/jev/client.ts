export const JEV_MODEL = "jev-1.13.0";
export const MAX_REQUEST_BYTES = 12_000;
const MAX_RESPONSE_BYTES = 262_144;
const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const PROBABILITY_TOLERANCE = 0.0001;

export type ChoiceQuestion = {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
};
export type JevRequest = {
  model: string;
  state: unknown;
  questions: Record<string, ChoiceQuestion>;
};
export type ChoiceAnswer = {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
};
export type JevResponse = {
  model: string;
  answers: Record<string, ChoiceAnswer>;
  usage: { input_tokens: number; output_tokens: number };
};
export type JevErrorCode = "CONFIGURATION" | "INVALID_REQUEST" | "REQUEST_TOO_LARGE" |
  "HTTP_ERROR" | "NETWORK_ERROR" | "TIMEOUT" | "RESPONSE_TOO_LARGE" | "INVALID_RESPONSE";

const ERROR_MESSAGES: Record<JevErrorCode, string> = {
  CONFIGURATION: "Jev client configuration is invalid.",
  INVALID_REQUEST: "Jev request failed local validation.",
  REQUEST_TOO_LARGE: "Jev request exceeds the local byte limit.",
  HTTP_ERROR: "Jev service returned an unsuccessful HTTP status.",
  NETWORK_ERROR: "Jev transport failed.",
  TIMEOUT: "Jev request exceeded its total time limit.",
  RESPONSE_TOO_LARGE: "Jev response exceeds the local byte limit.",
  INVALID_RESPONSE: "Jev response failed local validation.",
};

/** Deliberately excludes provider bodies, headers and original error causes. */
export class JevError extends Error {
  readonly code: JevErrorCode;
  readonly status?: number;

  constructor(code: JevErrorCode, status?: number) {
    super(ERROR_MESSAGES[code]);
    this.name = "JevError";
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function probability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validateRequest(value: unknown): asserts value is JevRequest {
  if (!record(value) || !exactKeys(value, ["model", "state", "questions"]) ||
      value.model !== JEV_MODEL || !record(value.questions) ||
      !(typeof value.state === "string" || record(value.state) || Array.isArray(value.state))) {
    throw new JevError("INVALID_REQUEST");
  }
  const questions = Object.entries(value.questions);
  if (questions.length < 1 || questions.length > 32) throw new JevError("INVALID_REQUEST");
  for (const [id, question] of questions) {
    if (!id.trim() || !record(question) || !exactKeys(question, ["type", "instructions", "criteria"]) ||
        question.type !== "choice" || typeof question.instructions !== "string" ||
        !question.instructions.trim() || !record(question.criteria)) throw new JevError("INVALID_REQUEST");
    const criteria = Object.entries(question.criteria);
    if (criteria.length < 2 || criteria.length > 255 ||
        criteria.some(([key, description]) => !key.trim() || typeof description !== "string")) {
      throw new JevError("INVALID_REQUEST");
    }
  }
}

function serialize(request: JevRequest): { body: string; snapshot: JevRequest } {
  try {
    validateRequest(request);
    const body = JSON.stringify(request);
    if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) throw new JevError("REQUEST_TOO_LARGE");
    const snapshot: unknown = JSON.parse(body);
    validateRequest(snapshot);
    return { body, snapshot };
  } catch (error) {
    if (error instanceof JevError) throw error;
    throw new JevError("INVALID_REQUEST");
  }
}

function validateResponse(value: unknown, request: JevRequest): JevResponse {
  if (!record(value) || value.model !== JEV_MODEL || !record(value.answers) ||
      !exactKeys(value.answers, Object.keys(request.questions)) || !record(value.usage) ||
      !count(value.usage.input_tokens) || !count(value.usage.output_tokens)) {
    throw new JevError("INVALID_RESPONSE");
  }
  const answers: Record<string, ChoiceAnswer> = Object.create(null);
  for (const [id, question] of Object.entries(request.questions)) {
    const answer = value.answers[id];
    const options = Object.keys(question.criteria);
    if (!record(answer) || answer.type !== "choice" || typeof answer.choice !== "string" ||
        !options.includes(answer.choice) || !probability(answer.confidence) ||
        !record(answer.probabilities) || !exactKeys(answer.probabilities, options)) {
      throw new JevError("INVALID_RESPONSE");
    }
    const probabilities: Record<string, number> = Object.create(null);
    let sum = 0;
    let highest = 0;
    for (const option of options) {
      const value = answer.probabilities[option];
      if (!probability(value)) throw new JevError("INVALID_RESPONSE");
      probabilities[option] = value;
      sum += value;
      highest = Math.max(highest, value);
    }
    if (Math.abs(sum - 1) > PROBABILITY_TOLERANCE ||
        probabilities[answer.choice] + PROBABILITY_TOLERANCE < highest) {
      throw new JevError("INVALID_RESPONSE");
    }
    answers[id] = { type: "choice", choice: answer.choice, probabilities, confidence: answer.confidence };
  }
  return {
    model: JEV_MODEL,
    answers,
    usage: { input_tokens: value.usage.input_tokens, output_tokens: value.usage.output_tokens },
  };
}

async function readBounded(response: Response, signal: AbortSignal): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => undefined);
    throw new JevError("RESPONSE_TOO_LARGE");
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (!contentType || !(contentType === "application/json" || /^application\/[a-z0-9.+-]+\+json$/.test(contentType)) || !response.body) {
    void response.body?.cancel().catch(() => undefined);
    throw new JevError("INVALID_RESPONSE");
  }
  const reader = response.body.getReader();
  const abort = (): void => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      if (signal.aborted) throw new JevError("TIMEOUT");
      const next = await reader.read();
      if (signal.aborted) throw new JevError("TIMEOUT");
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new JevError("RESPONSE_TOO_LARGE");
      }
      chunks.push(next.value);
    }
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, length)));
    } catch {
      throw new JevError("INVALID_RESPONSE");
    }
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

/** One paid attempt at most. The caller owns quota reservation and retry policy. */
export class JevClient {
  #apiKey: string;
  #fetcher: typeof fetch;
  #timeoutMs: number;

  constructor(apiKey: string, fetcher: typeof fetch = fetch, timeoutMs = 10_000) {
    if (typeof apiKey !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(apiKey) ||
        typeof fetcher !== "function" || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) {
      throw new JevError("CONFIGURATION");
    }
    this.#apiKey = apiKey;
    this.#fetcher = fetcher;
    this.#timeoutMs = timeoutMs;
  }

  async evaluate(request: JevRequest): Promise<JevResponse> {
    const { body, snapshot } = serialize(request);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new JevError("TIMEOUT"));
      }, this.#timeoutMs);
    });
    const operation = async (): Promise<JevResponse> => {
      try {
        const response = await this.#fetcher(ENDPOINT, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.#apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
          body,
          redirect: "error",
          signal: controller.signal,
        });
        if (controller.signal.aborted) {
          void response.body?.cancel().catch(() => undefined);
          throw new JevError("TIMEOUT");
        }
        if (response.redirected || (response.url && response.url !== ENDPOINT)) {
          void response.body?.cancel().catch(() => undefined);
          throw new JevError("NETWORK_ERROR");
        }
        if (!response.ok) {
          void response.body?.cancel().catch(() => undefined);
          throw new JevError("HTTP_ERROR", response.status);
        }
        return validateResponse(await readBounded(response, controller.signal), snapshot);
      } catch (error) {
        if (controller.signal.aborted) throw new JevError("TIMEOUT");
        if (error instanceof JevError) throw error;
        throw new JevError("NETWORK_ERROR");
      }
    };
    try {
      return await Promise.race([operation(), deadline]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
