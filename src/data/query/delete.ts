import type { DeleteNode } from "./ast";
import { compileNode } from "./compile";
import { ExecutableQuery } from "./executor";
import type {
  ColumnName,
  ComparisonOperator,
  Db,
  DeleteQueryBuilder,
  Dialect,
  PickSelected,
  RawQueryBuilder,
  SelectType,
  Selectable,
} from "../types";

export class DeleteBuilder<Row extends Record<string, unknown>>
  extends ExecutableQuery<{ numDeletedRows: bigint }>
  implements DeleteQueryBuilder<Row>
{
  constructor(
    db: Pick<Db<Record<string, Record<string, unknown>>>, "execute">,
    private readonly dialect: Dialect,
    private readonly node: DeleteNode,
  ) {
    super(db, () => compileNode(dialect, node));
  }

  where<Column extends ColumnName<Row>>(
    column: Column,
    operator: ComparisonOperator,
    value: SelectType<Row[Column]>,
  ): DeleteQueryBuilder<Row> {
    return new DeleteBuilder<Row>(this.db, this.dialect, {
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

export function createDeleteBuilder<Row extends Record<string, unknown>>(
  db: Pick<Db<Record<string, Record<string, unknown>>>, "execute">,
  dialect: Dialect,
  table: string,
): DeleteQueryBuilder<Row> {
  return new DeleteBuilder<Row>(db, dialect, {
    kind: "delete",
    table,
    where: [],
  });
}
