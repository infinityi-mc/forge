/**
 * Live-view proxy for the dynamic configuration tree.
 *
 * The proxy delegates every read to a single `ref.current` slot that
 * holds the **most recently validated and deep-frozen** snapshot. A
 * subsequent provider update replaces `ref.current`; the next read
 * sees the new value automatically — no need to re-call any factory.
 *
 * Reads of nested subtrees return whatever lives at that key in the
 * current snapshot (i.e. a frozen plain object). Capturing the
 * subtree into a local variable therefore "pins" it to the snapshot
 * that was live at access time — which is exactly the right
 * semantics for short-lived request handlers and a behaviour we
 * document explicitly in the README. Always reach for `flags.values`
 * at the top of each access if you want the latest.
 *
 * @module
 */

/**
 * Mutable reference cell whose `current` slot the proxy reads on
 * every access. Exposed as a type so the loader can both create the
 * proxy and swap the snapshot through the same slot.
 */
export interface SnapshotRef<T> {
  current: T;
}

export interface SnapshotProxyOptions {
  readonly namespace?: string;
  readonly mutationHint?: string;
}

/**
 * Build a Proxy of `T` whose every read goes through `ref.current`.
 * The Proxy is opaque — `Object.keys`, `for…in`, `in`, and property
 * descriptor lookups all delegate to the live snapshot, which lets
 * callers spread / inspect the tree as if it were a plain object.
 */
export function createSnapshotProxy<T extends object>(
  ref: SnapshotRef<T>,
  options: SnapshotProxyOptions = {},
): T {
  const namespace = options.namespace ?? "forge/config";
  const mutationHint =
    options.mutationHint ??
    "dynamic config is read-only; mutations come from the provider.";
  // The handler target is a plain `{}`; every trap re-derives its
  // answer from `ref.current`. Using `ref.current` directly as the
  // target would freeze the proxy's behaviour to the *initial* tree.
  const handler: ProxyHandler<object> = {
    get(_target, key) {
      return (ref.current as Record<PropertyKey, unknown>)[key];
    },
    has(_target, key) {
      return key in (ref.current as object);
    },
    ownKeys(_target) {
      return Reflect.ownKeys(ref.current as object);
    },
    getOwnPropertyDescriptor(_target, key) {
      const desc = Object.getOwnPropertyDescriptor(ref.current as object, key);
      if (desc === undefined) return undefined;
      // Proxy invariants are checked against the proxy target, not
      // against `ref.current`. Because our target is a plain `{}` with
      // no own non-configurable properties, reflected snapshot keys
      // are virtual properties and must be reported as configurable.
      // Forwarding the frozen snapshot's `configurable: false` would
      // violate the invariant for this empty target.
      return { ...desc, configurable: true };
    },
    getPrototypeOf(_target) {
      return Object.getPrototypeOf(ref.current as object);
    },
    // Mutations are rejected — the dynamic surface is read-only just
    // like the static surface. The provider is the only way new
    // values enter the tree.
    set(_target, key) {
      throw new TypeError(
        `${namespace}: cannot assign to '${String(key)}' — ${mutationHint}`,
      );
    },
    deleteProperty(_target, key) {
      throw new TypeError(
        `${namespace}: cannot delete '${String(key)}' — ${mutationHint}`,
      );
    },
    defineProperty(_target, key) {
      throw new TypeError(
        `${namespace}: cannot defineProperty '${String(key)}' — ${mutationHint}`,
      );
    },
  };
  // The Proxy type-parameter has to match the handler's target, but
  // the *exposed* value is `T` — the handler re-derives every read
  // from `ref.current: T`, so callers see the latest snapshot's
  // shape. The `as unknown as T` widens past the structural mismatch
  // that `new Proxy({}, …) : object` would otherwise produce.
  return new Proxy({}, handler) as unknown as T;
}
