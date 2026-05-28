/**
 * `forge/data` - explicit, type-oriented SQL without ORM magic.
 *
 * The module embraces SQL as the source of truth: generated database
 * types feed the query builder, queries compile to parameterized SQL,
 * and execution happens through explicit database handles.
 *
 * @module
 */

export { createDb } from "./db";
export { createPool } from "./pool";
export { raw, sql } from "./sql";
export type { SqlFragment } from "./sql";

export {
  ConcurrencyError,
  DataError,
  MigrationError,
  PoolError,
  QueryError,
  TenantError,
  TransactionError,
} from "./errors";

export type {
  ColumnName,
  ColumnType,
  ComparisonOperator,
  CompiledQuery,
  CreateDbOptions,
  DataTelemetryOptions,
  DatabaseSchema,
  Db,
  DeleteQueryBuilder,
  Dialect,
  Driver,
  Insertable,
  InsertQueryBuilder,
  PickSelected,
  QueryKind,
  QueryResult,
  RawQueryBuilder,
  Selectable,
  SelectQueryBuilder,
  SelectType,
  TableName,
  TableRow,
  Updateable,
  UpdateQueryBuilder,
  UpdateType,
} from "./types";
export type {
  Pool,
  PoolLease,
  PoolOptions,
  PoolResource,
  PoolStats,
} from "./pool";
