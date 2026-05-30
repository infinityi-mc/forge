/**
 * {@link HttpRequest} over a native web {@link Request}.
 *
 * A thin, lazily-evaluated view: `url`/`query` are parsed once, `json()` is
 * memoized (so `validate()` and the handler can both read the body without
 * the native stream's single-consume restriction), `text()` delegates to the
 * native body, and `locals` is the mutable per-request bag middleware writes
 * to (e.g. an auth principal). The native object is always reachable via `raw`.
 *
 * @module
 */

import type { HttpRequest } from "../types";

/** Build the {@link HttpRequest} a handler sees from a native request. */
export function createHttpRequest(
  raw: Request,
  params: Readonly<Record<string, string>> = {},
  signal?: AbortSignal,
): HttpRequest {
  const url = new URL(raw.url);
  let jsonPromise: Promise<unknown> | undefined;
  return {
    raw,
    method: raw.method.toUpperCase(),
    url,
    params,
    query: url.searchParams,
    headers: raw.headers,
    locals: {},
    // Prefer the request's own abort signal (Bun aborts it on client
    // disconnect); fall back to a never-aborting signal when absent.
    signal: signal ?? raw.signal ?? new AbortController().signal,
    json<T = unknown>(): Promise<T> {
      // Memoize: the native body is a single-use stream, but middleware
      // (e.g. validate()) and the handler both need to read it.
      jsonPromise ??= raw.json();
      return jsonPromise as Promise<T>;
    },
    text(): Promise<string> {
      return raw.text();
    },
  };
}
