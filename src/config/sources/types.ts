/**
 * `ConfigSource` — the read-only interface every source implements.
 *
 * The boundary mirrors `LogExporter` / `SpanExporter` from
 * `forge/telemetry`: tiny, side-effect-light, and trivially mockable.
 *
 * @module
 */

/**
 * Lookup descriptor passed to every {@link ConfigSource}. Sources are
 * free to use whichever field matches their convention: env-style
 * sources match on `envVar`, the CLI source accepts either.
 */
export interface SourceLookup {
  /** Dotted schema path, e.g. `"db.pool.max"`. */
  readonly path: string;
  /** Resolved env-var name, e.g. `"DB_POOL_MAX"`. */
  readonly envVar: string;
}

/**
 * A read-only provider of raw string values for configuration leaves.
 *
 * Sources are queried in priority order (lowest first); the highest
 * priority source that returns a defined value wins. Sources MUST
 * return `undefined` (not an empty string) when they have no value
 * for the given lookup — an empty string is treated as a present,
 * intentionally-empty value and will be passed to the leaf parser.
 */
export interface ConfigSource {
  /** Stable identifier (used in the boot-summary `sources` list). */
  readonly name: string;
  /** Return the raw string value for `lookup`, or `undefined` when absent. */
  get(lookup: SourceLookup): string | undefined;
}
