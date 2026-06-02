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

import { ProblemError } from "../errors";
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

/**
 * Cap body consumption at `maxBytes`, enforced **as bytes are read** rather
 * than from the (advisory, omittable) `Content-Length` header. Rewires the
 * request's `json()`/`text()` to stream `raw.body`, count bytes, and throw a
 * `413` {@link ProblemError} the moment the cap is exceeded — before any
 * parse. `validate()` and handlers read through these methods, so they
 * inherit the bound transparently. Reading `req.raw.json()`/`req.raw.text()`
 * directly bypasses this; use the {@link HttpRequest} view.
 */
export function applyBodyLimit(req: HttpRequest, maxBytes: number): void {
  let textPromise: Promise<string> | undefined;
  let jsonPromise: Promise<unknown> | undefined;

  const readText = (): Promise<string> => {
    textPromise ??= readLimitedText(req.raw, maxBytes);
    return textPromise;
  };

  req.text = readText;
  req.json = <T = unknown>(): Promise<T> => {
    jsonPromise ??= readText().then((body) => (body === "" ? undefined : JSON.parse(body)));
    return jsonPromise as Promise<T>;
  };
}

/** Read a body to text, aborting with a `413` once `maxBytes` is exceeded. */
async function readLimitedText(raw: Request, maxBytes: number): Promise<string> {
  const reader = raw.body?.getReader();
  if (!reader) return "";

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ProblemError({
          status: 413,
          detail: `Request body exceeds the ${maxBytes}-byte limit`,
        });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(buffer);
}
