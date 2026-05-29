import type { SelectNode } from "./ast";
import { compileNode } from "./compile";
import { ExecutableQuery } from "./executor";
import type {
  ColumnName,
  ComparisonOperator,
  Db,
  Dialect,
  PickSelected,
  SelectQueryBuilder,
  SelectType,
  Selectable,
} from "../types";

export interface TenantContext {
  readonly id: string;
  readonly column: string;
  readonly allowRaw: boolean;
}

export class SelectBuilder<Row extends Record<string, unknown>, Output>
  extends ExecutableQuery<Output>
  implements SelectQueryBuilder<Row, Output>
{
  constructor(
    db: Pick<Db<Record<string, Record<string, unknown>>>, "execute">,
    private readonly dialect: Dialect,
    private readonly node: SelectNode,
  ) {
    super(db, () => compileNode(dialect, node));
  }

  select<Columns extends readonly ColumnName<Row>[]>(
    columns: Columns,
  ): SelectQueryBuilder<Row, PickSelected<Row, Columns>> {
    return new SelectBuilder<Row, PickSelected<Row, Columns>>(
      this.db,
      this.dialect,
      { ...this.node, columns },
    );
  }

  where<Column extends ColumnName<Row>>(
    column: Column,
    operator: ComparisonOperator,
    value: SelectType<Row[Column]>,
  ): SelectQueryBuilder<Row, Output> {
    return new SelectBuilder<Row, Output>(this.db, this.dialect, {
      ...this.node,
      where: [...this.node.where, { column, operator, value }],
    });
  }

  orderBy<Column extends ColumnName<Row>>(
    column: Column,
    direction: "asc" | "desc" = "asc",
  ): SelectQueryBuilder<Row, Output> {
    return new SelectBuilder<Row, Output>(this.db, this.dialect, {
      ...this.node,
      orderBy: [...this.node.orderBy, { column, direction }],
    });
  }

  limit(count: number): SelectQueryBuilder<Row, Output> {
    return new SelectBuilder<Row, Output>(this.db, this.dialect, {
      ...this.node,
      limit: count,
    });
  }
}

export function createSelectBuilder<Row extends Record<string, unknown>>(
  db: Pick<Db<Record<string, Record<string, unknown>>>, "execute">,
  dialect: Dialect,
  table: string,
  tenant?: TenantContext,
): SelectQueryBuilder<Row, Selectable<Row>> {
  const node: SelectNode = {
    kind: "select",
    table,
    columns: "*",
    where: tenant === undefined ? [] : [{ column: tenant.column, operator: "=", value: tenant.id }],
    orderBy: [],
  };
  return new SelectBuilder<Row, Selectable<Row>>(db, dialect, node);
}
