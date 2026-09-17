import type { HealthStatus, NewsFetch } from "./types.js";

export class NewsHttpError extends Error {
  constructor(readonly status: HealthStatus, readonly code?: number) {
    super(code ? `News provider HTTP ${code}` : "News provider request failed");
  }
}

export async function getJson(url: string, headers: Readonly<Record<string, string>>, fetcher: NewsFetch = fetch, timeoutMs = 10_000, externalSignal?: AbortSignal): Promise<unknown> {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (externalSignal?.aborted) controller.abort();
  externalSignal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (controller.signal.aborted) throw new NewsHttpError("unavailable");
    const response = await fetcher(url, { method: "GET", headers, signal: controller.signal, redirect: "error" });
    if (!response.ok) {
      throw new NewsHttpError(response.status === 401 || response.status === 403 ? "auth-required" : response.status === 429 ? "rate-limited" : "unavailable", response.status);
    }
    const text = await response.text();
    if (text.length > 10_000_000) throw new NewsHttpError("error");
    try { return JSON.parse(text) as unknown; } catch { throw new NewsHttpError("error"); }
  } catch (error) {
    if (error instanceof NewsHttpError) throw error;
    // Never include request URLs, provider bodies, headers or nested errors in logs.
    throw new NewsHttpError("unavailable");
  } finally { clearTimeout(timer); externalSignal?.removeEventListener("abort", abort); }
}

export function failure(error: unknown): { status: HealthStatus; note: string } {
  return error instanceof NewsHttpError ? { status: error.status, note: error.message } : { status: "error", note: "Provider read or response validation failed" };
}
