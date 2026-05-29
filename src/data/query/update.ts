import type { UpdateNode } from "./ast";
import { compileNode } from "./compile";
import { ExecutableQuery } from "./executor";
import type {
  ColumnName,
  ComparisonOperator,
  Db,
  Dialect,
  PickSelected,
  RawQueryBuilder,
  SelectType,
  Selectable,
  Updateable,
  UpdateQueryBuilder,
} from "../types";
import type { TenantContext } from "./select";

export class UpdateBuilder<Row extends Record<string, unknown>>
  extends ExecutableQuery<{ numUpdatedRows: bigint }>
  implements UpdateQueryBuilder<Row>
{
  constructor(
    db: Pick<Db<Record<string, Record<string, unknown>>>, "execute">,
    private readonly dialect: Dialect,
    private readonly node: UpdateNode,
  ) {
    super(db, () => compileNode(dialect, node));
  }

  set(value: Updateable<Row>): UpdateQueryBuilder<Row> {
    return new UpdateBuilder<Row>(this.db, this.dialect, {
      ...this.node,
      set: { ...this.node.set, ...(value as Record<string, unknown>) },
    });
  }

  where<Column extends ColumnName<Row>>(
    column: Column,
    operator: ComparisonOperator,
    value: SelectType<Row[Column]>,
  ): UpdateQueryBuilder<Row> {
    return new UpdateBuilder<Row>(this.db, this.dialect, {
      ...this.node,
      where: [...this.node.where, { column, operator, value }],
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

export function createUpdateBuilder<Row extends Record<string, unknown>>(
  db: Pick<Db<Record<string, Record<string, unknown>>>, "execute">,
  dialect: Dialect,
  table: string,
  tenant?: TenantContext,
): UpdateQueryBuilder<Row> {
  return new UpdateBuilder<Row>(db, dialect, {
    kind: "update",
    table,
    set: {},
    where: tenant === undefined ? [] : [{ column: tenant.column, operator: "=", value: tenant.id }],
  });
}
