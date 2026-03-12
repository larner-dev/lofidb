import snakeCase from "just-snake-case";
import {
  FilterClause,
  FilterOperation,
  Filters,
  FilterValue,
  FilterValueType,
  DynamicFilterValue,
  ScalarJSValue,
} from "./types";

/**
 * FilterEngine owns all filter evaluation logic — both in-memory matching
 * and SQL WHERE clause generation. Keeping both in one place ensures they
 * never drift out of sync.
 *
 * Key design decisions:
 * - `resolveValue` is the single place dynamic values get unpacked.
 * - `normalizeForComparison` is the single place type coercion happens.
 * - Null semantics are explicit: only eq/neq work with null; ordered
 *   comparisons (gt/lt/gte/lte) return false if either side is null.
 */
export class FilterEngine {
  // ──────────────────────────────────────────────
  // Value resolution (shared by SQL + memory paths)
  // ──────────────────────────────────────────────

  /** Resolve a FilterValue to its concrete scalar. Used by both paths. */
  resolveValue(filterValue: FilterValue): ScalarJSValue {
    if (filterValue.type === FilterValueType.Constant) {
      return filterValue.value;
    }

    const dynamicValue = filterValue.value;
    switch (dynamicValue) {
      case DynamicFilterValue.StartOfToday: {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        return d.toISOString();
      }
      case DynamicFilterValue.EndOfToday: {
        const d = new Date();
        d.setHours(23, 59, 59, 999);
        return d.toISOString();
      }
      case DynamicFilterValue.Empty:
        return null;
    }

    throw new Error(`Unknown dynamic filter value: ${dynamicValue as string}`);
  }

  /**
   * Normalize any JS value into a comparable form.
   * Dates → ISO strings, booleans → 0/1, null/undefined → null.
   */
  normalizeForComparison(value: ScalarJSValue): string | number | null {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "boolean") return value ? 1 : 0;
    if (typeof value === "string") return value;
    if (typeof value === "number") return value;
    return String(value);
  }

  // ──────────────────────────────────────────────
  // In-memory matching
  // ──────────────────────────────────────────────

  /** Does this record match the filter? Outer array = OR, inner = AND. */
  matches(record: Record<string, unknown>, filters?: Filters): boolean {
    if (!filters?.length) return true;
    return filters.some((andGroup) => this.matchesAndGroup(record, andGroup));
  }

  matchesAndGroup(
    record: Record<string, unknown>,
    clauses: FilterClause[],
  ): boolean {
    return clauses.every((clause) => this.matchesClause(record, clause));
  }

  matchesClause(
    record: Record<string, unknown>,
    clause: FilterClause,
  ): boolean {
    const [field, op, filterValue] = clause;
    const { found, value } = this.getNestedValue(field, record);
    if (!found) return false;

    if (
      typeof value === "object" &&
      !(value instanceof Date) &&
      value !== null
    ) {
      throw new Error(`Cannot filter on non-scalar value at "${field}"`);
    }

    const lhs = this.normalizeForComparison(value as ScalarJSValue);
    const rhs = this.normalizeForComparison(this.resolveValue(filterValue));

    return this.compare(lhs, op, rhs);
  }

  /** Core comparison with explicit null semantics. */
  compare(
    lhs: string | number | null,
    op: FilterOperation,
    rhs: string | number | null,
  ): boolean {
    if (lhs === null || rhs === null) {
      if (op === FilterOperation.eq) return lhs === rhs;
      if (op === FilterOperation.neq) return lhs !== rhs;
      return false; // ordered comparisons with null → false
    }

    switch (op) {
      case FilterOperation.eq:
        return lhs === rhs;
      case FilterOperation.neq:
        return lhs !== rhs;
      case FilterOperation.gt:
        return lhs > rhs;
      case FilterOperation.gte:
        return lhs >= rhs;
      case FilterOperation.lt:
        return lhs < rhs;
      case FilterOperation.lte:
        return lhs <= rhs;
      default:
        return false;
    }
  }

  /** Traverse dot-notation paths like "activity.name". */
  getNestedValue(
    field: string,
    record: Record<string, unknown>,
  ): { found: boolean; value: ScalarJSValue } {
    const parts = field.split(".");
    let current: unknown = record;

    for (const part of parts) {
      if (
        current === null ||
        current === undefined ||
        typeof current !== "object"
      ) {
        return { found: false, value: undefined };
      }
      if (!(part in (current as Record<string, unknown>))) {
        return { found: false, value: undefined };
      }
      current = (current as Record<string, unknown>)[part];
    }

    return { found: true, value: current as ScalarJSValue };
  }

  // ──────────────────────────────────────────────
  // SQL generation
  // ──────────────────────────────────────────────

  /** Generate a WHERE clause (without the "WHERE" keyword). */
  toSql(filters?: Filters): { sql: string; values: ScalarJSValue[] } {
    if (!filters?.length) return { sql: "", values: [] };

    const orParts: string[] = [];
    const allValues: ScalarJSValue[] = [];

    for (const andGroup of filters) {
      const andParts: string[] = [];
      for (const clause of andGroup) {
        const { sql, values } = this.clauseToSql(clause);
        andParts.push(sql);
        allValues.push(...values);
      }
      orParts.push(
        andParts.length === 1 ? andParts[0] : `(${andParts.join(" AND ")})`,
      );
    }

    const sql =
      orParts.length === 1 ? orParts[0] : `(${orParts.join(" OR ")})`;
    return { sql, values: allValues };
  }

  clauseToSql(clause: FilterClause): { sql: string; values: ScalarJSValue[] } {
    const [field, op, filterValue] = clause;
    const column = `"${snakeCase(field)}"`;
    const resolved = this.resolveValue(filterValue);
    const sqlValue = this.toSqlValue(resolved);

    if (resolved === null || resolved === undefined) {
      if (op === FilterOperation.eq) {
        return { sql: `${column} IS NULL`, values: [] };
      }
      if (op === FilterOperation.neq) {
        return { sql: `${column} IS NOT NULL`, values: [] };
      }
      return { sql: `${column} ${this.opToSql(op)} NULL`, values: [] };
    }

    return { sql: `${column} ${this.opToSql(op)} ?`, values: [sqlValue] };
  }

  private opToSql(op: FilterOperation): string {
    switch (op) {
      case FilterOperation.eq:
        return "=";
      case FilterOperation.neq:
        return "!=";
      case FilterOperation.gt:
        return ">";
      case FilterOperation.gte:
        return ">=";
      case FilterOperation.lt:
        return "<";
      case FilterOperation.lte:
        return "<=";
    }
  }

  /** Convert a JS value to a SQLite-compatible value. */
  toSqlValue(value: ScalarJSValue | Record<string, unknown> | unknown[]): string | number | null {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "boolean") return value ? 1 : 0;
    if (typeof value === "object") return JSON.stringify(value);
    return value;
  }

  // ──────────────────────────────────────────────
  // Dynamic value detection
  // ──────────────────────────────────────────────

  getDynamicValues(filters?: Filters): DynamicFilterValue[] {
    if (!filters) return [];
    const values: DynamicFilterValue[] = [];
    for (const group of filters) {
      for (const [, , filterValue] of group) {
        if (filterValue.type === FilterValueType.Dynamic) {
          values.push(filterValue.value);
        }
      }
    }
    return values;
  }

  hasDailyDynamicValues(filters?: Filters): boolean {
    return this.getDynamicValues(filters).some((v) =>
      [DynamicFilterValue.StartOfToday, DynamicFilterValue.EndOfToday].includes(
        v,
      ),
    );
  }
}
