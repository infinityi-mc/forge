/**
 * Test helpers for `forge/resilience`.
 *
 * Ships a deterministic {@link TestClock} that policies in this PR
 * accept via their `clock` option, plus an {@link executionContext}
 * factory for unit tests that exercise a `Policy` directly without
 * going through a `Pipeline`.
 *
 * @module
 */

export { TestClock } from "./clock";

import type { ExecutionContext } from "../types";

export interface ExecutionContextOverrides {
  signal?: AbortSignal;
  attempt?: number;
}

/**
 * Build an {@link ExecutionContext} for direct-to-policy testing.
 * Defaults to a never-aborted signal and `attempt: 1`.
 *
 * @example
 * ```ts
 * import { executionContext, TestClock } from "forge/resilience/testing";
 * import { retry } from "forge/resilience";
 *
 * const ctx = executionContext();
 * const clock = new TestClock();
 * const policy = retry({ maxAttempts: 2, clock });
 * await policy.execute(op, ctx);
 * ```
 */
export function executionContext(
  overrides: ExecutionContextOverrides = {},
): ExecutionContext {
  const signal = overrides.signal ?? new AbortController().signal;
  return { signal, attempt: overrides.attempt ?? 1 };
}
