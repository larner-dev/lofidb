import { describe, it, expect } from "vitest";
import { query, order, $startOfToday, $endOfToday, $empty } from "../src/query";
import {
  FilterOperation,
  FilterValueType,
  DynamicFilterValue,
} from "../src/types";

// ──────────────────────────────────────────────
// query tag
// ──────────────────────────────────────────────

describe("query", () => {
  describe("single clause", () => {
    it("parses eq", () => {
      const { filters } = query`name=${"Alice"}`;
      expect(filters).toEqual([
        [
          [
            "name",
            FilterOperation.eq,
            { type: FilterValueType.Constant, value: "Alice" },
          ],
        ],
      ]);
    });

    it("parses neq", () => {
      const { filters } = query`status!=${"deleted"}`;
      expect(filters[0][0][1]).toBe(FilterOperation.neq);
    });

    it("parses gt", () => {
      const { filters } = query`age>${18}`;
      expect(filters[0][0][1]).toBe(FilterOperation.gt);
      expect(filters[0][0][2]).toEqual({
        type: FilterValueType.Constant,
        value: 18,
      });
    });

    it("parses gte", () => {
      const { filters } = query`score>=${95}`;
      expect(filters[0][0][1]).toBe(FilterOperation.gte);
    });

    it("parses lt", () => {
      const { filters } = query`price<${100}`;
      expect(filters[0][0][1]).toBe(FilterOperation.lt);
    });

    it("parses lte", () => {
      const { filters } = query`count<=${5}`;
      expect(filters[0][0][1]).toBe(FilterOperation.lte);
    });
  });

  describe("value types", () => {
    it("handles boolean true", () => {
      const { filters } = query`active=${true}`;
      expect(filters[0][0][2]).toEqual({
        type: FilterValueType.Constant,
        value: true,
      });
    });

    it("handles boolean false", () => {
      const { filters } = query`completed=${false}`;
      expect(filters[0][0][2]).toEqual({
        type: FilterValueType.Constant,
        value: false,
      });
    });

    it("handles null", () => {
      const { filters } = query`deletedAt=${null}`;
      expect(filters[0][0][2]).toEqual({
        type: FilterValueType.Constant,
        value: null,
      });
    });

    it("handles Date", () => {
      const date = new Date("2024-06-15T12:00:00Z");
      const { filters } = query`createdAt>${date}`;
      expect(filters[0][0][2]).toEqual({
        type: FilterValueType.Constant,
        value: date,
      });
    });

    it("handles numbers", () => {
      const { filters } = query`score>=${3.14}`;
      expect(filters[0][0][2]).toEqual({
        type: FilterValueType.Constant,
        value: 3.14,
      });
    });
  });

  describe("dynamic tokens", () => {
    it("$startOfToday", () => {
      const { filters } = query`createdAt>=${$startOfToday}`;
      expect(filters[0][0][2]).toEqual({
        type: FilterValueType.Dynamic,
        value: DynamicFilterValue.StartOfToday,
      });
    });

    it("$endOfToday", () => {
      const { filters } = query`createdAt<=${$endOfToday}`;
      expect(filters[0][0][2]).toEqual({
        type: FilterValueType.Dynamic,
        value: DynamicFilterValue.EndOfToday,
      });
    });

    it("$empty", () => {
      const { filters } = query`deletedAt=${$empty}`;
      expect(filters[0][0][2]).toEqual({
        type: FilterValueType.Dynamic,
        value: DynamicFilterValue.Empty,
      });
    });
  });

  describe("dot notation fields", () => {
    it("parses nested field names", () => {
      const { filters } = query`activity.name=${"Running"}`;
      expect(filters[0][0][0]).toBe("activity.name");
    });

    it("parses deeply nested fields", () => {
      const { filters } = query`a.b.c=${42}`;
      expect(filters[0][0][0]).toBe("a.b.c");
    });
  });

  describe("AND logic", () => {
    it("two AND clauses in one group", () => {
      const { filters } = query`age>=${18} AND active=${true}`;
      expect(filters).toHaveLength(1);
      expect(filters[0]).toHaveLength(2);
      expect(filters[0][0][0]).toBe("age");
      expect(filters[0][1][0]).toBe("active");
    });

    it("three AND clauses", () => {
      const { filters } = query`a=${1} AND b=${2} AND c=${3}`;
      expect(filters).toHaveLength(1);
      expect(filters[0]).toHaveLength(3);
    });
  });

  describe("OR logic", () => {
    it("two OR groups", () => {
      const { filters } = query`status=${"active"} OR role=${"admin"}`;
      expect(filters).toHaveLength(2);
      expect(filters[0]).toHaveLength(1);
      expect(filters[1]).toHaveLength(1);
      expect(filters[0][0][0]).toBe("status");
      expect(filters[1][0][0]).toBe("role");
    });

    it("three OR groups", () => {
      const { filters } = query`a=${1} OR b=${2} OR c=${3}`;
      expect(filters).toHaveLength(3);
    });
  });

  describe("OR-of-ANDs", () => {
    it("(a AND b) OR c", () => {
      const { filters } = query`(a=${1} AND b=${2}) OR c=${3}`;
      expect(filters).toHaveLength(2);
      expect(filters[0]).toHaveLength(2);
      expect(filters[0][0][0]).toBe("a");
      expect(filters[0][1][0]).toBe("b");
      expect(filters[1]).toHaveLength(1);
      expect(filters[1][0][0]).toBe("c");
    });

    it("(a AND b) OR (c AND d)", () => {
      const { filters } = query`(a=${1} AND b=${2}) OR (c=${3} AND d=${4})`;
      expect(filters).toHaveLength(2);
      expect(filters[0]).toHaveLength(2);
      expect(filters[1]).toHaveLength(2);
    });

    it("works without parens — AND binds tighter", () => {
      // a AND b OR c → [[a, b], [c]]
      const { filters } = query`a=${1} AND b=${2} OR c=${3}`;
      expect(filters).toHaveLength(2);
      expect(filters[0]).toHaveLength(2);
      expect(filters[1]).toHaveLength(1);
    });

    it("complex: (a AND b) OR (c AND d) OR e", () => {
      const { filters } = query`(a=${1} AND b=${2}) OR (c=${3} AND d=${4}) OR e=${5}`;
      expect(filters).toHaveLength(3);
      expect(filters[0]).toHaveLength(2);
      expect(filters[1]).toHaveLength(2);
      expect(filters[2]).toHaveLength(1);
    });
  });

  describe("whitespace tolerance", () => {
    it("allows spaces around operators", () => {
      const { filters } = query`name = ${"Alice"}`;
      expect(filters[0][0][0]).toBe("name");
      expect(filters[0][0][1]).toBe(FilterOperation.eq);
    });

    it("allows no spaces around operators", () => {
      const { filters } = query`name=${"Alice"}`;
      expect(filters[0][0][0]).toBe("name");
    });

    it("allows extra whitespace around AND/OR", () => {
      const { filters } = query`a=${1}   AND   b=${2}   OR   c=${3}`;
      expect(filters).toHaveLength(2);
      expect(filters[0]).toHaveLength(2);
    });
  });

  describe("case insensitivity of AND/OR", () => {
    it("accepts lowercase and/or", () => {
      const { filters } = query`a=${1} and b=${2} or c=${3}`;
      expect(filters).toHaveLength(2);
      expect(filters[0]).toHaveLength(2);
    });

    it("accepts mixed case", () => {
      const { filters } = query`a=${1} And b=${2} Or c=${3}`;
      expect(filters).toHaveLength(2);
    });
  });

  describe("no interpolations", () => {
    it("returns empty filters", () => {
      const result = query``;
      expect(result.filters).toEqual([]);
      expect(result._brand).toBe("query");
    });
  });

  describe("error handling", () => {
    it("throws on malformed clause", () => {
      expect(() => query`garbage ${42}`).toThrow("Could not parse");
    });
  });

  describe("key stability", () => {
    it("same values produce same key", () => {
      const key1 = query`name=${"Alice"} AND age>${25}`.key;
      const key2 = query`name=${"Alice"} AND age>${25}`.key;
      expect(key1).toBe(key2);
    });

    it("different values produce different keys", () => {
      const key1 = query`age>${25}`.key;
      const key2 = query`age>${30}`.key;
      expect(key1).not.toBe(key2);
    });

    it("same Date values produce same key", () => {
      const d1 = new Date("2024-06-15T12:00:00Z");
      const d2 = new Date("2024-06-15T12:00:00Z");
      const key1 = query`date>${d1}`.key;
      const key2 = query`date>${d2}`.key;
      expect(key1).toBe(key2);
    });

    it("different Dates produce different keys", () => {
      const d1 = new Date("2024-06-15");
      const d2 = new Date("2024-06-16");
      expect(query`date>${d1}`.key).not.toBe(query`date>${d2}`.key);
    });

    it("dynamic tokens produce stable keys", () => {
      const key1 = query`date>=${$startOfToday}`.key;
      const key2 = query`date>=${$startOfToday}`.key;
      expect(key1).toBe(key2);
    });

    it("null and $empty produce different keys", () => {
      const keyNull = query`x=${null}`.key;
      const keyEmpty = query`x=${$empty}`.key;
      expect(keyNull).not.toBe(keyEmpty);
    });

    it("key changes when variable value changes", () => {
      let status = "active";
      const key1 = query`status=${status}`.key;
      status = "inactive";
      const key2 = query`status=${status}`.key;
      expect(key1).not.toBe(key2);
    });

    it("key is stable when variable value stays the same", () => {
      const status = "active";
      const key1 = query`status=${status}`.key;
      const key2 = query`status=${status}`.key;
      expect(key1).toBe(key2);
    });
  });

  describe("real-world patterns", () => {
    it("today's items, not deleted", () => {
      const { filters } = query`createdAt>=${$startOfToday} AND createdAt<=${$endOfToday} AND deletedAt=${$empty}`;
      expect(filters).toHaveLength(1);
      expect(filters[0]).toHaveLength(3);
      expect(filters[0][0][2]).toEqual({
        type: FilterValueType.Dynamic,
        value: DynamicFilterValue.StartOfToday,
      });
      expect(filters[0][2][2]).toEqual({
        type: FilterValueType.Dynamic,
        value: DynamicFilterValue.Empty,
      });
    });

    it("active items matching category, or high priority", () => {
      const categoryId = "cat-1";
      const minPriority = 8;
      const { filters } = query`(active=${true} AND categoryId=${categoryId}) OR priority>=${minPriority}`;
      expect(filters).toHaveLength(2);
      expect(filters[0]).toHaveLength(2);
      expect(filters[0][1][2]).toEqual({
        type: FilterValueType.Constant,
        value: "cat-1",
      });
      expect(filters[1][0][2]).toEqual({
        type: FilterValueType.Constant,
        value: 8,
      });
    });
  });
});

