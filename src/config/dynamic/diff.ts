/**
 * Snapshot-diff helper used by the `onChange` payload.
 *
 * Computes the set of **dotted leaf paths** whose value changed
 * between two validated configuration trees. The walker descends
 * into plain nested objects (the only kind `forge/config` produces
 * at boot via `setAtPath`), and treats anything else (URLs, Secrets,
 * arrays, primitives) as a single comparable value.
 *
 * @module
 */

import { isSecret, Secret } from "../secret";

/**
 * Return a sorted list of dotted leaf paths whose value differs
 * between `oldConfig` and `newConfig`.
 *
 * @example
 * ```ts
 * diff(
 *   { app: { port: 3000 }, features: { newCheckout: false } },
 *   { app: { port: 3000 }, features: { newCheckout: true  } },
 * );
 * // → ["features.newCheckout"]
 * ```
 *
 * Notes:
 * - Values are compared with `Object.is` after the descent stops,
 *   so `NaN === NaN` and `+0 / -0` distinctions behave intuitively.
 * - For `URL` instances, equality is the URL's string serialisation,
 *   not reference identity — two parses of the same URL string are
 *   considered equal.
 * - For `Secret<T>` instances, equality is unwrapped value equality
 *   that re-enters the same comparison — so `Secret<URL>` compares
 *   by URL serialisation, `Secret<string>` by string value, etc. The
 *   unwrap happens locally and the unwrapped value never leaves this
 *   function.
 * - For arrays (e.g. from `t.json<T[]>()`) equality is element-wise
 *   structural equality, so two snapshots that produce arrays with
 *   the same content do not false-positive a diff.
 * - Paths that exist on only one side are reported.
 */
export function diff(
  oldConfig: unknown,
  newConfig: unknown,
): string[] {
  const out: string[] = [];
  walk(oldConfig, newConfig, [], out);
  out.sort();
  return out;
}

function walk(
  a: unknown,
  b: unknown,
  path: readonly string[],
  out: string[],
): void {
  if (isPlainRecord(a) && isPlainRecord(b)) {
    const keys = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      walk(a[key], b[key], [...path, key], out);
    }
    return;
  }
  if (!equal(a, b)) {
    out.push(path.join("."));
  }
}

function equal(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;

  // URL equality by serialisation. `instanceof URL` works because both
  // values were produced by the same V8 runtime — the consumers of
  // `diff` are always inside one Bun process.
  if (a instanceof URL && b instanceof URL) {
    return a.toString() === b.toString();
  }

  // Secret equality via the wrapped value. We recurse back into
  // `equal()` so the type-specific branches above (URL, arrays,
  // nested Secret) still apply — `Object.is` here would
  // false-positive a `Secret<URL>` whose two `URL` instances came
  // from separate parses of the same string. The cost of the unwrap
  // is justified — `diff` is called once per dynamic update (not per
  // request), and the unwrapped value is discarded immediately.
  if (isSecret(a) && isSecret(b)) {
    return equal(
      (a as Secret<unknown>).unwrap(),
      (b as Secret<unknown>).unwrap(),
    );
  }

  // Array equality by element-wise structural comparison. Without
  // this branch, `t.json<T[]>()` leaves would false-positive on every
  // poll — `Object.is` reference-compares array instances, so two
  // snapshots that parsed the same JSON would always look distinct.
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!equal(a[i], b[i])) return false;
    }
    return true;
  }

  // Plain-record equality for objects that appear *inside* a leaf
  // (e.g. items of an array under a `t.json<T[]>()` leaf, or values
  // of a `t.json<Record<string, …>>()` leaf). At the top level the
  // `walk` function handles records by descending and producing per-
  // key diff paths, but once we are inside `equal` we are comparing a
  // single leaf value — so this branch makes it a proper structural
  // deep-equal predicate.
  if (isPlainRecord(a) && isPlainRecord(b)) {
    const aKeys = Object.keys(a);
    if (aKeys.length !== Object.keys(b).length) return false;
    for (const key of aKeys) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
      if (!equal(a[key], b[key])) return false;
    }
    return true;
  }

  return false;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return false;
  if (value instanceof URL) return false;
  // Anything with a non-Object prototype (Date, Map, Set, URL,
  // Secret, …) is treated as a leaf value, not a record to descend
  // into.
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
