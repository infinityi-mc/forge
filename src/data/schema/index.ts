import { raw, type SqlFragment } from "../sql";
import type { Dialect } from "../types";

export type ColumnDataType =
  | "uuid"
  | "varchar"
  | "timestamptz"
  | "integer"
  | "boolean"
  | "json"
  | "jsonb"
  | "text";

export interface ColumnOptions {
  readonly primaryKey?: boolean;
  readonly notNull?: boolean;
  readonly unique?: boolean;
  readonly default?: string;
}

interface ColumnDefinition {
  readonly name: string;
  readonly type: ColumnDataType;
  readonly options: ColumnOptions;
}

export class CreateTableBuilder {
  private readonly columns: readonly ColumnDefinition[];

  constructor(
    private readonly table: string,
    columns: readonly ColumnDefinition[] = [],
  ) {
    this.columns = columns;
  }

  column(name: string, type: ColumnDataType, options: ColumnOptions = {}): CreateTableBuilder {
    return new CreateTableBuilder(this.table, [...this.columns, { name, type, options }]);
  }

  compile(dialect: Dialect): SqlFragment {
    if (this.columns.length === 0) {
      throw new Error("createTable requires at least one column");
    }

    const columns = this.columns
      .map((column) => compileColumn(dialect, column))
      .join(", ");
    return raw(`create table ${dialect.quoteIdentifier(this.table)} (${columns})`);
  }
}

export class DropTableBuilder {
  constructor(
    private readonly table: string,
    private readonly ifExists: boolean = false,
  ) {}

  ifExistsOption(): DropTableBuilder {
    return new DropTableBuilder(this.table, true);
  }

  compile(dialect: Dialect): SqlFragment {
    const guard = this.ifExists ? " if exists" : "";
    return raw(`drop table${guard} ${dialect.quoteIdentifier(this.table)}`);
  }
}

export class AlterTableBuilder {
  private readonly additions: readonly ColumnDefinition[];

  constructor(
    private readonly table: string,
    additions: readonly ColumnDefinition[] = [],
  ) {
    this.additions = additions;
  }

  addColumn(name: string, type: ColumnDataType, options: ColumnOptions = {}): AlterTableBuilder {
    return new AlterTableBuilder(this.table, [...this.additions, { name, type, options }]);
  }

  compile(dialect: Dialect): SqlFragment {
    if (this.additions.length === 0) {
      throw new Error("alterTable requires at least one operation");
    }
    if (this.additions.length > 1) {
      throw new Error("alterTable currently compiles one add column operation at a time");
    }
    const column = this.additions[0]!;
    return raw(
      `alter table ${dialect.quoteIdentifier(this.table)} add column ${compileColumn(dialect, column)}`,
    );
  }
}

export function createTable(table: string): CreateTableBuilder {
  return new CreateTableBuilder(table);
}

export function dropTable(table: string): DropTableBuilder {
  return new DropTableBuilder(table);
}

export function alterTable(table: string): AlterTableBuilder {
  return new AlterTableBuilder(table);
}

function compileColumn(dialect: Dialect, column: ColumnDefinition): string {
  const parts = [
    dialect.quoteIdentifier(column.name),
    compileDataType(dialect, column.type),
  ];
  if (column.options.primaryKey === true) parts.push("primary key");
  if (column.options.notNull === true) parts.push("not null");
  if (column.options.unique === true) parts.push("unique");
  if (column.options.default !== undefined) parts.push(`default ${column.options.default}`);
  return parts.join(" ");
}

function compileDataType(dialect: Dialect, type: ColumnDataType): string {
  if (dialect.name === "sqlite") {
    switch (type) {
      case "uuid":
      case "varchar":
      case "timestamptz":
      case "json":
      case "jsonb":
      case "text":
        return "text";
      case "integer":
        return "integer";
      case "boolean":
        return "integer";
    }
  }

  switch (type) {
    case "varchar":
      return "varchar";
    case "timestamptz":
      return "timestamptz";
    default:
      return type;
  }
}
