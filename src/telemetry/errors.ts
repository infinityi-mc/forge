/**
 * Typed error taxonomy for `forge/telemetry`.
 *
 * Signal-specific subclasses (`LogError`, …) extend `TelemetryError` so
 * consumers can branch with a single `instanceof TelemetryError` check
 * when they don't care which signal failed.
 *
 * @module
 */

/**
 * Base class for every error thrown by `forge/telemetry`. Subclassed by
 * each signal so a single `catch (err) { if (err instanceof TelemetryError) … }`
 * suffices for transport-agnostic recovery.
 */
export class TelemetryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TelemetryError";
  }
}
