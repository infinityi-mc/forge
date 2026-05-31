/**
 * `application/problem+json` serialization (RFC 7807 / RFC 9457).
 *
 * Kept dependency-free so it can be reused by both the client (parsing
 * is its mirror) and the server's `problemDetails()` middleware (PR B)
 * without importing the error classes — avoiding an import cycle with
 * `../errors`.
 *
 * @module
 */

import type { HeadersInit, ProblemDetails } from "../types";

/** Media type mandated by RFC 7807 for problem documents. */
export const PROBLEM_CONTENT_TYPE = "application/problem+json";

/** Default `type` when none is supplied, per RFC 7807 §4.2. */
export const DEFAULT_PROBLEM_TYPE = "about:blank";

/**
 * Normalize a partial problem (with at least `status`) into a complete
 * {@link ProblemDetails}. Fills `type` with `about:blank` and derives a
 * `title` from the status code when absent, preserving any extension
 * members.
 */
export function normalizeProblem(
  input: Partial<ProblemDetails> & { status: number },
): ProblemDetails {
  const { type, title, status, detail, instance, ...extensions } = input;
  const problem: Record<string, unknown> = {
    ...extensions,
    type: type ?? DEFAULT_PROBLEM_TYPE,
    title: title ?? statusText(status),
    status,
  };
  if (detail !== undefined) problem.detail = detail;
  if (instance !== undefined) problem.instance = instance;
  return problem as ProblemDetails;
}

/**
 * Serialize a {@link ProblemDetails} into a web {@link Response} with the
 * RFC 7807 media type and matching status code.
 */
export function renderProblem(
  problem: Partial<ProblemDetails> & { status: number },
  init?: { headers?: HeadersInit },
): Response {
  const normalized = normalizeProblem(problem);
  const headers = new Headers(init?.headers);
  headers.set("content-type", PROBLEM_CONTENT_TYPE);
  return new Response(JSON.stringify(normalized), {
    status: normalized.status,
    headers,
  });
}

/** Best-effort reason phrase for a status code; falls back to a generic label. */
export function statusText(status: number): string {
  return STATUS_TEXT[status] ?? (status >= 500 ? "Internal Server Error" : "Error");
}

const STATUS_TEXT: Readonly<Record<number, string>> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  410: "Gone",
  413: "Payload Too Large",
  415: "Unsupported Media Type",
  422: "Unprocessable Entity",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};
