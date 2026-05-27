/**
 * Convert an `Error` (or any unknown thrown value) into a plain object
 * that survives `JSON.stringify`. `Error` instances have non-enumerable
 * `message`, `name`, and `stack`, so the default `JSON.stringify(err)`
 * returns `"{}"` — call this when attaching errors to log attributes.
 *
 * Follows the chain of `.cause` so nested errors are preserved. Cycles
 * are broken with a sentinel string.
 *
 * @example
 * ```ts
 * try {
 *   doWork();
 * } catch (err) {
 *   log.error("work failed", { err: serializeError(err) });
 * }
 * ```
 *
 * @module
 */

export function serializeError(value: unknown): unknown {
  return serialize(value, new WeakSet());
}

interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  cause?: unknown;
  [key: string]: unknown;
}

function serialize(value: unknown, seen: WeakSet<object>): unknown {
  if (!(value instanceof Error)) {
    return value;
  }
  if (seen.has(value)) {
    return "[circular]";
  }
  seen.add(value);

  const out: SerializedError = {
    name: value.name,
    message: value.message,
  };
  if (value.stack) {
    out.stack = value.stack;
  }
  if (value.cause !== undefined) {
    out.cause = serialize(value.cause, seen);
  }

  for (const key of Object.keys(value)) {
    if (key === "name" || key === "message" || key === "stack" || key === "cause") {
      continue;
    }
    out[key] = (value as unknown as Record<string, unknown>)[key];
  }

  return out;
}
