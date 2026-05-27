/**
 * Cross-signal types shared by `forge/telemetry/log`, `forge/telemetry/meter`,
 * and `forge/telemetry/trace`.
 *
 * @module
 */

/**
 * Static information about the service emitting telemetry. Attached to
 * every record/metric/span at the exporter boundary. The same shape OTel
 * calls a "Resource".
 */
export interface Resource {
  /** Human-readable service name. Required. */
  readonly serviceName: string;
  /** Service version (semver, git sha, build id — anything you can grep). */
  readonly serviceVersion?: string;
  /** Deployment environment — `"production"`, `"staging"`, `"dev"`, etc. */
  readonly environment?: string;
  /** Open-ended attributes attached to every emission. */
  readonly attributes?: Readonly<Record<string, string>>;
}
