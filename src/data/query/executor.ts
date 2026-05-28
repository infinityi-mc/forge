import { DataError } from "../errors";
import type { CompiledQuery, Db, QueryResult, RawQueryBuilder } from "../types";

export class ExecutableQuery<Row> implements RawQueryBuilder<Row> {
  constructor(
    protected readonly db: Pick<Db<Record<string, Record<string, unknown>>>, "execute">,
    private readonly compileFn: () => CompiledQuery,
  ) {}

  compile(): CompiledQuery {
    try {
      return this.compileFn();
    } catch (cause) {
      if (cause instanceof DataError) throw cause;
      throw new DataError("Failed to compile query", { cause });
    }
  }

  execute(): Promise<QueryResult<Row>> {
    return this.db.execute<Row>(this.compile());
  }

  async executeTakeFirst(): Promise<Row | undefined> {
    const result = await this.execute();
    return result.rows[0];
  }

  async executeTakeFirstOrThrow(): Promise<Row> {
    const row = await this.executeTakeFirst();
    if (row === undefined) {
      throw new DataError("Expected query to return at least one row");
    }
    return row;
  }
}
