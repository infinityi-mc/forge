import type { InsertNode } from "./ast";
import { compileNode } from "./compile";
import { ExecutableQuery } from "./executor";
import type {
  ColumnName,
  Db,
  Dialect,
  Insertable,
  InsertQueryBuilder,
  PickSelected,
  RawQueryBuilder,
  Selectable,
} from "../types";

export class InsertBuilder<Row extends Record<string, unknown>>
  extends ExecutableQuery<Selectable<Row>>
  implements InsertQueryBuilder<Row>
{
  constructor(
    db: Pick<Db<Record<string, Record<string, unknown>>>, "execute">,
    private readonly dialect: Dialect,
    private readonly node: InsertNode,
  ) {
    super(db, () => compileNode(dialect, node));
  }

  values(value: Insertable<Row> | readonly Insertable<Row>[]): InsertQueryBuilder<Row> {
    const rows = Array.isArray(value) ? value : [value];
    return new InsertBuilder<Row>(this.db, this.dialect, {
      ...this.node,
      values: rows as readonly Record<string, unknown>[],
    });
  }

  returning<Columns extends readonly ColumnName<Row>[]>(
    columns: Columns,
  ): RawQueryBuilder<PickSelected<Row, Columns>> {
    return new ExecutableQuery<PickSelected<Row, Columns>>(this.db, () =>
      compileNode(this.dialect, { ...this.node, returning: columns }),
    );
  }

  returningAll(): RawQueryBuilder<Selectable<Row>> {
    return new ExecutableQuery<Selectable<Row>>(this.db, () =>
      compileNode(this.dialect, { ...this.node, returning: "*" }),
    );
  }
}

export function createInsertBuilder<Row extends Record<string, unknown>>(
  db: Pick<Db<Record<string, Record<string, unknown>>>, "execute">,
  dialect: Dialect,
  table: string,
): InsertQueryBuilder<Row> {
  return new InsertBuilder<Row>(db, dialect, {
    kind: "insert",
    table,
    values: [],
  });
}
