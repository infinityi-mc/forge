import type { UpdateNode } from "./ast";
import { compileNode } from "./compile";
import { ExecutableQuery } from "./executor";
import { TenantError } from "../errors";
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
    private readonly tenant?: TenantContext,
  ) {
    super(db, () => compileNode(dialect, node));
  }

  set(value: Updateable<Row>): UpdateQueryBuilder<Row> {
    const set = validateTenantSet(value as Record<string, unknown>, this.tenant);
    return new UpdateBuilder<Row>(
      this.db,
      this.dialect,
      {
        ...this.node,
        set: { ...this.node.set, ...set },
      },
      this.tenant,
    );
  }

  where<Column extends ColumnName<Row>>(
    column: Column,
    operator: ComparisonOperator,
    value: SelectType<Row[Column]>,
  ): UpdateQueryBuilder<Row> {
    return new UpdateBuilder<Row>(
      this.db,
      this.dialect,
      {
        ...this.node,
        where: [...this.node.where, { column, operator, value }],
      },
      this.tenant,
    );
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
  return new UpdateBuilder<Row>(
    db,
    dialect,
    {
      kind: "update",
      table,
      set: {},
      where: tenant === undefined ? [] : [{ column: tenant.column, operator: "=", value: tenant.id }],
    },
    tenant,
  );
}

function validateTenantSet(
  value: Record<string, unknown>,
  tenant: TenantContext | undefined,
): Record<string, unknown> {
  if (tenant === undefined) return value;
  const current = value[tenant.column];
  if (current !== undefined && current !== tenant.id) {
    throw new TenantError("Update tenant value does not match scoped tenant", {
      tenantId: tenant.id,
    });
  }
  return value;
}