// ──────────────────────────────────────────────
// order tag
// ──────────────────────────────────────────────

describe("order", () => {
  it("parses single field with direction", () => {
    const result = order`createdAt desc`;
    expect(result._brand).toBe("order");
    expect(result.order).toEqual(["createdAt"]);
    expect(result.orderDirection).toEqual(["desc"]);
  });

  it("defaults to asc", () => {
    const result = order`name`;
    expect(result.order).toEqual(["name"]);
    expect(result.orderDirection).toEqual(["asc"]);
  });

  it("parses multiple fields", () => {
    const result = order`priority desc, createdAt asc`;
    expect(result.order).toEqual(["priority", "createdAt"]);
    expect(result.orderDirection).toEqual(["desc", "asc"]);
  });

  it("handles mixed defaults", () => {
    const result = order`priority desc, name, createdAt asc`;
    expect(result.order).toEqual(["priority", "name", "createdAt"]);
    expect(result.orderDirection).toEqual(["desc", "asc", "asc"]);
  });

  it("tolerates extra whitespace", () => {
    const result = order`  priority   desc ,  name   asc  `;
    expect(result.order).toEqual(["priority", "name"]);
    expect(result.orderDirection).toEqual(["desc", "asc"]);
  });

  it("returns empty for empty string", () => {
    const result = order``;
    expect(result.order).toEqual([]);
    expect(result.orderDirection).toEqual([]);
  });

  it("produces a stable key from the raw string", () => {
    const key1 = order`createdAt desc`.key;
    const key2 = order`createdAt desc`.key;
    expect(key1).toBe(key2);
  });

  it("produces different keys for different orderings", () => {
    const key1 = order`createdAt desc`.key;
    const key2 = order`createdAt asc`.key;
    expect(key1).not.toBe(key2);
  });

  it("throws on invalid direction", () => {
    expect(() => order`name sideways`).toThrow("Invalid sort direction");
  });
});
