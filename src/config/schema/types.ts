/**
 * Internal types for the schema builder.
 *
 * Consumers do not import from this file directly; they build schemas
 * via the `t` builder exposed from `forge/config`.
 *
 * @module
 */

/**
 * Parse outcome for a single leaf. The `ok: true` branch returns the
 * coerced typed value; the `ok: false` branch returns a human-readable
 * reason that ends up in the diagnostic table.
 */
export type LeafParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

/**
 * Common state shared by every leaf. Lives on the leaf instance and
 * is copied (not aliased) by every chainable method so the builder
 * pattern stays immutable from the caller's perspective.
 */
export interface LeafState<T> {
  hasDefault: boolean;
  defaultValue?: T;
  isOptional: boolean;
  envName?: string;
  /** True when the leaf produces a {@link Secret} value (drives redaction). */
  isSecret: boolean;
}

/** Type-level marker added by `.default(...)` for schema surfaces that require fallbacks. */
export const DEFAULTED_LEAF: unique symbol = Symbol("forge/config/defaulted-leaf");

export interface DefaultedLeafMarker<T> {
  readonly [DEFAULTED_LEAF]: T;
  readonly hasDefault: true;
  readonly defaultValue: T;
}

export type DefaultedLeaf<T> = Leaf<T> & DefaultedLeafMarker<T>;

/** Type-level marker added by `.optional()` for schema surfaces that can safely fall back to `undefined`. */
export const OPTIONAL_LEAF: unique symbol = Symbol("forge/config/optional-leaf");

export interface OptionalLeafMarker<T> {
  readonly [OPTIONAL_LEAF]: T;
  readonly isOptional: true;
}

export type OptionalLeaf<T> = Leaf<T | undefined> & OptionalLeafMarker<T>;

/**
 * Marker symbol that identifies a value as a schema leaf. Used by the
 * walker to distinguish leaves from nested `ConfigSchema` objects
 * without relying on `instanceof Leaf` (which would break across
 * bundler boundaries).
 */
export const LEAF_BRAND: unique symbol = Symbol.for("forge/config/leaf");

/**
 * Abstract leaf base class. Each primitive (`StringLeaf`,
 * `NumberLeaf`, …) extends this and provides:
 *
 * - `kind` — a stable identifier surfaced in diagnostics.
 * - `parse(raw)` — coercion + validation logic.
 * - `clone()` — shallow copy used by chainable methods.
 *
 * The chainable methods (`default`, `required`, `optional`, `env`)
 * are implemented once on the base.
 */
export abstract class Leaf<T> {
  /** Brand for structural detection at runtime. */
  readonly [LEAF_BRAND] = true as const;
  /** Stable identifier (e.g. `"string"`, `"port"`). */
  abstract readonly kind: string;

  hasDefault = false;
  defaultValue?: T;
  isOptional = false;
  envName?: string;
  isSecret = false;

  /**
   * Coerce a raw string from a {@link ConfigSource} into the typed
   * value. Returns a structured outcome instead of throwing so
   * `defineConfig` can aggregate every issue before failing.
   */
  abstract parse(raw: string): LeafParseResult<T>;

  /**
   * Subclass-specific shallow copy. Must return a fresh leaf instance
   * with the same subclass-specific configuration (format flags, enum
   * variants, etc.). Base state is copied by {@link _copyBaseTo}.
   */
  protected abstract _cloneSelf(): Leaf<T>;

  /** Copy base-leaf state onto a freshly-cloned instance. */
  protected _copyBaseTo(target: Leaf<unknown>): void {
    target.hasDefault = this.hasDefault;
    if (this.hasDefault) target.defaultValue = this.defaultValue;
    target.isOptional = this.isOptional;
    target.envName = this.envName;
    target.isSecret = this.isSecret;
  }

  /**
   * Internal: produce a fresh leaf with the same configuration. Used
   * by chainable methods to maintain builder immutability.
   */
  protected _clone(): this {
    const c = this._cloneSelf() as this;
    this._copyBaseTo(c);
    return c;
  }

  /**
   * Set a fallback value used when no {@link ConfigSource} provides
   * the leaf. The leaf still reports its env-var name in the boot
   * summary, but no diagnostic fires when the env var is absent.
   */
  default(value: T): this & DefaultedLeafMarker<T> {
    const c = this._clone();
    c.hasDefault = true;
    c.defaultValue = value;
    return c as this & DefaultedLeafMarker<T>;
  }

  /**
   * Explicit "must be present" marker. Clones the leaf and clears
   * `isOptional`, so `.optional().required()` behaves as the chain
   * reads — required wins. Most callers reach for it as a readability
   * marker on a leaf that was already required.
   */
  required(): this extends OptionalLeafMarker<infer U> ? Leaf<U> : this {
    const c = this._clone();
    c.isOptional = false;
    return c as this extends OptionalLeafMarker<infer U> ? Leaf<U> : this;
  }

  /**
   * Mark the leaf as optional — the produced type widens to
   * `T | undefined` and a missing value is not a validation error.
   */
  optional(): OptionalLeaf<T> {
    const c = this._clone();
    c.isOptional = true;
    return c as unknown as OptionalLeaf<T>;
  }

  /**
   * Override the env-var name used to look up this leaf. By default
   * the path `db.url` is mapped to `DB_URL`; calling
   * `.env("DATABASE_URL")` overrides that to look at `DATABASE_URL`
   * instead — useful for matching the standard names cloud providers
   * already inject.
   */
  env(name: string): this {
    const c = this._clone();
    c.envName = name;
    return c;
  }
}

/**
 * Runtime check for "this value is a schema leaf". Used by the walker
 * to distinguish leaves from nested `ConfigSchema` groups.
 */
export function isLeaf(value: unknown): value is Leaf<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { [LEAF_BRAND]?: true })[LEAF_BRAND] === true
  );
}
