// ──────────────────────────────────────────────
// Database adapter
// ──────────────────────────────────────────────

/**
 * Row-set interface matching the WebSQL/react-native-sqlite-2 pattern.
 * Implement this to connect LofiDb to your SQLite driver.
 */
export interface DbResultSet {
  rows: {
    length: number;
    item(index: number): Record<string, string | number | null>;
  };
  rowsAffected: number;
}

/**
 * Minimal database adapter interface.
 *
 * Implement this for your SQLite driver. Examples:
 * - react-native-sqlite-2: wrap `db.executeSql()`
 * - expo-sqlite: wrap `db.execAsync()`
 * - better-sqlite3: wrap `db.prepare().all()`
 * - sql.js: wrap `db.exec()`
 */
export interface DbAdapter {
  raw(sql: string, params: unknown[]): Promise<DbResultSet>;
}

// ──────────────────────────────────────────────
// Filter types
// ──────────────────────────────────────────────

export enum FilterOperation {
  lt = "lt",
  lte = "lte",
  gt = "gt",
  gte = "gte",
  eq = "eq",
  neq = "neq",
}

export enum DynamicFilterValue {
  StartOfToday = "StartOfToday",
  EndOfToday = "EndOfToday",
  Empty = "Empty",
}

export enum FilterValueType {
  Constant = "constant",
  Dynamic = "dynamic",
}

export interface ConstantFilterValue {
  type: FilterValueType.Constant;
  value: ScalarJSValue;
}

export interface DynamicFilterValueDef {
  type: FilterValueType.Dynamic;
  value: DynamicFilterValue;
}

export type FilterValue = ConstantFilterValue | DynamicFilterValueDef;

/** [field, operation, value] */
export type FilterClause = [string, FilterOperation, FilterValue];

/** Outer array = OR groups, inner array = AND clauses within a group */
export type Filters = FilterClause[][];

// ──────────────────────────────────────────────
// Value types
// ──────────────────────────────────────────────

export type ScalarJSValue =
  | string
  | number
  | boolean
  | Date
  | null
  | undefined;

export type JSValue = ScalarJSValue | Record<string, unknown> | unknown[];

// ──────────────────────────────────────────────
// Schema types
// ──────────────────────────────────────────────

export enum FieldType {
  String,
  Date,
  Int,
  Float,
  Bool,
  JSON,
  ID,
}

export enum RelationType {
  One = "one",
  Many = "many",
}

export type OrderDirection = ("asc" | "desc")[];

export interface Relation {
  type: RelationType;
  collection: string;
  foreignKey: string;
  field?: string;
  order?: string[];
  orderDirection?: OrderDirection;
}

export interface CollectionSchema {
  relations?: Relation[];
  fields: Record<string, FieldType>;
}

export type LofiDbSchema = Record<string, CollectionSchema>;

// ──────────────────────────────────────────────
// Record types
// ──────────────────────────────────────────────

export interface SubscriptionRecord {
  [key: string]: unknown;
  id: string;
}

export type UpdateRecord<T extends SubscriptionRecord> = Partial<Omit<T, "id">>;

// ──────────────────────────────────────────────
// Configuration
// ──────────────────────────────────────────────

export type ErrorHandler = (error: {
  type: string;
  title: string;
  message: string;
}) => void;

/**
 * Options for LofiDb construction.
 *
 * All hooks are optional — LofiDb works without them,
 * but they let you wire into platform-specific behavior.
 */
export interface LofiDbOptions {
  /**
   * Called when a record disappears mid-update.
   * Default: console.error.
   */
  onError?: ErrorHandler;

  /**
   * Register a callback to be called when the app returns
   * to the foreground. LofiDb will refresh all subscriptions.
   *
   * Example (React Native):
   *   onAppForeground: (cb) => {
   *     const sub = AppState.addEventListener("change", (s) => {
   *       if (s === "active") cb();
   *     });
   *     return () => sub.remove();
   *   }
   *
   * Example (web):
   *   onAppForeground: (cb) => {
   *     document.addEventListener("visibilitychange", () => {
   *       if (document.visibilityState === "visible") cb();
   *     });
   *     return () => document.removeEventListener("visibilitychange", cb);
   *   }
   */
  onAppForeground?: (callback: () => void) => (() => void) | void;

  /**
   * Delay in ms between refreshing each collection
   * when the app returns to foreground. Default: 500.
   */
  refreshDelayMs?: number;
}
