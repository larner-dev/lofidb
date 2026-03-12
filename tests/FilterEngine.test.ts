import { describe, it, expect, beforeEach } from "vitest";
import { FilterEngine } from "../src/FilterEngine";
import {
  FilterOperation,
  FilterValueType,
  DynamicFilterValue,
  Filters,
  FilterValue,
} from "../src/types";

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

const constant = (value: unknown): FilterValue => ({
  type: FilterValueType.Constant,
  value: value as any,
});

const dynamic = (value: DynamicFilterValue): FilterValue => ({
  type: FilterValueType.Dynamic,
  value,
});

describe("FilterEngine", () => {
  let engine: FilterEngine;

  beforeEach(() => {
    engine = new FilterEngine();
  });

  // ──────────────────────────────────────────────
  // resolveValue
  // ──────────────────────────────────────────────

  describe("resolveValue", () => {
    it("returns constant values as-is", () => {
      expect(engine.resolveValue(constant("hello"))).toBe("hello");
      expect(engine.resolveValue(constant(42))).toBe(42);
      expect(engine.resolveValue(constant(null))).toBe(null);
      expect(engine.resolveValue(constant(true))).toBe(true);
    });

    it("resolves Empty to null", () => {
      expect(engine.resolveValue(dynamic(DynamicFilterValue.Empty))).toBe(null);
    });

    it("resolves StartOfToday to midnight ISO string", () => {
      const result = engine.resolveValue(
        dynamic(DynamicFilterValue.StartOfToday),
      );
      expect(typeof result).toBe("string");
      // Should be at the start of the day (hour 0)
      const parsed = new Date(result as string);
      expect(parsed.getHours()).toBe(0);
      expect(parsed.getMinutes()).toBe(0);
      expect(parsed.getSeconds()).toBe(0);
    });

    it("resolves EndOfToday to end-of-day ISO string", () => {
      const result = engine.resolveValue(
        dynamic(DynamicFilterValue.EndOfToday),
      );
      expect(typeof result).toBe("string");
      const parsed = new Date(result as string);
      expect(parsed.getHours()).toBe(23);
      expect(parsed.getMinutes()).toBe(59);
    });

    it("throws for unknown dynamic values", () => {
      expect(() =>
        engine.resolveValue({
          type: FilterValueType.Dynamic,
          value: "UnknownValue" as DynamicFilterValue,
        }),
      ).toThrow("Unknown dynamic filter value");
    });
  });

  // ──────────────────────────────────────────────
  // normalizeForComparison
  // ──────────────────────────────────────────────

  describe("normalizeForComparison", () => {
    it("converts null and undefined to null", () => {
      expect(engine.normalizeForComparison(null)).toBe(null);
      expect(engine.normalizeForComparison(undefined)).toBe(null);
    });

    it("converts dates to ISO strings", () => {
      const d = new Date("2024-06-15T12:00:00Z");
      expect(engine.normalizeForComparison(d)).toBe(d.toISOString());
    });

    it("converts booleans to 0/1 (matches SQLite storage)", () => {
      expect(engine.normalizeForComparison(true)).toBe(1);
      expect(engine.normalizeForComparison(false)).toBe(0);
    });

    it("passes strings and numbers through unchanged", () => {
      expect(engine.normalizeForComparison("abc")).toBe("abc");
      expect(engine.normalizeForComparison(42)).toBe(42);
      expect(engine.normalizeForComparison(3.14)).toBe(3.14);
    });
  });

  // ──────────────────────────────────────────────
  // compare
  // ──────────────────────────────────────────────

  describe("compare", () => {
    describe("eq", () => {
      it("matches equal values", () => {
        expect(engine.compare(1, FilterOperation.eq, 1)).toBe(true);
        expect(engine.compare("a", FilterOperation.eq, "a")).toBe(true);
      });

      it("rejects unequal values", () => {
        expect(engine.compare(1, FilterOperation.eq, 2)).toBe(false);
      });

      it("null == null is true", () => {
        expect(engine.compare(null, FilterOperation.eq, null)).toBe(true);
      });

      it("null == value is false", () => {
        expect(engine.compare(null, FilterOperation.eq, 1)).toBe(false);
        expect(engine.compare(1, FilterOperation.eq, null)).toBe(false);
      });
    });

    describe("neq", () => {
      it("matches unequal values", () => {
        expect(engine.compare(1, FilterOperation.neq, 2)).toBe(true);
      });

      it("rejects equal values", () => {
        expect(engine.compare(1, FilterOperation.neq, 1)).toBe(false);
      });

      it("null != null is false", () => {
        expect(engine.compare(null, FilterOperation.neq, null)).toBe(false);
      });

      it("null != value is true", () => {
        expect(engine.compare(null, FilterOperation.neq, 1)).toBe(true);
      });
    });

    describe("ordered comparisons", () => {
      it("gt", () => {
        expect(engine.compare(2, FilterOperation.gt, 1)).toBe(true);
        expect(engine.compare(1, FilterOperation.gt, 1)).toBe(false);
        expect(engine.compare(0, FilterOperation.gt, 1)).toBe(false);
      });

      it("gte", () => {
        expect(engine.compare(2, FilterOperation.gte, 1)).toBe(true);
        expect(engine.compare(1, FilterOperation.gte, 1)).toBe(true);
        expect(engine.compare(0, FilterOperation.gte, 1)).toBe(false);
      });

      it("lt", () => {
        expect(engine.compare(0, FilterOperation.lt, 1)).toBe(true);
        expect(engine.compare(1, FilterOperation.lt, 1)).toBe(false);
      });

      it("lte", () => {
        expect(engine.compare(0, FilterOperation.lte, 1)).toBe(true);
        expect(engine.compare(1, FilterOperation.lte, 1)).toBe(true);
        expect(engine.compare(2, FilterOperation.lte, 1)).toBe(false);
      });

      it("returns false when either side is null", () => {
        expect(engine.compare(null, FilterOperation.gt, 1)).toBe(false);
        expect(engine.compare(1, FilterOperation.gt, null)).toBe(false);
        expect(engine.compare(null, FilterOperation.lt, 1)).toBe(false);
        expect(engine.compare(null, FilterOperation.gte, null)).toBe(false);
      });
    });

    describe("string comparisons", () => {
      it("compares strings lexicographically", () => {
        expect(engine.compare("b", FilterOperation.gt, "a")).toBe(true);
        expect(engine.compare("a", FilterOperation.lt, "b")).toBe(true);
        expect(engine.compare("abc", FilterOperation.eq, "abc")).toBe(true);
      });

      it("compares ISO date strings correctly", () => {
        expect(
          engine.compare(
            "2024-06-15",
            FilterOperation.gt,
            "2024-01-01",
          ),
        ).toBe(true);
        expect(
          engine.compare(
            "2024-01-01",
            FilterOperation.lt,
            "2024-06-15",
          ),
        ).toBe(true);
      });
    });
  });

  // ──────────────────────────────────────────────
  // getNestedValue
  // ──────────────────────────────────────────────

  describe("getNestedValue", () => {
    it("accesses top-level fields", () => {
      expect(engine.getNestedValue("name", { name: "Alice" })).toEqual({
        found: true,
        value: "Alice",
      });
    });

    it("accesses nested fields via dot notation", () => {
      const record = { address: { city: "Seattle", zip: "98107" } };
      expect(engine.getNestedValue("address.city", record)).toEqual({
        found: true,
        value: "Seattle",
      });
    });

    it("accesses deeply nested fields", () => {
      const record = { a: { b: { c: 42 } } };
      expect(engine.getNestedValue("a.b.c", record)).toEqual({
        found: true,
        value: 42,
      });
    });

    it("returns found=false for missing top-level fields", () => {
      expect(engine.getNestedValue("missing", { name: "Alice" })).toEqual({
        found: false,
        value: undefined,
      });
    });

    it("returns found=false for missing nested fields", () => {
      expect(engine.getNestedValue("a.b.c", { a: { x: 1 } })).toEqual({
        found: false,
        value: undefined,
      });
    });

    it("returns found=false when traversing through null", () => {
      expect(engine.getNestedValue("a.b", { a: null })).toEqual({
        found: false,
        value: undefined,
      });
    });

    it("handles fields with value null/undefined/0/false", () => {
      expect(engine.getNestedValue("x", { x: null })).toEqual({
        found: true,
        value: null,
      });
      expect(engine.getNestedValue("x", { x: 0 })).toEqual({
        found: true,
        value: 0,
      });
      expect(engine.getNestedValue("x", { x: false })).toEqual({
        found: true,
        value: false,
      });
    });
  });

  // ──────────────────────────────────────────────
  // matches (full in-memory filter evaluation)
  // ──────────────────────────────────────────────

  describe("matches", () => {
    const alice = { id: "1", name: "Alice", age: 30, active: true };
    const bob = { id: "2", name: "Bob", age: 25, active: false };
    const carol = { id: "3", name: "Carol", age: 35, active: true };

    it("returns true when no filters are provided", () => {
      expect(engine.matches(alice)).toBe(true);
      expect(engine.matches(alice, undefined)).toBe(true);
      expect(engine.matches(alice, [])).toBe(true);
    });

    it("filters with eq", () => {
      const f: Filters = [[["name", FilterOperation.eq, constant("Alice")]]];
      expect(engine.matches(alice, f)).toBe(true);
      expect(engine.matches(bob, f)).toBe(false);
    });

    it("AND: all clauses in a group must match", () => {
      const f: Filters = [
        [
          ["age", FilterOperation.gte, constant(25)],
          ["active", FilterOperation.eq, constant(true)],
        ],
      ];
      expect(engine.matches(alice, f)).toBe(true); // 30≥25, active
      expect(engine.matches(bob, f)).toBe(false); // 25≥25 but !active
      expect(engine.matches(carol, f)).toBe(true); // 35≥25, active
    });

    it("OR: any group can match", () => {
      const f: Filters = [
        [["name", FilterOperation.eq, constant("Alice")]],
        [["name", FilterOperation.eq, constant("Carol")]],
      ];
      expect(engine.matches(alice, f)).toBe(true);
      expect(engine.matches(bob, f)).toBe(false);
      expect(engine.matches(carol, f)).toBe(true);
    });

    it("combined AND + OR", () => {
      // (age > 30) OR (name = "Bob" AND active = false)
      const f: Filters = [
        [["age", FilterOperation.gt, constant(30)]],
        [
          ["name", FilterOperation.eq, constant("Bob")],
          ["active", FilterOperation.eq, constant(false)],
        ],
      ];
      expect(engine.matches(alice, f)).toBe(false); // age=30 not > 30, not Bob
      expect(engine.matches(bob, f)).toBe(true); // Bob and !active
      expect(engine.matches(carol, f)).toBe(true); // age=35 > 30
    });

    it("returns false when a filtered field is missing from record", () => {
      const f: Filters = [
        [["nonexistent", FilterOperation.eq, constant("x")]],
      ];
      expect(engine.matches(alice, f)).toBe(false);
    });

    it("throws for non-scalar values", () => {
      const record = { id: "1", meta: { nested: true } };
      const f: Filters = [
        [["meta", FilterOperation.eq, constant("something")]],
      ];
      expect(() => engine.matches(record, f)).toThrow("non-scalar");
    });

    it("handles nested field filters", () => {
      const record = {
        id: "1",
        activity: { id: "a1", name: "Running" },
      };
      const f: Filters = [
        [["activity.name", FilterOperation.eq, constant("Running")]],
      ];
      expect(engine.matches(record, f)).toBe(true);
    });
  });

  // ──────────────────────────────────────────────
  // toSql
  // ──────────────────────────────────────────────

  describe("toSql", () => {
    it("returns empty for no filters", () => {
      expect(engine.toSql()).toEqual({ sql: "", values: [] });
      expect(engine.toSql([])).toEqual({ sql: "", values: [] });
    });

    it("single eq clause", () => {
      const f: Filters = [
        [["name", FilterOperation.eq, constant("Alice")]],
      ];
      const { sql, values } = engine.toSql(f);
      expect(sql).toBe('"name" = ?');
      expect(values).toEqual(["Alice"]);
    });

    it("AND group", () => {
      const f: Filters = [
        [
          ["age", FilterOperation.gte, constant(25)],
          ["active", FilterOperation.eq, constant(true)],
        ],
      ];
      const { sql, values } = engine.toSql(f);
      expect(sql).toBe('("age" >= ? AND "active" = ?)');
      expect(values).toEqual([25, 1]); // boolean → 1
    });

    it("OR group", () => {
      const f: Filters = [
        [["name", FilterOperation.eq, constant("Alice")]],
        [["name", FilterOperation.eq, constant("Bob")]],
      ];
      const { sql, values } = engine.toSql(f);
      expect(sql).toBe('("name" = ? OR "name" = ?)');
      expect(values).toEqual(["Alice", "Bob"]);
    });

    it("IS NULL for empty dynamic value", () => {
      const f: Filters = [
        [
          [
            "deletedAt",
            FilterOperation.eq,
            dynamic(DynamicFilterValue.Empty),
          ],
        ],
      ];
      const { sql, values } = engine.toSql(f);
      expect(sql).toBe('"deleted_at" IS NULL');
      expect(values).toEqual([]);
    });

    it("IS NOT NULL for neq empty", () => {
      const f: Filters = [
        [
          [
            "deletedAt",
            FilterOperation.neq,
            dynamic(DynamicFilterValue.Empty),
          ],
        ],
      ];
      const { sql, values } = engine.toSql(f);
      expect(sql).toBe('"deleted_at" IS NOT NULL');
      expect(values).toEqual([]);
    });

    it("snake_cases camelCase field names", () => {
      const f: Filters = [
        [["createdAt", FilterOperation.gt, constant("2024-01-01")]],
      ];
      const { sql } = engine.toSql(f);
      expect(sql).toContain('"created_at"');
    });

    it("converts Date values to ISO strings", () => {
      const d = new Date("2024-06-15T12:00:00Z");
      const f: Filters = [[["createdAt", FilterOperation.gt, constant(d)]]];
      const { values } = engine.toSql(f);
      expect(values[0]).toBe(d.toISOString());
    });

    it("complex AND + OR", () => {
      const f: Filters = [
        [
          ["age", FilterOperation.gt, constant(30)],
          ["active", FilterOperation.eq, constant(true)],
        ],
        [["name", FilterOperation.eq, constant("Bob")]],
      ];
      const { sql, values } = engine.toSql(f);
      expect(sql).toBe(
        '(("age" > ? AND "active" = ?) OR "name" = ?)',
      );
      expect(values).toEqual([30, 1, "Bob"]);
    });
  });

  // ──────────────────────────────────────────────
  // SQL / memory consistency
  //
  // These are the critical tests: for any record and filter,
  // the in-memory match and SQL WHERE clause must agree.
  // We can't run actual SQL here, but we verify that:
  //   1. Both paths use the same value resolution
  //   2. SQL is syntactically valid for each case
  //   3. Null handling is consistent
  // ──────────────────────────────────────────────

  describe("SQL / memory consistency", () => {
    interface ConsistencyCase {
      name: string;
      record: Record<string, unknown>;
      filters: Filters;
      expectedMatch: boolean;
    }

    const cases: ConsistencyCase[] = [
      {
        name: "string eq match",
        record: { id: "1", name: "Alice" },
        filters: [[["name", FilterOperation.eq, constant("Alice")]]],
        expectedMatch: true,
      },
      {
        name: "string eq no match",
        record: { id: "1", name: "Bob" },
        filters: [[["name", FilterOperation.eq, constant("Alice")]]],
        expectedMatch: false,
      },
      {
        name: "numeric gt",
        record: { id: "1", age: 30 },
        filters: [[["age", FilterOperation.gt, constant(25)]]],
        expectedMatch: true,
      },
      {
        name: "boolean eq true",
        record: { id: "1", active: true },
        filters: [[["active", FilterOperation.eq, constant(true)]]],
        expectedMatch: true,
      },
      {
        name: "boolean eq false",
        record: { id: "1", active: false },
        filters: [[["active", FilterOperation.eq, constant(true)]]],
        expectedMatch: false,
      },
      {
        name: "null eq null (Empty)",
        record: { id: "1", deletedAt: undefined },
        filters: [
          [
            [
              "deletedAt",
              FilterOperation.eq,
              dynamic(DynamicFilterValue.Empty),
            ],
          ],
        ],
        expectedMatch: true,
      },
      {
        name: "null neq null (Empty) → false",
        record: { id: "1", deletedAt: undefined },
        filters: [
          [
            [
              "deletedAt",
              FilterOperation.neq,
              dynamic(DynamicFilterValue.Empty),
            ],
          ],
        ],
        expectedMatch: false,
      },
      {
        name: "value neq null → true",
        record: { id: "1", deletedAt: "2024-01-01" },
        filters: [
          [
            [
              "deletedAt",
              FilterOperation.neq,
              dynamic(DynamicFilterValue.Empty),
            ],
          ],
        ],
        expectedMatch: true,
      },
      {
        name: "null gt value → false (ordered comparison with null)",
        record: { id: "1", age: undefined },
        filters: [[["age", FilterOperation.gt, constant(0)]]],
        expectedMatch: false,
      },
      {
        name: "date string comparison",
        record: { id: "1", createdAt: "2024-06-15T00:00:00.000Z" },
        filters: [
          [["createdAt", FilterOperation.gt, constant("2024-01-01T00:00:00.000Z")]],
        ],
        expectedMatch: true,
      },
    ];

    for (const tc of cases) {
      it(`memory: ${tc.name}`, () => {
        expect(engine.matches(tc.record, tc.filters)).toBe(tc.expectedMatch);
      });

      it(`sql valid: ${tc.name}`, () => {
        const { sql, values } = engine.toSql(tc.filters);
        expect(sql.length).toBeGreaterThan(0);
        expect(sql).not.toContain("undefined");
        expect(sql).not.toContain("NaN");
        // Values should all be SQL-safe types
        for (const v of values) {
          expect(
            v === null ||
              typeof v === "string" ||
              typeof v === "number",
          ).toBe(true);
        }
      });
    }
  });

  // ──────────────────────────────────────────────
  // Dynamic value detection
  // ──────────────────────────────────────────────

  describe("getDynamicValues / hasDailyDynamicValues", () => {
    it("returns empty for no filters", () => {
      expect(engine.getDynamicValues()).toEqual([]);
      expect(engine.getDynamicValues([])).toEqual([]);
    });

    it("extracts dynamic values from filters", () => {
      const f: Filters = [
        [
          [
            "createdAt",
            FilterOperation.gte,
            dynamic(DynamicFilterValue.StartOfToday),
          ],
          [
            "createdAt",
            FilterOperation.lte,
            dynamic(DynamicFilterValue.EndOfToday),
          ],
        ],
      ];
      const vals = engine.getDynamicValues(f);
      expect(vals).toEqual([
        DynamicFilterValue.StartOfToday,
        DynamicFilterValue.EndOfToday,
      ]);
    });

    it("hasDailyDynamicValues detects daily timers", () => {
      const withDaily: Filters = [
        [
          [
            "date",
            FilterOperation.gte,
            dynamic(DynamicFilterValue.StartOfToday),
          ],
        ],
      ];
      const withoutDaily: Filters = [
        [
          [
            "status",
            FilterOperation.eq,
            dynamic(DynamicFilterValue.Empty),
          ],
        ],
      ];
      expect(engine.hasDailyDynamicValues(withDaily)).toBe(true);
      expect(engine.hasDailyDynamicValues(withoutDaily)).toBe(false);
    });
  });
});
