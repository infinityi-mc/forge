/**
 * Shared HTTP transport for OTLP/HTTP exporters.
 *
 * Single responsibility: POST a serialized JSON body to a configured
 * endpoint with optional retry-on-5xx and timeout. Used by the log,
 * metric, and trace OTLP exporters.
 *
 * @module
 */

import { TelemetryError } from "../../errors";

export interface OtlpHttpClientOptions {
  /** Full URL including signal path (e.g. `http://otel:4318/v1/logs`). */
  url: string;
  /** Extra headers (Authorization, x-org-id, …). */
  headers?: Readonly<Record<string, string>>;
  /** Request timeout (ms). Defaults to `10_000`. */
  timeoutMs?: number;
  /** Max retry attempts on retriable failures. Defaults to `3`. */
  maxRetries?: number;
  /** Base delay (ms) for exponential backoff. Defaults to `200`. */
  retryBaseDelayMs?: number;
  /** Override `fetch` (for tests). */
  fetch?: typeof fetch;
}

export class OtlpHttpError extends TelemetryError {
  readonly status?: number;
  readonly attempts: number;
  readonly retriable: boolean;
  constructor(
    message: string,
    options: ErrorOptions & {
      status?: number;
      attempts: number;
      retriable?: boolean;
    },
  ) {
    super(message, options);
    this.name = "OtlpHttpError";
    if (options.status !== undefined) this.status = options.status;
    this.attempts = options.attempts;
    this.retriable = options.retriable ?? false;
  }
}

/**
 * Functional client: returns a `send(body)` function that handles
 * retries + timeout. Each exporter owns one client.
 */
export function createOtlpHttpClient(options: OtlpHttpClientOptions) {
  const {
    url,
    headers,
    timeoutMs = 10_000,
    maxRetries = 3,
    retryBaseDelayMs = 200,
    fetch: fetchImpl = fetch,
  } = options;

  return async function send(
    body: string,
    signal?: AbortSignal,
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const ac = new AbortController();
      const onAbort = () => ac.abort();
      if (signal) {
        if (signal.aborted) ac.abort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
      const timeout = setTimeout(() => ac.abort(), timeoutMs);
      if (typeof timeout === "object" && "unref" in timeout) timeout.unref();

      try {
        const response = await fetchImpl(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...headers,
          },
          body,
          signal: ac.signal,
        });
        clearTimeout(timeout);
        if (signal) signal.removeEventListener("abort", onAbort);

        if (response.ok) return;

        // Retry on 408/429/5xx; bail on other 4xx.
        const retriable =
          response.status === 408 ||
          response.status === 429 ||
          response.status >= 500;
        const err = new OtlpHttpError(
          `OTLP/HTTP request failed with status ${response.status}`,
          { status: response.status, attempts: attempt + 1, retriable },
        );
        if (retriable && attempt < maxRetries) {
          lastError = err;
          await sleep(backoffMs(retryBaseDelayMs, attempt));
          continue;
        }
        throw err;
      } catch (err) {
        clearTimeout(timeout);
        if (signal) signal.removeEventListener("abort", onAbort);
        if (err instanceof OtlpHttpError) {
          if (!err.retriable || attempt >= maxRetries) throw err;
          lastError = err;
          await sleep(backoffMs(retryBaseDelayMs, attempt));
          continue;
        }
        if (attempt < maxRetries) {
          lastError = err;
          await sleep(backoffMs(retryBaseDelayMs, attempt));
          continue;
        }
        throw new OtlpHttpError("OTLP/HTTP request failed", {
          cause: err,
          attempts: attempt + 1,
          retriable: true,
        });
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new OtlpHttpError("OTLP/HTTP request failed", {
          attempts: maxRetries + 1,
        });
  };
}

function backoffMs(base: number, attempt: number): number {
  const jitter = Math.random() * base;
  return base * 2 ** attempt + jitter;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t === "object" && "unref" in t) t.unref();
  });
}
