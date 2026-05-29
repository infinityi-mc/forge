import type { CompiledQuery, Driver, QueryResult } from "../types";

export interface RecordingDriver extends Driver {
  readonly queries: readonly CompiledQuery[];
  readonly results: QueryResult[];
  readonly failures: Error[];
}

export function recordingDriver(options: {
  readonly results?: readonly QueryResult[];
  readonly failures?: readonly Error[];
} = {}): RecordingDriver {
  const queries: CompiledQuery[] = [];
  const results = [...(options.results ?? [])];
  const failures = [...(options.failures ?? [])];

  return {
    name: "recording",
    queries,
    results,
    failures,
    execute<Row = unknown>(query: CompiledQuery): QueryResult<Row> {
      queries.push(query);
      const failure = failures.shift();
      if (failure !== undefined) throw failure;
      return (results.shift() ?? { rows: [], numAffectedRows: 0n }) as QueryResult<Row>;
    },
  };
}
