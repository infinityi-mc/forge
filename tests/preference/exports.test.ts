import { describe, expect, test } from "bun:test";
import * as preference from "../../src/preference";

describe("preference exports", () => {
  test("submodule entrypoint exposes the PR A public surface", () => {
    expect(preference.definePreferences).toBeFunction();
    expect(preference.memoryStore).toBeFunction();
    expect(preference.t).toBeDefined();
    expect(preference.PreferenceError).toBeFunction();
    expect(preference.PreferenceSchemaError).toBeFunction();
    expect(preference.PreferenceStoreError).toBeFunction();
    expect(preference.PreferenceValidationError).toBeFunction();
  });
});
