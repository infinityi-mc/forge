import { Database } from "bun:sqlite";
import { QueryError } from "../../errors";
import type { CompiledQuery, Driver, QueryResult } from "../../types";

export interface SqliteDriverOptions {
  readonly database?: Database;
  readonly filename?: string;
  readonly create?: boolean;
}

export function createSqliteDriver(options: SqliteDriverOptions = {}): Driver {
  const database = options.database ?? new Database(options.filename ?? ":memory:", {
    create: options.create ?? true,
  });

  return {
    name: "sqlite",
    execute<Row = unknown>(query: CompiledQuery): QueryResult<Row> {
      try {
        const statement = database.query(query.sql);
        if (query.kind === "select" || rawReturnsRows(query.sql)) {
          const rows = statement.all(...toSqliteBindings(query.params)) as Row[];
          return { rows, numAffectedRows: 0n };
        }

        if (returnsRows(query.sql)) {
          const rows = statement.all(...toSqliteBindings(query.params)) as Row[];
          return { rows, numAffectedRows: BigInt(rows.length) };
        }

        const result = statement.run(...toSqliteBindings(query.params)) as { changes?: number };
        return { rows: [], numAffectedRows: BigInt(result.changes ?? 0) };
      } catch (cause) {
        throw new QueryError("SQLite query failed", {
          cause,
          sql: query.sql,
          params: query.params,
          dialect: "sqlite",
        });
      }
    },
    shutdown() {
      database.close();
    },
  };
}

function toSqliteBindings(params: readonly unknown[]): any[] {
  return [...params];
}

function returnsRows(sql: string): boolean {
  return /\breturning\b/i.test(sql);
}

function rawReturnsRows(sql: string): boolean {
  return /^\s*(select|with|pragma)\b/i.test(sql);
}
