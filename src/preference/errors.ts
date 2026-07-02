/**
 * Typed error taxonomy for `forge/preference`.
 *
 * Preference reads are fail-safe by design: user data problems become
 * diagnostics and defaults, not thrown errors. These classes cover the
 * programmer-error and future write-path surfaces where throwing is still
 * appropriate.
 *
 * @module
 */

import type { PreferenceDiagnostic } from "./types";

/** Base class for every error thrown by `forge/preference`. */
export class PreferenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PreferenceError";
  }
}

/** The supplied preference schema is structurally invalid. */
export class PreferenceSchemaError extends PreferenceError {
  readonly path?: string;

  constructor(message: string, options?: ErrorOptions & { path?: string }) {
    super(message, options);
    this.name = "PreferenceSchemaError";
    if (options?.path !== undefined) this.path = options.path;
  }
}

/** A preference store failed outside the fail-safe read path. */
export class PreferenceStoreError extends PreferenceError {
  readonly store: string;

  constructor(message: string, options: ErrorOptions & { store: string }) {
    super(message, options);
    this.name = "PreferenceStoreError";
    this.store = options.store;
  }
}

/** Invalid data was supplied by the caller on the write path. */
export class PreferenceValidationError extends PreferenceError {
  readonly diagnostics: readonly PreferenceDiagnostic[];

  constructor(
    message: string,
    options: ErrorOptions & { diagnostics: readonly PreferenceDiagnostic[] },
  ) {
    super(message, options);
    this.name = "PreferenceValidationError";
    this.diagnostics = options.diagnostics;
  }
}
