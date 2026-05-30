/**
 * RFC 7807 *Problem Details* — `forge/http/problem`.
 *
 * One machine-readable error shape for the whole module. {@link ProblemError}
 * carries a {@link ProblemDetails}; the {@link problem} constructors are
 * shorthand for the common statuses; {@link renderProblem} serializes to
 * `application/problem+json`.
 *
 * @example
 * ```ts
 * import { problem } from "forge/http/problem";
 * throw problem.notFound("No such order", { orderId });
 * ```
 *
 * @module
 */

import { ProblemError } from "../errors";

export { ProblemError } from "../errors";
export type { ProblemDetails } from "../types";
export {
  renderProblem,
  normalizeProblem,
  statusText,
  PROBLEM_CONTENT_TYPE,
  DEFAULT_PROBLEM_TYPE,
} from "./render";

/** Extension members merged into the problem document. */
type Extensions = Record<string, unknown>;

function make(status: number, detail?: string, ext?: Extensions): ProblemError {
  // `...ext` first so extension members can never override the
  // constructor's intended status (mirrors `normalizeProblem`).
  return new ProblemError({
    ...ext,
    status,
    ...(detail !== undefined ? { detail } : {}),
  });
}

/**
 * Convenience constructors for the common HTTP problem statuses. Each
 * returns a ready-to-throw {@link ProblemError}; pass extension members
 * (e.g. `{ errors: [...] }`) as the second argument.
 */
export const problem = {
  /** 400 Bad Request. */
  badRequest: (detail?: string, ext?: Extensions) => make(400, detail, ext),
  /** 401 Unauthorized. */
  unauthorized: (detail?: string, ext?: Extensions) => make(401, detail, ext),
  /** 403 Forbidden. */
  forbidden: (detail?: string, ext?: Extensions) => make(403, detail, ext),
  /** 404 Not Found. */
  notFound: (detail?: string, ext?: Extensions) => make(404, detail, ext),
  /** 409 Conflict. */
  conflict: (detail?: string, ext?: Extensions) => make(409, detail, ext),
  /** 422 Unprocessable Entity. */
  unprocessable: (detail?: string, ext?: Extensions) => make(422, detail, ext),
  /** 429 Too Many Requests. */
  tooManyRequests: (detail?: string, ext?: Extensions) => make(429, detail, ext),
  /** 500 Internal Server Error. */
  internal: (detail?: string, ext?: Extensions) => make(500, detail, ext),
} as const;
