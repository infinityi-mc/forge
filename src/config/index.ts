/**
 * `forge/config` — schema-validated, fail-fast configuration with
 * native secret redaction.
 *
 * The module turns environment into a typed, deeply-frozen object at
 * boot. If any required value is missing or malformed, the process
 * exits with a beautiful diagnostic table before the application
 * begins serving traffic.
 *
 * @example Minimal usage
 * ```ts
 * import { defineConfig, t } from "forge/config";
 *
 * export const config = defineConfig({
 *   app: {
 *     name: t.string.default("forge-app"),
 *     env: t.enum(["development", "staging", "production"]).required(),
 *     port: t.port.default(3000),
 *   },
 *   db: {
 *     url: t.url.required(),
 *   },
 *   auth: {
 *     jwtSecret: t.secret.required(),
 *   },
 * });
 *
 * // config.app.port  is inferred as `number`
 * // config.db.url    is inferred as `URL`
 * // config.auth.jwtSecret is inferred as `Secret<string>`
 * ```
 *
 * @module
 */

export { defineConfig, defaultSources } from "./define";
export type { DefineConfigOptions } from "./define";

export {
  defineDynamicConfig,
  diff,
} from "./dynamic";
export type {
  DefineDynamicConfigOptions,
  DynamicConfigHandle,
} from "./dynamic";

export { pollingProvider, staticProvider } from "./providers";
export type {
  DynamicConfigProvider,
  DynamicConfigSnapshot,
  DynamicSnapshotHandler,
  PollingProviderOptions,
  StaticProviderOptions,
} from "./providers";

export { Secret, isSecret } from "./secret";

export { t } from "./schema/builder";

export {
  ConfigError,
  ConfigFrozenError,
  ConfigProviderError,
  ConfigSchemaError,
  ConfigSecretAccessError,
  ConfigSourceError,
  ConfigValidationError,
} from "./errors";
export type { ConfigDiagnostic } from "./errors";

export { cliSource, dotenvSource, envSource } from "./sources";
export type {
  CliSourceOptions,
  ConfigSource,
  DotenvSourceOptions,
  EnvSourceOptions,
  SourceLookup,
} from "./sources";

export { formatDiagnostics, writeFailFast } from "./diagnostics";
export type {
  FormatDiagnosticsOptions,
  WriteFailFastOptions,
} from "./diagnostics";

export type { Logger, LogAttributes } from "./logger";

export type { ConfigSchema, Infer, Leaf } from "./types";
