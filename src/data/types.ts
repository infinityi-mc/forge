/**
 * Core public types for `forge/data`.
 *
 * The module is database-first: consumers provide a generated
 * `DatabaseSchema` where each key is a table name and each value is a
 * row shape. `ColumnType` lets generated types distinguish selected,
 * inserted, and updated values for generated/defaulted columns.
 *
 * @module
 */

export interface ColumnType<
  Select,
  Insert = Select,
  Update = Insert,
> {
  readonly __forgeColumnType?: {
    readonly select: Select;
    readonly insert: Insert;
    readonly update: Update;
  };
}

export type DatabaseSchema = object;

export type TableRow<
  Schema extends DatabaseSchema,
  Table extends TableName<Schema>,
> = Schema[Table] extends Record<string, unknown> ? Schema[Table] : never;

export type SelectType<T> =
  T extends ColumnType<infer Select, unknown, unknown> ? Select : T;

export type InsertType<T> =
  T extends ColumnType<unknown, infer Insert, unknown> ? Insert : T;

export type UpdateType<T> =
  T extends ColumnType<unknown, unknown, infer Update> ? Update : T;

export type Selectable<Row extends Record<string, unknown>> = {
  readonly [K in keyof Row]: SelectType<Row[K]>;
};

export type Insertable<Row extends Record<string, unknown>> = {
  readonly [K in keyof Row]?: InsertType<Row[K]>;
};

export type Updateable<Row extends Record<string, unknown>> = {
  readonly [K in keyof Row]?: UpdateType<Row[K]>;
};

export type TableName<Schema extends DatabaseSchema> = Extract<keyof Schema, string>;

export type ColumnName<Row extends Record<string, unknown>> = Extract<keyof Row, string>;

export type PickSelected<
  Row extends Record<string, unknown>,
  Columns extends readonly ColumnName<Row>[],
> = Pick<Selectable<Row>, Columns[number]>;

export interface CompiledQuery {
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly kind: QueryKind;
  readonly returning: boolean;
}

export type QueryKind = "select" | "insert" | "update" | "delete" | "raw";

export interface QueryResult<Row = unknown> {
  readonly rows: readonly Row[];
  readonly numAffectedRows: bigint;
}

export interface Driver {
  readonly name: string;
  execute<Row = unknown>(query: CompiledQuery): Promise<QueryResult<Row>> | QueryResult<Row>;
  ping?(): Promise<void> | void;
  shutdown?(): Promise<void> | void;
}

export interface Dialect {
  readonly name: string;
  placeholder(index: number): string;
  quoteIdentifier(identifier: string): string;
}

export interface CreateDbOptions {
  readonly dialect: Dialect;
  readonly driver: Driver;
  readonly telemetry?: DataTelemetryOptions;
  readonly outbox?: OutboxConfig;
}

export type IsolationLevel = "read committed" | "repeatable read" | "serializable";

export interface UowOptions {
  readonly isolationLevel?: IsolationLevel;
  readonly retries?: number;
  readonly shouldRetry?: (error: unknown, attempt: number) => boolean | Promise<boolean>;
}

export interface TenantOptions {
  readonly column?: string;
  readonly allowRaw?: boolean;
}

export interface OutboxConfig {
  readonly table?: string;
  readonly publisher?: OutboxPublisher;
}

export interface OutboxMessage {
  readonly type: string;
  readonly payload: unknown;
  readonly metadata?: Record<string, unknown>;
  readonly occurredAt?: Date;
}

export interface OutboxPublisher {
  publish(message: Required<OutboxMessage>, tx: Db<DatabaseSchema>): Promise<void> | void;
}

export interface TransactionOutbox {
  publish(
    type: string,
    payload: unknown,
    options?: {
      readonly metadata?: Record<string, unknown>;
      readonly occurredAt?: Date;
    },
  ): Promise<void>;
}

export interface DataTelemetryOptions {
  readonly meter?: {
    createHistogram(
      name: string,
      options?: { description?: string; unit?: string; boundaries?: readonly number[] },
    ): { record(value: number, attributes?: Record<string, string | number | boolean>): void };
    createGauge?(
      name: string,
      options?: { description?: string; unit?: string },
    ): { record(value: number, attributes?: Record<string, string | number | boolean>): void };
  };
  readonly tracer?: {
    startSpan(
      name: string,
      options?: {
        kind?: "internal" | "server" | "client" | "producer" | "consumer";
        attributes?: Record<string, string | number | boolean | undefined>;
      },
    ): {
      setAttribute(key: string, value: string | number | boolean): unknown;
      setAttributes(attributes: Record<string, string | number | boolean | undefined>): unknown;
      setStatus(status: { code: "unset" | "ok" | "error"; message?: string }): unknown;
      addEvent(name: string, attributes?: Record<string, string | number | boolean | undefined>): unknown;
      end(endTime?: Date): void;
    };
  };
  readonly includeParams?: boolean;
}

