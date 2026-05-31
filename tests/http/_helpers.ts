import type { Schema } from "../../src/http/server/types";

/**
 * A tiny structural {@link Schema} double for tests: validates a flat object of
 * `string`/`number` fields, throws a `{ issues }` error (Zod-shaped) on
 * failure, and emits a JSON-Schema `object` from `toJsonSchema()`.
 */
export function objectSchema<T extends Record<string, unknown>>(
  fields: Record<keyof T & string, "string" | "number">,
): Schema<T> {
  return {
    parse(input: unknown): T {
      if (input === null || typeof input !== "object") {
        throw Object.assign(new Error("expected object"), {
          issues: [{ path: [], message: "not an object" }],
        });
      }
      const obj = input as Record<string, unknown>;
      const issues: { path: string[]; message: string }[] = [];
      const out: Record<string, unknown> = {};
      for (const [key, kind] of Object.entries(fields)) {
        const value = kind === "number" ? Number(obj[key]) : obj[key];
        if (kind === "number" && Number.isNaN(value)) {
          issues.push({ path: [key], message: "expected number" });
        } else if (kind === "string" && typeof value !== "string") {
          issues.push({ path: [key], message: "expected string" });
        } else {
          out[key] = value;
        }
      }
      if (issues.length > 0) throw Object.assign(new Error("validation failed"), { issues });
      return out as T;
    },
    toJsonSchema: () => ({
      type: "object",
      properties: Object.fromEntries(
        Object.entries(fields).map(([k, v]) => [k, { type: v }]),
      ),
      required: Object.keys(fields),
    }),
  };
}
