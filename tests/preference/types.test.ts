import { describe, expect, test } from "bun:test";
import {
  definePreferences,
  memoryStore,
  t,
  type PreferencePath,
  type PreferencePathValue,
  type PreferenceSchema,
  type PreferenceUpdate,
  type PreferenceWritableValue,
  type PreferencesHandle,
} from "../../src/preference";

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

const nestedPreferenceSchema = {
  appearance: {
    theme: t.enum(["light", "dark", "system"] as const).default("system"),
    fontSize: t.number.default(14),
  },
  editor: {
    workspaceName: t.string.optional(),
  },
} satisfies PreferenceSchema;

type NestedPreferenceSchema = typeof nestedPreferenceSchema;

const validPath: PreferencePath<NestedPreferenceSchema> = "appearance.theme";
// @ts-expect-error preference paths must point at schema leaves.
const invalidPath: PreferencePath<NestedPreferenceSchema> = "appearance";

const themeValue: PreferencePathValue<
  NestedPreferenceSchema,
  "appearance.theme"
> = "dark";
const workspaceValue: PreferenceWritableValue<
  NestedPreferenceSchema,
  "editor.workspaceName"
> = "forge";
// @ts-expect-error set values exclude undefined; reset clears optionals.
const invalidWorkspaceValue: PreferenceWritableValue<
  NestedPreferenceSchema,
  "editor.workspaceName"
> = undefined;

const validUpdate: PreferenceUpdate<NestedPreferenceSchema> = {
  appearance: { fontSize: 16 },
};
const invalidUpdate = {
  appearance: {
    // @ts-expect-error update patches must use leaf value types.
    fontSize: "large",
  },
} satisfies PreferenceUpdate<NestedPreferenceSchema>;
const invalidUndefinedUpdate = {
  editor: {
    // @ts-expect-error reset clears optionals instead of update setting undefined.
    workspaceName: undefined,
  },
} satisfies PreferenceUpdate<NestedPreferenceSchema>;

async function writePathTypeChecks(
  prefs: PreferencesHandle<NestedPreferenceSchema>,
): Promise<void> {
  await prefs.set("appearance.theme", "dark");
  await prefs.set("editor.workspaceName", "forge");
  // @ts-expect-error path must exist.
  await prefs.set("appearance.missing", "dark");
  // @ts-expect-error value must match the path leaf.
  await prefs.set("appearance.fontSize", "large");
  // @ts-expect-error reset clears optionals instead of setting undefined.
  await prefs.set("editor.workspaceName", undefined);
}

async function scopedWriteTypeChecks(): Promise<void> {
  const prefs = await definePreferences(nestedPreferenceSchema, {
    scopes: {
      user: memoryStore(),
      workspace: memoryStore(),
    },
  });

  await prefs.set("appearance.theme", "dark", { scope: "workspace" });
  await prefs.reset("appearance.theme", { scope: "user" });
  prefs.isSet("appearance.theme", { scope: "workspace" });
  // @ts-expect-error scope must be one of the configured scope names.
  await prefs.set("appearance.theme", "dark", { scope: "machine" });
  // @ts-expect-error scope must be one of the configured scope names.
  prefs.isSet("appearance.theme", { scope: "machine" });
}

void invalidPreferenceSchema;
void requiredAfterOptionalSchema;
void validPath;
void invalidPath;
void themeValue;
void workspaceValue;
void invalidWorkspaceValue;
void validUpdate;
void invalidUpdate;
void invalidUndefinedUpdate;
void writePathTypeChecks;
void scopedWriteTypeChecks;

describe("preference type surface", () => {
  test("valid schema examples still run at runtime", () => {
    expect(validPreferenceSchema.theme.hasDefault).toBe(true);
    expect(validPreferenceSchema.workspaceName.isOptional).toBe(true);
  });
});
