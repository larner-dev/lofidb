import {
  DynamicFilterValue,
  FilterClause,
  FilterOperation,
  Filters,
  FilterValue,
  FilterValueType,
  OrderDirection,
  ScalarJSValue,
} from "./types";

// ──────────────────────────────────────────────
// Dynamic value tokens
// ──────────────────────────────────────────────

export const $startOfToday = Symbol.for("lofidb.startOfToday");
export const $endOfToday = Symbol.for("lofidb.endOfToday");
export const $empty = Symbol.for("lofidb.empty");

export type DynamicToken =
  | typeof $startOfToday
  | typeof $endOfToday
  | typeof $empty;

const DYNAMIC_TOKEN_MAP: Record<symbol, DynamicFilterValue> = {
  [Symbol.for("lofidb.startOfToday")]: DynamicFilterValue.StartOfToday,
  [Symbol.for("lofidb.endOfToday")]: DynamicFilterValue.EndOfToday,
  [Symbol.for("lofidb.empty")]: DynamicFilterValue.Empty,
};

/** Values accepted in query template interpolations */
export type WhereValue =
  | string
  | number
  | boolean
  | Date
  | null
  | undefined
  | DynamicToken;

// ──────────────────────────────────────────────
// Branded return types (for overload disambiguation)
// ──────────────────────────────────────────────

export interface ParsedQuery {
  readonly _brand: "query";
  readonly filters: Filters;
  /** Stable key derived from interpolated values only. */
  readonly key: string;
}

export interface ParsedOrder {
  readonly _brand: "order";
  readonly order: string[];
  readonly orderDirection: OrderDirection;
  readonly key: string;
}

// ──────────────────────────────────────────────
// Operator resolution
// ──────────────────────────────────────────────

const OP_MAP: Record<string, FilterOperation> = {
  "=": FilterOperation.eq,
  "!=": FilterOperation.neq,
  ">": FilterOperation.gt,
  ">=": FilterOperation.gte,
  "<": FilterOperation.lt,
  "<=": FilterOperation.lte,
};

// Regex that matches a field name (supports dot notation like "activity.name")
// followed by an operator, at the end of a string segment.
const CLAUSE_REGEX = /([\w.]+)\s*(!=|>=|<=|=|>|<)\s*$/;

// ──────────────────────────────────────────────
// query tag
// ──────────────────────────────────────────────

/**
 * Tagged template literal for building reactive filter queries.
 *
 * ```ts
 * query`completed=${false}`
 * query`age>=${minAge} AND active=${true}`
 * query`(status=${s} AND priority>=${p}) OR urgent=${true}`
 * query`createdAt>=${$startOfToday} AND deletedAt=${$empty}`
 * query`activity.name=${name}`
 * ```
 *
 * Clauses separated by AND are grouped together.
 * OR starts a new group. Parentheses are cosmetic (for readability).
 * This maps directly to the Filters type: OR-of-ANDs.
 *
 * The returned key only changes when an interpolated value changes,
 * making it safe to use inline in React renders without causing
 * infinite re-subscribes.
 */
export function query(
  strings: TemplateStringsArray,
  ...values: WhereValue[]
): ParsedQuery {
  if (values.length === 0) {
    return { _brand: "query", filters: [], key: "[]" };
  }

  const groups: FilterClause[][] = [[]];

  for (let i = 0; i < values.length; i++) {
    const segment = strings[i];

    // Strip parentheses — they're cosmetic. Grouping comes from AND/OR.
    const cleaned = segment.replace(/[()]/g, "");

    // For segments after the first, check if OR starts a new group
    if (i > 0) {
      if (/\bOR\b/i.test(cleaned)) {
        groups.push([]);
      }
      // AND is the default — same group, no action needed
    }

    // Extract field and operator from the end of the segment
    const match = cleaned.match(CLAUSE_REGEX);
    if (!match) {
      throw new Error(
        `Could not parse filter clause from: "${segment.trim()}". ` +
          `Expected format: field operator \${value}`,
      );
    }

    const field = match[1];
    const op = OP_MAP[match[2]];
    if (!op) {
      throw new Error(`Unknown operator: "${match[2]}"`);
    }

    groups[groups.length - 1].push([field, op, wrapValue(values[i])]);
  }

  const filters = groups.filter((g) => g.length > 0);
  const key = computeKey(values);

  return { _brand: "query", filters, key };
}

// ──────────────────────────────────────────────
// order tag
// ──────────────────────────────────────────────

/**
 * Tagged template literal for declaring sort order.
 *
 * ```ts
 * order`createdAt desc`
 * order`priority desc, createdAt asc`
 * order`name`                          // defaults to asc
 * ```
 */
export function order(
  strings: TemplateStringsArray,
  ...values: never[]
): ParsedOrder {
  if (values.length > 0) {
    throw new Error(
      "order`...` does not support interpolated values. " +
        "Use plain field names and directions: order`createdAt desc, name asc`",
    );
  }

  const raw = strings[0].trim();
  if (!raw) {
    return { _brand: "order", order: [], orderDirection: [], key: "" };
  }

  const fields: string[] = [];
  const directions: OrderDirection = [];

  for (const part of raw.split(",")) {
    const tokens = part.trim().split(/\s+/);
    if (tokens.length === 0 || !tokens[0]) continue;

    fields.push(tokens[0]);

    const dir = tokens[1]?.toLowerCase();
    if (dir && dir !== "asc" && dir !== "desc") {
      throw new Error(
        `Invalid sort direction "${tokens[1]}" for field "${tokens[0]}". Use "asc" or "desc".`,
      );
    }
    directions.push((dir as "asc" | "desc") || "asc");
  }

  return {
    _brand: "order",
    order: fields,
    orderDirection: directions,
    key: raw,
  };
}

// ──────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────

function wrapValue(value: WhereValue): FilterValue {
  if (typeof value === "symbol") {
    const dynamic = DYNAMIC_TOKEN_MAP[value];
    if (!dynamic) {
      throw new Error(`Unknown dynamic token: ${String(value)}`);
    }
    return { type: FilterValueType.Dynamic, value: dynamic };
  }
  return { type: FilterValueType.Constant, value: value as ScalarJSValue };
}

/**
 * Compute a stable key from interpolated values only.
 *
 * The static template string parts (field names, operators, AND/OR)
 * never change between renders — they're compiled into the template.
 * Only the interpolated values can change, so the key is just their
 * serialized form.
 */
function computeKey(values: WhereValue[]): string {
  return JSON.stringify(
    values.map((v) => {
      if (v === null || v === undefined) return null;
      if (v instanceof Date) return v.toISOString();
      if (typeof v === "symbol") return Symbol.keyFor(v) || "sym";
      return v;
    }),
  );
}
