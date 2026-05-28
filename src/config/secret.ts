/**
 * `Secret<T>` — leak-resistant wrapper for credentials and other
 * sensitive values.
 *
 * The constructor accepts the raw value once and never exposes it
 * through the usual leak surfaces:
 *
 * - `String(secret)` / `${secret}` → `"[REDACTED]"` via {@link toString}.
 * - `JSON.stringify(secret)` → `"[REDACTED]"` via {@link toJSON}.
 * - `console.log(secret)` / `util.inspect(secret)` → `Secret <[REDACTED]>`
 *   via the `nodejs.util.inspect.custom` symbol.
 *
 * Callers that genuinely need the raw value must call {@link unwrap}
 * explicitly — the unwrap site is grep-able, making credential
 * handling auditable.
 *
 * @module
 */

const REDACTED = "[REDACTED]";
const INSPECT_CUSTOM = Symbol.for("nodejs.util.inspect.custom");

/**
 * Leak-resistant wrapper. `T` defaults to `string` because that's the
 * common shape (API tokens, JWT secrets, DB passwords), but
 * `Secret<URL>` and `Secret<{ user; pass }>` are equally supported.
 */
export class Secret<T = string> {
  // Private field (not enumerable, not inspectable) keeps the value off
  // any default serializer. We deliberately do NOT expose a getter.
  readonly #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  /**
   * Return the underlying value. Call this only at the moment the
   * value is needed — never store the result on a long-lived object.
   */
  unwrap(): T {
    return this.#value;
  }

  /**
   * Replaces the default `[object Object]` / value-coercion output.
   * Covers template literals, `String(secret)`, and string
   * concatenation.
   */
  toString(): string {
    return REDACTED;
  }

  /**
   * `JSON.stringify` invokes `toJSON` per spec. Returning a plain
   * string sentinel guarantees the value never reaches the network
   * even when an attribute is accidentally serialized.
   */
  toJSON(): string {
    return REDACTED;
  }

  /**
   * Node / Bun's `util.inspect` honors this well-known symbol.
   * `console.log(secret)` calls `util.inspect` under the hood, so
   * this single hook covers both surfaces.
   */
  [INSPECT_CUSTOM](): string {
    return `Secret <${REDACTED}>`;
  }
}

/**
 * Narrow `value is Secret<T>`. Useful when walking an arbitrary
 * configuration tree (e.g. inside the boot-summary emitter) to decide
 * whether a leaf's key should be added to `redacted_keys`.
 */
export function isSecret(value: unknown): value is Secret<unknown> {
  return value instanceof Secret;
}
