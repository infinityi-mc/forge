import { QueryError } from "./errors";
import { compileRaw } from "./query/compile";
import { createDeleteBuilder } from "./query/delete";
import { ExecutableQuery } from "./query/executor";
import { createInsertBuilder } from "./query/insert";
import { createSelectBuilder } from "./query/select";
import { createUpdateBuilder } from "./query/update";
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
  UpdateQueryBuilder,
} from "./types";
import type { SqlFragment } from "./sql";

export function createDb<Schema extends DatabaseSchema>(
  options: CreateDbOptions,
): Db<Schema> {
  const handle: Db<Schema> = {
    dialect: options.dialect,

    selectFrom<Table extends TableName<Schema>>(
      table: Table,
    ): SelectQueryBuilder<TableRow<Schema, Table>, Selectable<TableRow<Schema, Table>>> {
      return createSelectBuilder<TableRow<Schema, Table>>(handleAny, options.dialect, table);
    },

    insertInto<Table extends TableName<Schema>>(
      table: Table,
    ): InsertQueryBuilder<TableRow<Schema, Table>> {
      return createInsertBuilder<TableRow<Schema, Table>>(handleAny, options.dialect, table);
    },

    updateTable<Table extends TableName<Schema>>(
      table: Table,
    ): UpdateQueryBuilder<TableRow<Schema, Table>> {
      return createUpdateBuilder<TableRow<Schema, Table>>(handleAny, options.dialect, table);
    },

    deleteFrom<Table extends TableName<Schema>>(
      table: Table,
    ): DeleteQueryBuilder<TableRow<Schema, Table>> {
      return createDeleteBuilder<TableRow<Schema, Table>>(handleAny, options.dialect, table);
    },

    raw<Row = unknown>(query: SqlFragment): RawQueryBuilder<Row> {
      return new ExecutableQuery<Row>(handleAny, () => compileRaw(query));
    },

    async execute<Row = unknown>(query: CompiledQuery): Promise<QueryResult<Row>> {
      try {
        const result = await options.driver.execute<Row>(query);
        return normalizeResult<Row>(query, result);
      } catch (cause) {
        if (cause instanceof QueryError) throw cause;
        throw new QueryError("Data query failed", {
          cause,
          sql: query.sql,
          params: query.params,
          dialect: options.dialect.name,
        });
      }
    },

    async shutdown(): Promise<void> {
      await options.driver.shutdown?.();
    },
  };

  const handleAny = handle as unknown as Db<Record<string, Record<string, unknown>>>;
  return Object.freeze(handle);
}

function normalizeResult<Row>(
  query: CompiledQuery,
  result: QueryResult<Row>,
): QueryResult<Row> {
  if (result.rows.length > 0) return result;
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
