/**
 * Typed error taxonomy for `forge/config`.
 *
 * Every error thrown by the module subclasses {@link ConfigError} so
 * consumers can branch with a single `instanceof ConfigError` check
 * when they don't care which phase failed, or narrow to a specific
 * subclass for targeted recovery.
 *
 * @module
 */

/**
 * Per-leaf description of why a configuration value failed to load.
 * Aggregated on {@link ConfigValidationError.issues} and rendered by
 * the diagnostics formatter into the fail-fast table.
 */
export interface ConfigDiagnostic {
  /** Dotted schema path of the failing leaf (e.g. `"db.pool.max"`). */
  readonly path: string;
  /** Environment variable name resolved for the leaf (e.g. `"DB_POOL_MAX"`). */
  readonly envVar: string;
  /**
   * Whether the value was missing entirely or present-but-invalid.
   * Drives the `❌ Missing` / `❌ Invalid` column in the diagnostic
   * table.
   */
  readonly status: "missing" | "invalid";
  /** Human-readable reason ("Must be one of …", "Invalid URL", …). */
  readonly reason: string;
  /**
   * Raw value that was seen, when applicable. Always omitted for leaves
   * whose schema marks them as secret to avoid leaking credentials into
   * stderr / log aggregators.
   */
  readonly received?: string;
}

/**
 * Base class for every error thrown by `forge/config`. Subclassed by
 * more specific errors; use this when no more specific category fits
 * or when an `instanceof ConfigError` check should catch the whole
 * family.
 */
export class ConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConfigError";
  }
}

/**
 * One or more leaves failed schema validation during
 * {@link defineConfig}. The aggregated {@link ConfigDiagnostic} list
 * is exposed on `issues` so callers using `throwOnError: true` can
 * render their own diagnostic surface; by default the module renders
 * the issues to stderr and calls `process.exit(1)`.
 */
export class ConfigValidationError extends ConfigError {
  readonly issues: readonly ConfigDiagnostic[];

  constructor(
    message: string,
    options: ErrorOptions & { issues: readonly ConfigDiagnostic[] },
  ) {
    super(message, options);
    this.name = "ConfigValidationError";
    this.issues = options.issues;
  }
}

/**
 * A {@link ConfigSource} threw while reading. Failure here is fatal
 * by default — a broken `.env` file or unreadable env-var registry
 * is a 12-Factor violation we refuse to paper over.
 */
export class ConfigSourceError extends ConfigError {
  readonly source: string;

  constructor(
    message: string,
    options: ErrorOptions & { source: string },
  ) {
    super(message, options);
    this.name = "ConfigSourceError";
    this.source = options.source;
  }
}

/**
 * The supplied schema is structurally invalid (e.g. an `enum` with no
 * variants, a `.default(value)` whose value type disagrees with the
 * leaf's parser). Thrown at `defineConfig()` time, before any source
 * is read.
 */
export class ConfigSchemaError extends ConfigError {
  readonly path?: string;

  constructor(
    message: string,
    options?: ErrorOptions & { path?: string },
  ) {
    super(message, options);
    this.name = "ConfigSchemaError";
    if (options?.path !== undefined) this.path = options.path;
  }
}

/**
 * `Secret#unwrap()` was called in a context where the surrounding
 * code intercepted the access (reserved for future contextual
 * redaction policies). Subclasses of `ConfigError` so callers can
 * uniformly catch config-related leaks.
 */
export class ConfigSecretAccessError extends ConfigError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConfigSecretAccessError";
  }
}

/**
 * The lifecycle phase a {@link ConfigProviderError} originated in.
 *
 * - `initial-load` — `provider.get()` threw during the seed fetch.
 * - `update` — a runtime snapshot failed validation.
 * - `on-change` — the user-supplied `onChange` callback threw.
 * - `subscribe` — `provider.subscribe()` threw at wire-up time.
 * - `shutdown` — `provider.shutdown()` or the returned `unsubscribe()`
 *   threw during teardown.
 * - `flush` — `provider.flush()` threw on an explicit drain.
 */
export type ConfigProviderErrorPhase =
  | "initial-load"
  | "update"
  | "on-change"
  | "subscribe"
  | "shutdown"
  | "flush";

/**
 * A {@link DynamicConfigProvider} failed during fetch / subscribe /
 * shutdown / flush, or an `onChange` callback threw. By default these
 * errors are caught and surfaced through the optional logger; passing
 * `propagateProviderErrors: true` to `defineDynamicConfig` raises
 * this class to the caller instead.
 */
export class ConfigProviderError extends ConfigError {
  readonly provider: string;
  readonly phase: ConfigProviderErrorPhase;

  constructor(
    message: string,
    options: ErrorOptions & {
      provider: string;
      phase: ConfigProviderErrorPhase;
    },
  ) {
    super(message, options);
    this.name = "ConfigProviderError";
    this.provider = options.provider;
    this.phase = options.phase;
  }
}

/**
 * A mutation was attempted on the frozen configuration object. The
 * standard JS engine throws `TypeError` in strict mode — this class
 * is exported for symmetry with the rest of the taxonomy and is
 * thrown by helpers that explicitly guard mutations.
 */
export class ConfigFrozenError extends ConfigError {
  readonly path?: string;

  constructor(
    message: string,
    options?: ErrorOptions & { path?: string },
  ) {
    super(message, options);
    this.name = "ConfigFrozenError";
    if (options?.path !== undefined) this.path = options.path;
  }
}
