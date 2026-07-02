import { describe, expect, test } from "bun:test";
import { t, type PreferenceSchema } from "../../src/preference";

const validPreferenceSchema = {
  theme: t.enum(["light", "dark", "system"] as const).default("system"),
  workspaceName: t.string.optional(),
  endpoint: t.url.default(new URL("https://example.com")).secret(),
} satisfies PreferenceSchema;

// @ts-expect-error preference leaves must declare `.default(...)` or `.optional()`.
const invalidPreferenceSchema = { theme: t.string } satisfies PreferenceSchema;

const requiredAfterOptionalSchema = {
  // @ts-expect-error `.required()` clears the optional fallback marker.
  theme: t.string.optional().required(),
} satisfies PreferenceSchema;

void invalidPreferenceSchema;
void requiredAfterOptionalSchema;

describe("preference type surface", () => {
  test("valid schema examples still run at runtime", () => {
    expect(validPreferenceSchema.theme.hasDefault).toBe(true);
    expect(validPreferenceSchema.workspaceName.isOptional).toBe(true);
  });
});
