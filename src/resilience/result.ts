/**
 * `Result<T, E>` — discriminated union for the no-throw pipeline API.
 *
 * Exceptions are expensive on the hot path in V8/JSC. Consumers that
 * need to handle resilience failures inside a tight loop call
 * `pipeline.executeResult(...)` and branch on `result.ok` instead of
 * paying for a thrown stack trace.
 *
 * Both variants ship `isOk()` / `isErr()` so consumers can use either
 * a tag check (`if (result.ok)`) or the predicate (`if
 * (result.isOk())`) — whichever reads better at the call site.
 *
 * @module
 */

/** Successful execution outcome. */
export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
  isOk(): this is Ok<T>;
  isErr(): false;
}

/** Failed execution outcome. */
export interface Err<E> {
  readonly ok: false;
  readonly error: E;
  isOk(): false;
  isErr(): this is Err<E>;
}

export type Result<T, E> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
  return {
    ok: true,
    value,
    isOk(): this is Ok<T> {
      return true;
    },
    isErr(): false {
      return false;
    },
  };
}

export function err<E>(error: E): Err<E> {
  return {
    ok: false,
    error,
    isOk(): false {
      return false;
    },
    isErr(): this is Err<E> {
      return true;
    },
  };
}

export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}
