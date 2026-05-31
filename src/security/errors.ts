/**
 * Typed error taxonomy for `forge/security`.
 *
 * @module
 */

/** Base class for every error raised by `forge/security`. */
export class SecurityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SecurityError";
  }
}

/** Authentication failed before a trusted {@link Principal} could be built. */
export class AuthenticationError extends SecurityError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AuthenticationError";
  }
}

/** A trusted principal was authenticated, but policy denied the requested action. */
export class AuthorizationError extends SecurityError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AuthorizationError";
  }
}

/** The token's `exp` claim is outside the accepted clock tolerance. */
export class TokenExpiredError extends AuthenticationError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TokenExpiredError";
  }
}

/** The token is malformed, has an invalid signature, or cannot be decoded. */
export class TokenInvalidError extends AuthenticationError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TokenInvalidError";
  }
}

/** A required token claim is missing or does not match verifier policy. */
export class TokenClaimError extends AuthenticationError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TokenClaimError";
  }
}

/** The token's signing algorithm is absent, forbidden, or mismatched. */
export class AlgorithmNotAllowedError extends AuthenticationError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AlgorithmNotAllowedError";
  }
}

/** Verification key lookup or JWKS refresh failed. */
export class KeyResolutionError extends SecurityError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "KeyResolutionError";
  }
}

/** An {@link AuditSink} failed to record a security event. */
export class AuditError extends SecurityError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AuditError";
  }
}
