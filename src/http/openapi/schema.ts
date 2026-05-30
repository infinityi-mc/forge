/**
 * `Schema` → OpenAPI 3.1 schema-object resolution.
 *
 * A {@link Schema} optionally exposes `toJsonSchema()`. When it does, that
 * fragment is emitted verbatim (OpenAPI 3.1 schemas *are* JSON Schema, so a
 * validator that speaks JSON Schema — Zod via `z.toJSONSchema`, etc. — drops
 * in directly). When it doesn't, we fall back to a permissive `{}` so the
 * route is still documented, just without a typed body shape.
 *
 * @module
 */

import type { JsonSchema, Schema } from "../server/types";

/** Resolve a {@link Schema} (or absence) to an OpenAPI 3.1 schema object. */
export function schemaToJson(schema: Schema | undefined): JsonSchema {
  if (schema && typeof schema.toJsonSchema === "function") {
    return schema.toJsonSchema();
  }
  return {};
}

/**
 * If a schema resolves to a JSON-Schema `object`, return its `properties` and
 * `required` set — used to expand a query schema into individual OpenAPI query
 * parameters and to attach per-param schemas. Returns `undefined` otherwise.
 */
export function objectShape(
  schema: Schema | undefined,
): { properties: Record<string, JsonSchema>; required: ReadonlySet<string> } | undefined {
  const json = schemaToJson(schema);
  const props = json["properties"];
  if (props === null || typeof props !== "object") return undefined;
  const required = Array.isArray(json["required"])
    ? new Set((json["required"] as unknown[]).filter((v): v is string => typeof v === "string"))
    : new Set<string>();
  return { properties: props as Record<string, JsonSchema>, required };
}
