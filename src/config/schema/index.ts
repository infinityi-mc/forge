/**
 * Public exports for the schema builder.
 *
 * Most consumers import `t` and the types they need from
 * `forge/config` directly; this sub-entrypoint exists so advanced
 * users can build custom schemas / introspection helpers without
 * pulling in the loader.
 *
 * @module
 */

export { t } from "./builder";
export { Leaf, isLeaf } from "./types";
export type { LeafParseResult, LeafState } from "./types";
export { BooleanLeaf } from "./primitives/boolean";
export { EnumLeaf } from "./primitives/enum";
export { JsonLeaf } from "./primitives/json";
export { NumberLeaf } from "./primitives/number";
export { PortLeaf } from "./primitives/port";
export { SecretLeaf } from "./primitives/secret";
export { StringLeaf } from "./primitives/string";
export { UrlLeaf, UrlSecretLeaf } from "./primitives/url";
export {
  collectLeaves,
  deepFreeze,
  pathToEnvVar,
  setAtPath,
  type LeafEntry,
} from "./walk";
