/**
 * Structurally-typed logger contract for `forge/config`.
 *
 * The module emits a single boot-summary log line on successful load
 * and a per-update log line for dynamic config swaps. Both flow through
 * an injected {@link Logger}.
 *
 * The contract is intentionally tiny and structurally compatible with
 * `createLog` / child loggers produced by `forge/telemetry/log`, but
 * `forge/config` deliberately does **not** import from that package —
 * keeping config free of a hard telemetry dependency. Any object with
 * `info` / `warn` / `error` methods that accept `(msg, attrs)` will
 * satisfy the contract, including `console`.
 *
 * @module
 */

/**
 * Bag of structured attributes attached to a log line. Values are
 * accepted as `unknown` so callers can pass numbers, strings, arrays,
 * or nested objects; the receiving logger is responsible for
 * serialisation. The bag itself is treated as read-only.
 */
export type LogAttributes = Readonly<Record<string, unknown>>;

/**
 * Minimum logger surface that `forge/config` will invoke. Mirrors the
 * three severities the module actually emits — there is no `debug` /
 * `trace` / `fatal` because the module never produces those.
 */
export interface Logger {
  info(msg: string, attrs?: LogAttributes): void;
  warn(msg: string, attrs?: LogAttributes): void;
  error(msg: string, attrs?: LogAttributes): void;
}
