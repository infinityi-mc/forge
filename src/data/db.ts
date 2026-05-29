import { QueryError, TenantError, TransactionError } from "./errors";
import { createDataInstrumentation } from "./telemetry/instrumentation";
import { compileRaw } from "./query/compile";
import { createDeleteBuilder } from "./query/delete";
import { ExecutableQuery } from "./query/executor";
import { createInsertBuilder } from "./query/insert";
import type { TenantContext } from "./query/select";
import { createSelectBuilder } from "./query/select";
import { createUpdateBuilder } from "./query/update";
import { raw as rawSql, sql } from "./sql";
import type {
  CompiledQuery,
  CreateDbOptions,
  DatabaseSchema,
  Db,
  DeleteQueryBuilder,
  InsertQueryBuilder,
  QueryResult,
  RawQueryBuilder,
  SelectQueryBuilder,
  Selectable,
  TableRow,
  TableName,
  TenantOptions,
  TransactionDb,
  UowOptions,
  UpdateQueryBuilder,
} from "./types";
import type { SqlFragment } from "./sql";

export function createDb<Schema extends DatabaseSchema>(
  options: CreateDbOptions,
): Db<Schema> {
  const instrumentation = createDataInstrumentation({
    dialect: options.dialect.name,
    telemetry: options.telemetry,
  });

  const executeQuery = async <Row = unknown>(query: CompiledQuery): Promise<QueryResult<Row>> => {
    const span = instrumentation.startQuerySpan(query);
    const startedAt = performance.now();
    try {
      const result = await options.driver.execute<Row>(query);
      const normalized = normalizeResult<Row>(query, result);
      instrumentation.recordQuerySuccess(query, normalized, startedAt, span);
      return normalized;
    } catch (cause) {
      instrumentation.recordQueryFailure(query, cause, startedAt, span);
      if (cause instanceof QueryError) throw cause;
      throw new QueryError("Data query failed", {
        cause,
        sql: query.sql,
        params: query.params,
        dialect: options.dialect.name,
      });
    }
  };

  const createHandle = (
    tenant?: TenantContext,
    transaction?: TransactionState,
  ): Db<Schema> | TransactionDb<Schema> => {
    const handle: Db<Schema> & Partial<TransactionDb<Schema>> = {
      dialect: options.dialect,

      selectFrom<Table extends TableName<Schema>>(
        table: Table,
      ): SelectQueryBuilder<TableRow<Schema, Table>, Selectable<TableRow<Schema, Table>>> {
        return createSelectBuilder<TableRow<Schema, Table>>(handleAny, options.dialect, table, tenant);
      },

      insertInto<Table extends TableName<Schema>>(
        table: Table,
      ): InsertQueryBuilder<TableRow<Schema, Table>> {
        return createInsertBuilder<TableRow<Schema, Table>>(handleAny, options.dialect, table, tenant);
      },

      updateTable<Table extends TableName<Schema>>(
        table: Table,
      ): UpdateQueryBuilder<TableRow<Schema, Table>> {
        return createUpdateBuilder<TableRow<Schema, Table>>(handleAny, options.dialect, table, tenant);
      },

      deleteFrom<Table extends TableName<Schema>>(
        table: Table,
      ): DeleteQueryBuilder<TableRow<Schema, Table>> {
        return createDeleteBuilder<TableRow<Schema, Table>>(handleAny, options.dialect, table, tenant);
      },

      raw<Row = unknown>(query: SqlFragment): RawQueryBuilder<Row> {
        if (tenant !== undefined && !tenant.allowRaw) {
          throw new TenantError("Raw SQL is disabled on tenant-scoped database handles", {
            tenantId: tenant.id,
          });
        }
        return new ExecutableQuery<Row>(handleAny, () => compileRaw(options.dialect, query));
      },

      async execute<Row = unknown>(query: CompiledQuery): Promise<QueryResult<Row>> {
        return executeQuery<Row>(query);
      },

      async uow<T>(
        fn: (tx: TransactionDb<Schema>) => Promise<T> | T,
        uowOptions: UowOptions = {},
      ): Promise<T> {
        return runUow(fn, uowOptions, transaction, tenant);
      },

      withTenant(tenantId: string, tenantOptions: TenantOptions = {}): Db<Schema> {
        return createHandle(
          {
            id: tenantId,
            column: tenantOptions.column ?? tenant?.column ?? "tenant_id",
            allowRaw: tenantOptions.allowRaw ?? tenant?.allowRaw ?? false,
          },
          transaction,
        ) as Db<Schema>;
      },

      async ping(): Promise<void> {
        if (options.driver.ping !== undefined) {
          await options.driver.ping();
          return;
        }
        await handle.execute({ sql: "select 1", params: [], kind: "raw", returning: false });
      },

      async shutdown(): Promise<void> {
        await options.driver.shutdown?.();
      },
    };

    const handleAny = handle as unknown as Db<Record<string, Record<string, unknown>>>;
    if (transaction !== undefined) {
      Object.defineProperty(handle, "outbox", {
        enumerable: true,
        value: {
          publish(
            type: string,
            payload: unknown,
            outboxOptions: { readonly metadata?: Record<string, unknown>; readonly occurredAt?: Date } = {},
          ) {
            return publishOutbox(handle as TransactionDb<Schema>, options, {
              type,
              payload,
              metadata: outboxOptions.metadata ?? {},
              occurredAt: outboxOptions.occurredAt ?? new Date(),
            });
          },
        },
      });
    }
    return Object.freeze(handle);
  };

  const runUow = async <T>(
    fn: (tx: TransactionDb<Schema>) => Promise<T> | T,
    uowOptions: UowOptions,
    existingTransaction: TransactionState | undefined,
    tenant: TenantContext | undefined,
  ): Promise<T> => {
    if (existingTransaction !== undefined) {
      return runNestedUow(fn, uowOptions, existingTransaction, tenant);
    }

    const attempts = Math.max(0, uowOptions.retries ?? 0) + 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const transaction: TransactionState = { savepoint: 0 };
      await executeControl(beginSql(uowOptions));
      const tx = createHandle(tenant, transaction) as TransactionDb<Schema>;
      try {
        const result = await fn(tx);
        await executeControl("commit");
        return result;
      } catch (cause) {
        await rollbackQuietly();
        if (attempt < attempts && await shouldRetry(cause, attempt, uowOptions)) {
          continue;
        }
        throw cause;
      }
    }
    throw new TransactionError("Transaction retry attempts were exhausted");
  };

  const runNestedUow = async <T>(
    fn: (tx: TransactionDb<Schema>) => Promise<T> | T,
    uowOptions: UowOptions,
    transaction: TransactionState,
    tenant: TenantContext | undefined,
  ): Promise<T> => {
    const attempts = Math.max(0, uowOptions.retries ?? 0) + 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const savepoint = `forge_sp_${++transaction.savepoint}`;
      await executeControl(`savepoint ${savepoint}`);
      const tx = createHandle(tenant, transaction) as TransactionDb<Schema>;
      try {
        const result = await fn(tx);
        await executeControl(`release savepoint ${savepoint}`);
        return result;
      } catch (cause) {
        await rollbackToSavepointQuietly(savepoint);
        if (attempt < attempts && await shouldRetry(cause, attempt, uowOptions)) {
          continue;
        }
        throw cause;
      }
    }
    throw new TransactionError("Nested transaction retry attempts were exhausted");
  };

  const executeControl = (statement: string) =>
    executeQuery({ sql: statement, params: [], kind: "raw", returning: false });

  const rollbackQuietly = async (): Promise<void> => {
    try {
      await executeControl("rollback");
    } catch {
      // Keep the original transaction failure as the observable error.
    }
  };

  const rollbackToSavepointQuietly = async (savepoint: string): Promise<void> => {
    try {
      await executeControl(`rollback to savepoint ${savepoint}`);
    } catch {
      // Keep the original nested transaction failure as the observable error.
    }
  };

  return createHandle() as Db<Schema>;
}

