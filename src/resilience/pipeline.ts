/**
 * `combine(...)` — compose {@link Policy} instances into a runnable
 * {@link Pipeline}.
 *
 * Composition mirrors `forge/telemetry/log`'s middleware loop: the
 * outermost policy's `execute(next, ctx)` sees the operation first and
 * the innermost sees it last. For `combine(retry, timeout, breaker)`,
 * the flow is `retry → timeout → breaker → op`, so the breaker fails
 * fast inside the timeout, and retry sees a `TimeoutError` as a
 * retryable signal.
 *
 * The pipeline owns the root `AbortController` for the execution. An
 * inner `timeout` policy aborts a *child* controller so cooperating
 * I/O is cancelled when the deadline fires, but the root controller
 * is reserved for caller-side cancellation (passing it through
 * `Pipeline.execute` is a future extension).
 *
 * @module
 */

import { buildRootContext } from "./context";
import { ResilienceError } from "./errors";
import { err, ok, type Result } from "./result";
import type {
  ExecutionContext,
  Operation,
  Pipeline,
  Policy,
} from "./types";

/**
 * Compose `policies` into a {@link Pipeline}. `policies[0]` is the
 * outermost layer. Passing zero policies yields an identity pipeline
 * that simply runs the operation against a fresh execution context —
 * useful for testing or for code paths that conditionally add layers.
 */
export function combine(...policies: readonly Policy[]): Pipeline {
  return createPipeline(policies);
}

function createPipeline(policies: readonly Policy[]): Pipeline {
  // Fold once at construction so the per-call hot path is just a
  // function invocation chain. Same shape as `applyMiddleware` in
  // `forge/telemetry/log/log.ts`.
  function buildChain<T>(op: Operation<T>): Operation<T> {
    let chain: Operation<T> = op;
    for (let i = policies.length - 1; i >= 0; i--) {
      const policy = policies[i]!;
      const inner = chain;
      chain = (ctx) => policy.execute(inner, ctx);
    }
    return chain;
  }

  async function execute<T>(op: Operation<T>): Promise<T> {
    const { context } = buildRootContext();
    return buildChain(op)(context);
  }

  async function executeResult<T>(
    op: Operation<T>,
  ): Promise<Result<T, ResilienceError>> {
    try {
      const value = await execute(op);
      return ok(value);
    } catch (error) {
      if (error instanceof ResilienceError) return err(error);
      // Wrap unknown errors so the no-throw contract is honored — the
      // caller still gets `result.error` regardless of what user code
      // threw. The cause preserves the original for debugging.
      return err(
        new ResilienceError("operation failed", { cause: error }),
      );
    }
  }

  return { execute, executeResult };
}

/**
 * Internal helper for composing a single policy on top of an
 * existing chain. Useful when policies recursively delegate (e.g.
 * `retry` calls its `next` repeatedly with a fresh `attempt`).
 */
export function runOperation<T>(
  op: Operation<T>,
  ctx: ExecutionContext,
): Promise<T> {
  return Promise.resolve().then(() => op(ctx));
}