export interface RawQueryBuilder<Row> {
  execute(): Promise<QueryResult<Row>>;
  executeTakeFirst(): Promise<Row | undefined>;
  executeTakeFirstOrThrow(): Promise<Row>;
  compile(): CompiledQuery;
}

export interface SelectQueryBuilder<Row extends Record<string, unknown>, Output> extends RawQueryBuilder<Output> {
  select<Columns extends readonly ColumnName<Row>[]>(
    columns: Columns,
  ): SelectQueryBuilder<Row, PickSelected<Row, Columns>>;
  where<Column extends ColumnName<Row>>(
    column: Column,
    operator: ComparisonOperator,
    value: SelectType<Row[Column]>,
  ): SelectQueryBuilder<Row, Output>;
  orderBy<Column extends ColumnName<Row>>(
    column: Column,
    direction?: "asc" | "desc",
  ): SelectQueryBuilder<Row, Output>;
  limit(count: number): SelectQueryBuilder<Row, Output>;
}

export interface InsertQueryBuilder<Row extends Record<string, unknown>> extends RawQueryBuilder<Selectable<Row>> {
  values(value: Insertable<Row> | readonly Insertable<Row>[]): InsertQueryBuilder<Row>;
  returning<Columns extends readonly ColumnName<Row>[]>(
    columns: Columns,
  ): RawQueryBuilder<PickSelected<Row, Columns>>;
  returningAll(): RawQueryBuilder<Selectable<Row>>;
}

export interface UpdateQueryBuilder<Row extends Record<string, unknown>> extends RawQueryBuilder<{ numUpdatedRows: bigint }> {
  set(value: Updateable<Row>): UpdateQueryBuilder<Row>;
  where<Column extends ColumnName<Row>>(
    column: Column,
    operator: ComparisonOperator,
    value: SelectType<Row[Column]>,
  ): UpdateQueryBuilder<Row>;
  returning<Columns extends readonly ColumnName<Row>[]>(
    columns: Columns,
  ): RawQueryBuilder<PickSelected<Row, Columns>>;
  returningAll(): RawQueryBuilder<Selectable<Row>>;
}

export interface DeleteQueryBuilder<Row extends Record<string, unknown>> extends RawQueryBuilder<{ numDeletedRows: bigint }> {
  where<Column extends ColumnName<Row>>(
    column: Column,
    operator: ComparisonOperator,
    value: SelectType<Row[Column]>,
  ): DeleteQueryBuilder<Row>;
  returning<Columns extends readonly ColumnName<Row>[]>(
    columns: Columns,
  ): RawQueryBuilder<PickSelected<Row, Columns>>;
  returningAll(): RawQueryBuilder<Selectable<Row>>;
}

export type ComparisonOperator =
  | "="
  | "!="
  | "<>"
  | ">"
  | ">="
  | "<"
  | "<="
  | "like"
  | "not like";

export interface Db<Schema extends DatabaseSchema> {
  readonly dialect: Dialect;
  selectFrom<Table extends TableName<Schema>>(
    table: Table,
  ): SelectQueryBuilder<TableRow<Schema, Table>, Selectable<TableRow<Schema, Table>>>;
  insertInto<Table extends TableName<Schema>>(
    table: Table,
  ): InsertQueryBuilder<TableRow<Schema, Table>>;
  updateTable<Table extends TableName<Schema>>(
    table: Table,
  ): UpdateQueryBuilder<TableRow<Schema, Table>>;
  deleteFrom<Table extends TableName<Schema>>(
    table: Table,
  ): DeleteQueryBuilder<TableRow<Schema, Table>>;
  raw<Row = unknown>(query: { readonly text: string; readonly params: readonly unknown[] }): RawQueryBuilder<Row>;
  execute<Row = unknown>(query: CompiledQuery): Promise<QueryResult<Row>>;
  uow<T>(
    fn: (tx: TransactionDb<Schema>) => Promise<T> | T,
    options?: UowOptions,
  ): Promise<T>;
  withTenant(tenantId: string, options?: TenantOptions): Db<Schema>;
  ping(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface TransactionDb<Schema extends DatabaseSchema> extends Db<Schema> {
  readonly outbox: TransactionOutbox;
}
