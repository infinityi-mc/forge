/**
 * Typed error taxonomy for `forge/data`.
 *
 * Every module-owned failure subclasses {@link DataError}; callers can
 * catch the whole family or narrow to query/pool/transaction/migration
 * categories.
 *
 * @module
 */

export class DataError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DataError";
  }
}

export class QueryError extends DataError {
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly dialect: string;

  constructor(
    message: string,
    options: ErrorOptions & {
      sql: string;
      params: readonly unknown[];
      dialect: string;
    },
  ) {
    super(message, options);
    this.name = "QueryError";
    this.sql = options.sql;
    this.params = options.params;
    this.dialect = options.dialect;
  }
}

export class PoolError extends DataError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PoolError";
  }
}

export class TransactionError extends DataError {
  readonly state?: string;

  constructor(message: string, options?: ErrorOptions & { state?: string }) {
    super(message, options);
    this.name = "TransactionError";
    if (options?.state !== undefined) this.state = options.state;
  }
}

export class MigrationError extends DataError {
  readonly version?: string;
  readonly migrationName?: string;

  constructor(
    message: string,
    options?: ErrorOptions & { version?: string; migrationName?: string },
  ) {
    super(message, options);
    this.name = "MigrationError";
    if (options?.version !== undefined) this.version = options.version;
    if (options?.migrationName !== undefined) this.migrationName = options.migrationName;
  }
}

export class ConcurrencyError extends DataError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConcurrencyError";
  }
}

export class TenantError extends DataError {
  readonly tenantId?: string;

  constructor(message: string, options?: ErrorOptions & { tenantId?: string }) {
    super(message, options);
    this.name = "TenantError";
    if (options?.tenantId !== undefined) this.tenantId = options.tenantId;
  }
}
