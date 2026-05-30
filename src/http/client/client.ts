/**
 * The `forge/http` client request pipeline.
 *
 * One `request()` path drives every verb. In order, a request:
 *
 * 1. resolves its URL against `baseUrl` and applies `query`;
 * 2. merges `defaultHeaders` with per-call headers and encodes the body
 *    via the {@link Codec} (default JSON);
 * 3. arms a per-request `AbortSignal` from `timeoutMs`, combined with the
 *    caller's signal and the resilience pipeline's signal, so a timeout
 *    **cancels the socket** (never leaks a pending promise);
 * 4. runs the fetch inside the optional `resilience` pipeline; when a
 *    `telemetry.tracer` is present the fetch is the existing `tracedFetch`
 *    (client span + W3C `traceparent` injection) — not a reimplementation;
 * 5. on `!res.ok`, parses an `application/problem+json` body into a typed
 *    {@link ProblemError}, or throws {@link ResponseError} when
 *    `throwOnError` is set; otherwise decodes the body via the codec;
 * 6. records `http.client.request.duration` when a meter is present.
 *
 * @module
 */

import { tracedFetch } from "../../telemetry/instrumentation/fetch";
import type { Tracer } from "../../telemetry/trace/types";
import { jsonCodec } from "../codec";
import {
  HttpError,
  ProblemError,
  RequestError,
  ResponseError,
  TimeoutError,
} from "../errors";
import { PROBLEM_CONTENT_TYPE } from "../problem/render";
import type { Codec } from "../codec";
import type { HttpTelemetry } from "../observability";
import type {
  BodyInit,
  ClientInit,
  ClientRequest,
  FetchLike,
  HeadersInit,
  HttpResponse,
  ProblemDetails,
} from "../types";
import type {
  HttpClient,
  HttpClientOptions,
  PipelineLike,
} from "./types";

/** Resolved, defaulted view of {@link HttpClientOptions}. */
interface ResolvedOptions {
  readonly baseUrl?: string;
  readonly defaultHeaders: Record<string, string>;
  readonly timeoutMs?: number;
  readonly resilience?: PipelineLike;
  readonly parseProblem: boolean;
  readonly throwOnError: boolean;
  readonly codec: Codec;
  readonly fetch: FetchLike;
  readonly telemetry?: HttpTelemetry;
}

const passthroughFetch: FetchLike = (input, init) => fetch(input, init);

/**
 * Create a resilient, traced HTTP client. Throws synchronously (fail-fast)
 * when `baseUrl` is malformed.
 */
export function createHttpClient(options: HttpClientOptions = {}): HttpClient {
  const resolved = resolveOptions(options);
  const durationHistogram = resolved.telemetry?.meter?.createHistogram(
    "http.client.request.duration",
    { description: "Duration of outbound HTTP client requests.", unit: "s" },
  );

  // Compose tracedFetch once when a tracer is injected — the client reuses
  // the telemetry instrumentation rather than reimplementing propagation.
  // `tracedFetch` only calls `tracer.withSpan`, but its parameter is typed
  // as the full `Tracer`. Our structural `TracerLike` is a deliberate
  // subset (the real telemetry `Tracer` satisfies both), so we widen here.
  const wrappedFetch: FetchLike = resolved.telemetry?.tracer
    ? tracedFetch({
        tracer: resolved.telemetry.tracer as unknown as Tracer,
        fetch: resolved.fetch,
      })
    : resolved.fetch;

  async function request<T>(req: ClientRequest): Promise<HttpResponse<T>> {
    const method = (req.method ?? "GET").toUpperCase();
    const url = buildUrl(resolved.baseUrl, req.url, req.query);
    const { headers, body } = buildBody(resolved, req, method);
    const serverAddress = hostOf(url);

    const timeoutMs = req.timeoutMs ?? resolved.timeoutMs;
    const deadline = armTimeout(timeoutMs);
    const startedAt = performance.now();
    let statusLabel: string | undefined;

    try {
      const response = await runFetch(resolved, wrappedFetch, {
        url,
        method,
        headers,
        body,
        callerSignal: req.signal,
        deadline,
      });
      statusLabel = String(response.status);
      return await finalize<T>(resolved, response);
    } catch (error) {
      statusLabel = errorLabel(error);
      throw error;
    } finally {
      deadline?.clear();
      durationHistogram?.record((performance.now() - startedAt) / 1000, {
        "http.request.method": method,
        "http.response.status_code": statusLabel,
        "server.address": serverAddress,
      });
    }
  }

  const client: HttpClient = {
    request,
    get: (url, init) => request({ method: "GET", url, ...init }),
    post: (url, body, init) => request({ method: "POST", url, body, ...init }),
    put: (url, body, init) => request({ method: "PUT", url, body, ...init }),
    patch: (url, body, init) => request({ method: "PATCH", url, body, ...init }),
    delete: (url, init) => request({ method: "DELETE", url, ...init }),
    extend: (overrides) => createHttpClient({ ...options, ...overrides }),
  };
  return client;
}

function resolveOptions(options: HttpClientOptions): ResolvedOptions {
  if (options.baseUrl !== undefined && !isValidUrl(options.baseUrl)) {
    throw new RequestError(`invalid baseUrl: ${options.baseUrl}`);
  }
  return {
    baseUrl: options.baseUrl,
    defaultHeaders: options.defaultHeaders ?? {},
    timeoutMs: options.timeoutMs,
    resilience: options.resilience,
    parseProblem: options.parseProblem ?? true,
    throwOnError: options.throwOnError ?? true,
    codec: options.codec ?? jsonCodec,
    fetch: options.fetch ?? passthroughFetch,
    telemetry: options.telemetry,
  };
}

