/**
 * Public re-export for the built-in sources.
 *
 * Sources are stacked lowest-priority first; `defineConfig` resolves
 * each leaf by walking the stack in reverse and using the first
 * source that returns a defined value. Schema defaults are applied
 * after every source has been consulted.
 *
 * @module
 */

export { cliSource, parseFlags } from "./cli";
export type { CliSourceOptions } from "./cli";
export { dotenvSource, parseDotenv } from "./dotenv";
export type { DotenvSourceOptions } from "./dotenv";
export { envSource } from "./env";
export type { EnvSourceOptions } from "./env";
export type { ConfigSource, SourceLookup } from "./types";