interface TransactionState {
  savepoint: number;
}

function beginSql(options: UowOptions): string {
  if (options.isolationLevel === undefined) return "begin";
  return `begin isolation level ${options.isolationLevel}`;
}

async function shouldRetry(
  cause: unknown,
  attempt: number,
  options: UowOptions,
): Promise<boolean> {
  if (options.shouldRetry === undefined) return false;
  return options.shouldRetry(cause, attempt);
}

async function publishOutbox<Schema extends DatabaseSchema>(
  tx: TransactionDb<Schema>,
  options: CreateDbOptions,
  message: {
    readonly type: string;
    readonly payload: unknown;
    readonly metadata: Record<string, unknown>;
    readonly occurredAt: Date;
  },
): Promise<void> {
  const normalized = {
    type: message.type,
    payload: message.payload,
    metadata: message.metadata,
    occurredAt: message.occurredAt,
  };
  if (options.outbox?.publisher !== undefined) {
    await options.outbox.publisher.publish(normalized, tx);
    return;
  }

  const quote = (identifier: string) => rawSql(options.dialect.quoteIdentifier(identifier));
  await tx.execute(compileRaw(options.dialect, sql`
    insert into ${quote(options.outbox?.table ?? "_forge_outbox")}
      (${quote("type")}, ${quote("payload")}, ${quote("metadata")}, ${quote("occurred_at")})
    values (
      ${message.type},
      ${JSON.stringify(message.payload)},
      ${JSON.stringify(message.metadata)},
      ${message.occurredAt.toISOString()}
    )
  `));
}

function normalizeResult<Row>(
  query: CompiledQuery,
  result: QueryResult<Row>,
): QueryResult<Row> {
  if (result.rows.length > 0) return result;
  if (query.returning) return result;
  if (query.kind === "update") {
    return {
      rows: [{ numUpdatedRows: result.numAffectedRows } as Row],
      numAffectedRows: result.numAffectedRows,
    };
  }
  if (query.kind === "delete") {
    return {
      rows: [{ numDeletedRows: result.numAffectedRows } as Row],
      numAffectedRows: result.numAffectedRows,
    };
  }
  return result;
}
