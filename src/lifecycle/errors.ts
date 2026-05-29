/**
 * Typed error taxonomy for `forge/lifecycle`.
 *
 * Every error the module throws is a subclass of {@link LifecycleError}, so
 * consumers can branch with a single `instanceof LifecycleError` check or
 * narrow to a specific category. Mirrors the per-module base-class pattern of
 * `DataError`, `ResilienceError`, `MessagingError`, etc.
 *
 * @module
 */

/**
 * Base class for every error thrown by `forge/lifecycle`. Use this when no more
 * specific category fits, or when an `instanceof LifecycleError` check should
 * catch the whole family.
 */
export class LifecycleError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LifecycleError";
  }
}

/**
 * A component's `start()` rejected (or timed out) during {@link boot}. Boot is
 * aborted and the already-started components are rolled back in reverse before
 * this is thrown. Carries the offending component's name and the underlying
 * `cause`.
 */
export class StartupError extends LifecycleError {
  /** Name of the component whose `start()` failed. */
  readonly component: string;

  constructor(
    message: string,
    options: ErrorOptions & { component: string },
  ) {
    super(message, options);
    this.name = "StartupError";
    this.component = options.component;
  }
}

/**
 * One or more components' `stop()` failed during graceful shutdown. The
 * shutdown still completed (one bad component does not block the others); this
 * is recorded and surfaced rather than thrown to the `stop()` caller.
 */
export class ShutdownError extends LifecycleError {
  /** Name of the component whose `stop()` failed, when a single one is known. */
  readonly component?: string;

  constructor(
    message: string,
    options?: ErrorOptions & { component?: string },
  ) {
    super(message, options);
    this.name = "ShutdownError";
    if (options?.component !== undefined) {
      this.component = options.component;
    }
  }
}

/**
 * A component exceeded its allotted stop slice and was abandoned so shutdown
 * could proceed within the global budget.
 */
export class ShutdownTimeoutError extends LifecycleError {
  /** Name of the component that overran its slice. */
  readonly component: string;
  /** The slice, in milliseconds, the component was given. */
  readonly timeoutMs: number;

  constructor(
    message: string,
    options: ErrorOptions & { component: string; timeoutMs: number },
  ) {
    super(message, options);
    this.name = "ShutdownTimeoutError";
    this.component = options.component;
    this.timeoutMs = options.timeoutMs;
  }
}

/** A component's `healthcheck()` threw. */
export class HealthCheckError extends LifecycleError {
  /** Name of the component whose `healthcheck()` threw, when known. */
  readonly component?: string;

  constructor(
    message: string,
    options?: ErrorOptions & { component?: string },
  ) {
    super(message, options);
    this.name = "HealthCheckError";
    if (options?.component !== undefined) {
      this.component = options.component;
    }
  }
}

/** A component is invalid (e.g. blank name) or a name is registered twice. */
export class ComponentRegistrationError extends LifecycleError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ComponentRegistrationError";
  }
}
