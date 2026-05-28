/**
 * Boot-summary + dynamic-update log emission.
 *
 * Both the static loader (`defineConfig`) and the dynamic loader
 * (`defineDynamicConfig`) emit a single structured log line through
 * an injected {@link Logger}. The log shape is locked to the spec
 * and intentionally narrow — no values, only keys.
 *
 * @module
 */

import type { ConfigProviderErrorPhase } from "./errors";
import type { Logger } from "./logger";

/**
 * Payload for the boot-time summary line, emitted exactly once per
 * successful {@link defineConfig} call when `options.logger` is
 * supplied.
 *
 * Fields match the spec example verbatim:
 * - `module` — fixed `"forge/config"`.
 * - `boot_time_ms` — wall-clock duration of the load step.
 * - `sources` — `name` of each source in the stack (lowest priority
 *   first, matching evaluation order).
 * - `loaded_keys` — every dotted path whose value made it into the
 *   tree (defaults included).
 * - `redacted_keys` — subset of `loaded_keys` whose value was wrapped
 *   in `Secret`.
 */
export interface BootSummary {
  readonly bootTimeMs: number;
  readonly sources: readonly string[];
  readonly loadedKeys: readonly string[];
  readonly redactedKeys: readonly string[];
}

/**
 * Payload for the per-update line emitted by `defineDynamicConfig`
 * after a provider snapshot has been validated and swapped in.
 */
export interface DynamicUpdateSummary {
  readonly provider: string;
  readonly updateTimeMs: number;
  readonly changedKeys: readonly string[];
}

const MODULE_TAG = "forge/config";

/**
 * Emit the boot-summary line. Field names use `snake_case` so the
 * line matches the spec exactly when serialised by a JSON logger.
 */
export function emitBootSummary(logger: Logger, summary: BootSummary): void {
  logger.info("Configuration loaded successfully", {
    module: MODULE_TAG,
    boot_time_ms: summary.bootTimeMs,
    sources: summary.sources,
    loaded_keys: summary.loadedKeys,
    redacted_keys: summary.redactedKeys,
  });
}

/**
 * Emit the dynamic-update line. Uses `warn` (not `info`) to match the
 * spec's example, which surfaces dynamic changes as something the
 * operator should notice in the log stream.
 */
export function emitDynamicUpdate(
  logger: Logger,
  summary: DynamicUpdateSummary,
): void {
  logger.warn("Dynamic config updated", {
    module: MODULE_TAG,
    provider: summary.provider,
    update_time_ms: summary.updateTimeMs,
    changed_keys: summary.changedKeys,
  });
}

/**
 * Emit a structured error line when a provider or `onChange` callback
 * throws while `propagateProviderErrors === false`. The thrown error
 * is reported via the `error.*` attrs (name + message) — never via
 * the `Error` object itself, which not every logger serialises
 * faithfully.
 */
export function emitProviderError(
  logger: Logger,
  attrs: {
    readonly provider: string;
    readonly phase: ConfigProviderErrorPhase;
    readonly error: unknown;
  },
): void {
  const e = attrs.error;
  const name = e instanceof Error ? e.name : typeof e;
  const message = e instanceof Error ? e.message : String(e);
  logger.error("Dynamic config provider error", {
    module: MODULE_TAG,
    provider: attrs.provider,
    phase: attrs.phase,
    "error.name": name,
    "error.message": message,
  });
}
