import { describe, expect, test } from "bun:test";
import * as preference from "../../src/preference";
import * as preferenceTesting from "../../src/preference/testing";

describe("preference exports", () => {
  test("submodule entrypoint exposes the public surface", () => {
    expect(preference.definePreferences).toBeFunction();
    expect(preference.jsonFileStore).toBeFunction();
    expect(preference.memoryStore).toBeFunction();
    expect(preference.sqliteStore).toBeFunction();
    expect(preference.t).toBeDefined();
    expect(preference.PreferenceError).toBeFunction();
    expect(preference.PreferenceSchemaError).toBeFunction();
    expect(preference.PreferenceStoreError).toBeFunction();
    expect(preference.PreferenceValidationError).toBeFunction();
  });

  test("testing entrypoint exposes store conformance helpers", () => {
    expect(preferenceTesting.assertPreferenceStoreConformance).toBeFunction();
    expect(preferenceTesting.STANDARD_PREFERENCE_STORE_SCENARIOS).toBeArray();
    expect(preferenceTesting.memoryStore).toBeFunction();
    expect(preferenceTesting.mockPreferences).toBeFunction();
  });
});