interface FetchArgs {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: BodyInit | undefined;
  readonly callerSignal?: AbortSignal;
  readonly deadline?: Deadline;
}

/**
 * Run the fetch, optionally through the resilience pipeline. Transport
 * errors are mapped to the typed taxonomy **at the fetch boundary**, so a
 * resilience policy sees (and may retry) `RequestError`/`TimeoutError`,
 * and whatever the pipeline ultimately throws propagates untouched.
 */
async function runFetch(
  resolved: ResolvedOptions,
  doFetch: FetchLike,
  args: FetchArgs,
): Promise<Response> {
  const attempt = async (pipelineSignal?: AbortSignal): Promise<Response> => {
    const signal = combineSignals([
      args.callerSignal,
      args.deadline?.signal,
      pipelineSignal,
    ]);
    try {
      return await doFetch(args.url, {
        method: args.method,
        headers: args.headers,
        body: args.body,
        signal,
      });
    } catch (error) {
      if (args.deadline?.timedOut) {
        throw new TimeoutError(args.deadline.timeoutMs, { cause: error });
      }
      if (args.callerSignal?.aborted && isAbortError(error)) throw error;
      if (error instanceof HttpError) throw error;
      throw new RequestError(messageOf(error), { cause: error });
    }
  };

  if (resolved.resilience) {
    return resolved.resilience.execute((ctx) => attempt(ctx.signal));
  }
  return attempt();
}

/** Map a settled response into an {@link HttpResponse} or a typed error. */
async function finalize<T>(
  resolved: ResolvedOptions,
  response: Response,
): Promise<HttpResponse<T>> {
  if (!response.ok) {
    if (resolved.parseProblem && isProblemResponse(response)) {
      throw await parseProblem(response);
    }
    if (resolved.throwOnError) {
      throw new ResponseError(response);
    }
  }
  const body = await resolved.codec.decode<T>(response);
  return { status: response.status, headers: response.headers, body, raw: response };
}

function buildBody(
  resolved: ResolvedOptions,
  req: ClientRequest,
  method: string,
): { headers: Headers; body: BodyInit | undefined } {
  const headers = new Headers(resolved.defaultHeaders);
  if (req.headers) {
    const provided = new Headers(req.headers as HeadersInit);
    provided.forEach((value, key) => headers.set(key, value));
  }

  if (req.body === undefined || method === "GET" || method === "HEAD") {
    return { headers, body: undefined };
  }
  if (isRawBody(req.body)) {
    return { headers, body: req.body as BodyInit };
  }
  const encoded = resolved.codec.encode(req.body);
  if (encoded !== undefined && !headers.has("content-type")) {
    headers.set("content-type", resolved.codec.contentType);
  }
  return { headers, body: encoded };
}

function buildUrl(
  baseUrl: string | undefined,
  url: string,
  query: ClientInit["query"],
): string {
  let resolvedUrl: URL;
  try {
    resolvedUrl = baseUrl ? new URL(url, baseUrl) : new URL(url);
  } catch (error) {
    throw new RequestError(`invalid request url: ${url}`, { cause: error });
  }
  if (query) {
    const params =
      query instanceof URLSearchParams
        ? query
        : toSearchParams(query);
    params.forEach((value, key) => resolvedUrl.searchParams.append(key, value));
  }
  return resolvedUrl.toString();
}

function toSearchParams(
  query: Record<string, string | number | boolean | undefined>,
): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  return params;
}

/** A per-request deadline backed by an `AbortSignal` and a timer. */
interface Deadline {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  timedOut: boolean;
  clear(): void;
}

function armTimeout(timeoutMs: number | undefined): Deadline | undefined {
  if (timeoutMs === undefined) return undefined;
  const controller = new AbortController();
  const deadline: Deadline = {
    signal: controller.signal,
    timeoutMs,
    timedOut: false,
    clear() {
      clearTimeout(timer);
    },
  };
  const timer = setTimeout(() => {
    deadline.timedOut = true;
    controller.abort(new TimeoutError(timeoutMs));
  }, timeoutMs);
  return deadline;
}

function combineSignals(
  signals: ReadonlyArray<AbortSignal | undefined>,
): AbortSignal | undefined {
  const present = signals.filter((s): s is AbortSignal => s !== undefined);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return AbortSignal.any(present);
}

async function parseProblem(response: Response): Promise<ProblemError> {
  try {
    const data = (await response.json()) as Partial<ProblemDetails>;
    return new ProblemError({ ...data, status: data.status ?? response.status });
  } catch (error) {
    // A broken problem body still maps to a ProblemError on the status.
    return new ProblemError(
      { status: response.status, detail: "malformed problem body" },
      { cause: error },
    );
  }
}

function isProblemResponse(response: Response): boolean {
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.toLowerCase().includes(PROBLEM_CONTENT_TYPE);
}

function isRawBody(body: unknown): boolean {
  return (
    typeof body === "string" ||
    body instanceof ArrayBuffer ||
    body instanceof Blob ||
    body instanceof FormData ||
    body instanceof URLSearchParams ||
    body instanceof ReadableStream ||
    ArrayBuffer.isView(body)
  );
}

function isValidUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function errorLabel(error: unknown): string {
  if (error instanceof ResponseError) return String(error.status);
  if (error instanceof ProblemError) return String(error.status);
  return "error";
}
