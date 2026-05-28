import type { CompiledQuery, DataTelemetryOptions, QueryResult } from "../types";

interface DataInstrumentationOptions {
  readonly dialect: string;
  readonly telemetry?: DataTelemetryOptions;
}

type DataSpan = NonNullable<DataTelemetryOptions["tracer"]> extends {
  startSpan(name: string, options?: unknown): infer Span;
}
  ? Span
  : never;

export function createDataInstrumentation(options: DataInstrumentationOptions) {
  const histogram = options.telemetry?.meter?.createHistogram(
    "forge_db_query_duration_seconds",
    {
      description: "Database query execution time.",
      unit: "s",
    },
  );

  return {
    startQuerySpan(query: CompiledQuery): DataSpan | undefined {
      return options.telemetry?.tracer?.startSpan("db.query", {
        kind: "client",
        attributes: queryAttributes(options, query),
      }) as DataSpan | undefined;
    },

    recordQuerySuccess(
      query: CompiledQuery,
      result: QueryResult<unknown>,
      startedAt: number,
      span: DataSpan | undefined,
    ): void {
      const durationSeconds = (performance.now() - startedAt) / 1000;
      histogram?.record(durationSeconds, {
        "db.system": options.dialect,
        "db.operation": query.kind,
      });
      span?.setAttributes?.({
        "db.rows_affected": Number(result.numAffectedRows),
        "db.duration_ms": durationSeconds * 1000,
      });
      span?.setStatus?.({ code: "ok" });
      span?.end?.();
    },

    recordQueryFailure(
      query: CompiledQuery,
      cause: unknown,
      startedAt: number,
      span: DataSpan | undefined,
    ): void {
      const durationSeconds = (performance.now() - startedAt) / 1000;
      histogram?.record(durationSeconds, {
        "db.system": options.dialect,
        "db.operation": query.kind,
      });
      span?.setAttributes?.({ "db.duration_ms": durationSeconds * 1000 });
      span?.setStatus?.({
        code: "error",
        message: cause instanceof Error ? cause.message : String(cause),
      });
      span?.addEvent?.("exception", {
        "exception.message": cause instanceof Error ? cause.message : String(cause),
        "exception.type": cause instanceof Error ? cause.name : typeof cause,
      });
      span?.end?.();
    },
  };
}

function queryAttributes(
  options: DataInstrumentationOptions,
  query: CompiledQuery,
): Record<string, string | number | boolean | undefined> {
  const attributes: Record<string, string | number | boolean | undefined> = {
    "db.system": options.dialect,
    "db.operation": query.kind,
    "db.statement": query.sql,
  };

  if (options.telemetry?.includeParams === true) {
    attributes["db.params"] = JSON.stringify(query.params);
  }

  return attributes;
}
