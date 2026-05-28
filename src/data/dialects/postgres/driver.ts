import { QueryError } from "../../errors";
import type { CompiledQuery, Driver, QueryResult } from "../../types";

export interface PostgresQueryResult<Row = unknown> {
  readonly rows?: readonly Row[];
  readonly rowCount?: number | null;
}

export interface PostgresClientLike {
  query<Row = unknown>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<PostgresQueryResult<Row>> | PostgresQueryResult<Row>;
  end?(): Promise<void> | void;
}

export interface PostgresDriverOptions {
  readonly client: PostgresClientLike;
  readonly closeOnShutdown?: boolean;
}

export function createPostgresDriver(options: PostgresDriverOptions): Driver {
  return {
    name: "postgresql",
    async execute<Row = unknown>(query: CompiledQuery): Promise<QueryResult<Row>> {
      try {
        const result = await options.client.query<Row>(query.sql, query.params);
        return {
          rows: result.rows ?? [],
          numAffectedRows: BigInt(result.rowCount ?? result.rows?.length ?? 0),
        };
      } catch (cause) {
        throw new QueryError("PostgreSQL query failed", {
          cause,
          sql: query.sql,
          params: query.params,
          dialect: "postgresql",
        });
      }
    },
    async ping(): Promise<void> {
      await options.client.query("select 1", []);
    },
    async shutdown(): Promise<void> {
      if (options.closeOnShutdown === false) return;
      await options.client.end?.();
    },
  };
}
