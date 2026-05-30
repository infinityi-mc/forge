/**
 * `forge/http/client` — a resilient, traced `fetch` wrapper for calling
 * other services.
 *
 * Resilience and tracing are **first-class by composition**: pass a
 * `forge/resilience` pipeline and/or a `forge/telemetry` tracer and the
 * client makes them the default, with timeouts that actually cancel the
 * socket and RFC 7807 error bodies parsed into typed {@link ProblemError}s.
 *
 * @example
 * ```ts
 * import { createHttpClient } from "forge/http/client";
 * import { combine, retry, timeout, exponentialBackoff } from "forge/resilience";
 *
 * const api = createHttpClient({
 *   baseUrl: "https://payments.internal",
 *   timeoutMs: 2_000,
 *   resilience: combine(
 *     retry({ maxAttempts: 3, backoff: exponentialBackoff() }),
 *     timeout({ ms: 2_000 }),
 *   ),
 *   telemetry, // composes tracedFetch
 * });
 *
 * const res = await api.post<{ id: string }>("/charges", { amount: 999 });
 * ```
 *
 * @module
 */

export { createHttpClient } from "./client";
export type {
  HttpClient,
  HttpClientOptions,
  PipelineLike,
  PipelineContextLike,
} from "./types";
export type {
  ClientInit,
  ClientRequest,
  HttpResponse,
  FetchLike,
} from "../types";
export type { Codec } from "../codec";
export { jsonCodec } from "../codec";
export { ProblemError } from "../problem";
