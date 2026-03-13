# LofiDb

A reactive local-first database layer for JavaScript/TypeScript apps. LofiDb wraps any SQLite driver with subscription-based reactivity, automatic relationship hydration, and optimistic UI updates.

**What it does:** You define a schema, connect a SQLite adapter, and LofiDb gives you reactive collections that push updates to your UI whenever data changes — no polling, no manual invalidation.

## Install

```bash
npm install lofidb
```

## Quick Start

```typescript
import { LofiDb, Collection, FieldType, RelationType } from "lofidb";
import { useLofiQuery } from "lofidb/react";
import { query, order, $startOfToday } from "lofidb";

// 1. Define your schema
const schema = {
  todos: {
    fields: {
      id: FieldType.ID,
      title: FieldType.String,
      completed: FieldType.Bool,
      categoryId: FieldType.ID,
      createdAt: FieldType.Date,
    },
    relations: [
      {
        type: RelationType.One,
        collection: "categories",
        foreignKey: "categoryId",
        field: "category",
      },
    ],
  },
  categories: {
    fields: {
      id: FieldType.ID,
      name: FieldType.String,
      color: FieldType.String,
    },
  },
};

// 2. Create a typed subclass
interface BaseTodo { id: string; title: string; completed: boolean; categoryId: string; createdAt: Date; }
interface HydratedTodo extends BaseTodo { category: BaseCategory; }
interface BaseCategory { id: string; name: string; color: string; }

class MyDb extends LofiDb {
  todos!: Collection<BaseTodo, HydratedTodo>;
  categories!: Collection<BaseCategory>;
}

// 3. Connect your SQLite adapter
const db = new MyDb(schema, sqliteAdapter);

// 4. Use in a React component
function TodoList() {
  const { results, loading } = useLofiQuery(
    db.todos,
    query`completed=${false} AND createdAt>=${$startOfToday}`,
    order`createdAt desc`,
  );

  if (loading) return <Text>Loading...</Text>;
  return results.map((todo) => <TodoItem key={todo.id} todo={todo} />);
}
```

## Database Adapter

LofiDb works with any SQLite driver. Implement the `DbAdapter` interface:

```typescript
import { DbAdapter, DbResultSet } from "lofidb";

const adapter: DbAdapter = {
  async raw(sql: string, params: unknown[]): Promise<DbResultSet> {
    // Run the query and return results in WebSQL format
    // Return: { rows: { length, item(i) }, rowsAffected }
  },
};
```

### React Native (react-native-sqlite-2)

```typescript
import SQLite from "react-native-sqlite-2";

const sqliteDb = SQLite.openDatabase("myapp.db", "1.0", "", 4 * 1024 * 1024);

const adapter: DbAdapter = {
  raw: (sql, params) =>
    new Promise((resolve, reject) => {
      sqliteDb.transaction(
        (tx) => {
          tx.executeSql(sql, params, (_tx, results) => resolve(results));
        },
        (error) => reject(error),
      );
    }),
};
```

### Expo SQLite

```typescript
import * as SQLite from "expo-sqlite";

const sqliteDb = SQLite.openDatabaseSync("myapp.db");

const adapter: DbAdapter = {
  raw: async (sql, params) => {
    const result = await sqliteDb.execAsync([{ sql, args: params }], false);
    return {
      rows: {
        length: result[0].rows.length,
        item: (i: number) => result[0].rows[i],
      },
      rowsAffected: result[0].rowsAffected,
    };
  },
};
```

### better-sqlite3 (Node.js)

```typescript
import Database from "better-sqlite3";

const sqliteDb = new Database("myapp.db");

const adapter: DbAdapter = {
  raw: async (sql, params) => {
    if (sql.trim().toUpperCase().startsWith("SELECT")) {
      const rows = sqliteDb.prepare(sql).all(...params);
      return {
        rows: {
          length: rows.length,
          item: (i: number) => rows[i],
        },
        rowsAffected: 0,
      };
    }
    const result = sqliteDb.prepare(sql).run(...params);
    return {
      rows: { length: 0, item: () => ({}) },
      rowsAffected: result.changes,
    };
  },
};
```

## Querying with `query` and `order`

LofiDb uses tagged template literals for filtering and ordering. This gives you a readable SQL-like syntax that's fully reactive — the hook re-subscribes automatically when an interpolated variable changes, but not on regular re-renders.

```tsx
import { useLofiQuery } from "lofidb/react";
import { query, order, $startOfToday, $endOfToday, $empty } from "lofidb";
```

### Basic usage

```tsx
// Everything, no filters
const { results } = useLofiQuery(db.todos);

// Just ordering
const { results } = useLofiQuery(db.todos, order`createdAt desc`);

// Filter only
const { results } = useLofiQuery(db.todos, query`completed=${false}`);

// Filter + ordering
const { results } = useLofiQuery(
  db.todos,
  query`completed=${false}`,
  order`createdAt desc`,
);
```

### Operators

All standard comparison operators are supported:

```tsx
query`name=${"Alice"}`           // =
query`status!=${"deleted"}`      // !=
query`age>${18}`                 // >
query`score>=${95}`              // >=
query`price<${100}`              // <
query`count<=${5}`               // <=
```

Spaces around operators are optional: `name = ${"Alice"}` and `name=${"Alice"}` both work.

### AND / OR

Clauses are ANDed by default. Use `OR` to start a new group:

```tsx
// AND: both must match
query`age>=${18} AND active=${true}`

// OR: either group matches
query`status=${"active"} OR role=${"admin"}`

// OR-of-ANDs (full power): parentheses for readability
query`(status=${status} AND priority>=${minPri}) OR urgent=${true}`

// Complex
query`(age>=${18} AND active=${true}) OR (role=${"admin"} AND verified=${true}) OR priority>=${10}`
```

Parentheses are cosmetic — they make the grouping easier to read but the parser only looks at AND/OR keywords. AND binds tighter than OR, so `a AND b OR c` parses as `(a AND b) OR (c)`.

AND and OR are case-insensitive: `and`, `AND`, `And` all work.

### Dynamic values

Three special tokens resolve to dynamic values at query time:

```tsx
import { $startOfToday, $endOfToday, $empty } from "lofidb";

// Today's items
query`createdAt>=${$startOfToday} AND createdAt<=${$endOfToday}`

// Not deleted (IS NULL in SQL)
query`deletedAt=${$empty}`
```

| Token | Resolves to | SQL equivalent |
|-------|------------|----------------|
| `$startOfToday` | Midnight today (ISO string). Subscriptions auto-refresh at midnight. | `>= '2024-06-15T00:00:00.000Z'` |
| `$endOfToday` | 23:59:59.999 today. | `<= '2024-06-15T23:59:59.999Z'` |
| `$empty` | `null` | `IS NULL` / `IS NOT NULL` |

### Dot notation for relations

Filter on hydrated relation fields:

```tsx
query`activity.name=${"Running"}`
query`category.color=${"blue"} AND completed=${false}`
```

### Ordering

The `order` tag parses static field names and directions. Multi-column sorting uses commas:

```tsx
order`createdAt desc`
order`priority desc, createdAt asc`
order`name`                          // defaults to asc
```

### Reactive stability

The key insight: in a tagged template literal, the string parts (field names, operators, AND/OR) are compile-time constants. Only the interpolated `${values}` can change between renders. The hook uses a stable key derived from just the values, so it only re-subscribes when an actual variable changes:

```tsx
function TodoList({ categoryId, minPriority }) {
  // Re-subscribes when categoryId or minPriority change.
  // Does NOT re-subscribe on other re-renders.
  const { results } = useLofiQuery(
    db.todos,
    query`categoryId=${categoryId} AND priority>=${minPriority}`,
    order`createdAt desc`,
  );
  // ...
}
```

No `useMemo`, no `useRef` tricks, no dependency arrays to manage — just write the query inline.

### Vanilla JS subscriptions

Outside React, use the subscription manager directly with the raw `Filters` type:

```typescript
const { remove } = db.todos.subscriptions.subscribe(
  filters,           // Filters type (OR-of-ANDs array)
  ["createdAt"],     // order
  ["desc"],          // orderDirection
  ({ results, loading, error }) => {
    console.log("Todos changed:", results);
  },
);

// Later: stop listening
remove();
```

## CRUD

```typescript
// Create — returns void
await db.todos.create({
  id: "todo-1",
  title: "Buy milk",
  completed: false,
  categoryId: "cat-1",
  createdAt: new Date(),
});

// Update — returns true if the record was found and updated, false otherwise
const updated = await db.todos.update("todo-1", { completed: true });

// Upsert — updates if exists, creates if not. Always returns true.
await db.todos.upsert({ id: "todo-1", title: "Buy oat milk", completed: false, categoryId: "cat-1", createdAt: new Date() });

// Delete — returns true if the record was found and deleted, false otherwise
const deleted = await db.todos.delete("todo-1");

// Fetch one — returns the record or null if not found
const todo = await db.todos.fetch("todo-1");

// Fetch one — throws if not found
const todo = await db.todos.fetchOrThrow("todo-1");

// Filter — query with optional filters, ordering
const completed = await db.todos.filter({
  filters,                        // optional: Filters (OR-of-ANDs array)
  order: ["createdAt"],           // optional: field names to order by
  orderDirection: ["desc"],       // optional: "asc" or "desc" per order field
});
```

All write operations (`create`, `update`, `upsert`, `delete`) automatically notify active subscriptions.

### emitContext

All write methods accept an optional `emitContext` parameter — an arbitrary object that gets passed through to event listeners. Useful for tagging where a change originated (e.g. "from sync" vs "from user"):

```typescript
await db.todos.create(record, { source: "sync" });
await db.todos.update("todo-1", { completed: true }, { source: "user" });
await db.todos.delete("todo-1", { source: "sync" });

db.todos.on("create", ({ id, after, emitContext }) => {
  if (emitContext?.source === "sync") return; // skip server echo
  pushToServer(after);
});
```

## Schema

### Field types

| FieldType | JS type | SQLite storage |
|-----------|---------|----------------|
| `FieldType.ID` | `string` | TEXT |
| `FieldType.String` | `string` | TEXT |
| `FieldType.Int` | `number` | INTEGER |
| `FieldType.Float` | `number` | REAL |
| `FieldType.Bool` | `boolean` | INTEGER (0/1) |
| `FieldType.Date` | `Date` | TEXT (ISO 8601) |
| `FieldType.JSON` | `object \| array` | TEXT (JSON string) |

### Relations

Relations define how collections connect to each other. LofiDb automatically hydrates related records when querying.

```typescript
const schema = {
  todos: {
    fields: { id: FieldType.ID, title: FieldType.String, categoryId: FieldType.ID },
    relations: [
      {
        type: RelationType.One,       // or RelationType.Many
        collection: "categories",     // target collection name
        foreignKey: "categoryId",     // field on this collection pointing to the target
        field: "category",            // optional: name of the hydrated field (defaults to collection name)
        order: ["name"],              // optional (Many only): order related records by these fields
        orderDirection: ["asc"],      // optional (Many only): "asc" or "desc" per order field
      },
    ],
  },
};
```

- **`RelationType.One`** — hydrates a single related record (e.g. a todo's category).
- **`RelationType.Many`** — hydrates an array of related records (e.g. a category's todos). Use `order` and `orderDirection` to control sort order.

## Lifecycle Hooks

```typescript
const db = new MyDb(schema, adapter, {
  // React Native: refresh on foreground
  onAppForeground: (callback) => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") callback();
    });
    return () => sub.remove();
  },

  // Web: refresh on visibility change
  // onAppForeground: (callback) => {
  //   const handler = () => {
  //     if (document.visibilityState === "visible") callback();
  //   };
  //   document.addEventListener("visibilitychange", handler);
  //   return () => document.removeEventListener("visibilitychange", handler);
  // },

  // Custom error handler (default: console.error)
  onError: ({ type, title, message }) => {
    Toast.show({ type, text1: title, text2: message });
  },
});
```

## Events

Listen to changes at the database level:

```typescript
db.on("create", ({ collection, id, input, after, emitContext }) => {
  console.log(`Created ${collection} ${id}`);
});

db.on("update", ({ collection, id, input, before, after, emitContext }) => {
  console.log(`Updated ${collection} ${id}`);
});

db.on("delete", ({ collection, id, before, emitContext }) => {
  console.log(`Deleted ${collection} ${id}`);
});
```

Or at the collection level:

```typescript
db.todos.on("create", ({ id, input, after, emitContext }) => {
  // input: the raw record passed to create()
  // after: the hydrated record after insert
});

db.todos.on("update", ({ id, input, before, after, emitContext }) => {
  // input: the partial update passed to update()
  // before/after: hydrated records before and after the change
});

db.todos.on("delete", ({ id, before, emitContext }) => {
  // before: the hydrated record that was deleted
});
```

## Database Methods

### `refreshAll()`

Re-runs all active subscriptions across all collections. This is called automatically when `onAppForeground` fires, but you can also call it manually:

```typescript
await db.refreshAll();
```

You can also refresh a single collection:

```typescript
await db.todos.refreshAll();
```

### `invalidateAllLoaders()`

Clears the internal DataLoader caches across all collections. Useful if you've modified the database outside of LofiDb and want hydration to pick up fresh data:

```typescript
db.invalidateAllLoaders();
```

### `destroy()`

Cleans up timers, event listeners, and the foreground refresh hook:

```typescript
db.destroy();
```

## React Hooks

### `useLofiQuery`

The primary React hook. See [Querying with `query` and `order`](#querying-with-query-and-order) for full usage.

```tsx
import { useLofiQuery } from "lofidb/react";

const { results, loading, error } = useLofiQuery(db.todos);
const { results } = useLofiQuery(db.todos, query`completed=${false}`);
const { results } = useLofiQuery(db.todos, order`createdAt desc`);
const { results } = useLofiQuery(db.todos, query`completed=${false}`, order`createdAt desc`);
```

### `useLofiQueryRaw` (legacy)

Accepts raw `Filters` objects instead of template literals. You must stabilize `filters`, `order`, and `orderDirection` yourself (e.g. with `useMemo`) or they will cause infinite re-subscribes. Prefer `useLofiQuery` with the template literal API.

```tsx
import { useLofiQueryRaw } from "lofidb/react";

const { results, loading, error } = useLofiQueryRaw({
  collection: db.todos,
  filters,                        // optional: Filters
  order: ["createdAt"],           // optional
  orderDirection: ["desc"],       // optional
});
```

## Architecture

```
src/
  types.ts              — All shared types (DbAdapter, filters, schema, records)
  query.ts              — query`` and order`` tagged template literals
  FilterEngine.ts       — Filter matching (memory) + SQL generation (single source of truth)
  RelationshipGraph.ts  — Computes relationship paths, handles nested update propagation
  Subscription.ts       — Lightweight data holder for a single subscription's state
  SubscriptionManager.ts — Subscription lifecycle, refresh loop, dirty updates
  RecordHydrator.ts     — DB row → JS record conversion, DataLoader batching, hydration
  Collection.ts         — Thin CRUD orchestrator delegating to the above
  LofiDb.ts             — Schema registration, collection wiring, app lifecycle
  react.ts              — useLofiQuery hook (separate entry point, react is optional peer dep)
```

### Why this structure

**FilterEngine is the single source of truth for filter semantics.** Both in-memory `matches()` and SQL `toSql()` share the same `resolveValue()` (dynamic value unpacking) and `normalizeForComparison()` (type coercion). This eliminates the most common bug class: SQL/memory filter drift.

**RelationshipGraph replaces ad-hoc transitive closure computation** with a proper graph that has named methods (`getPathsTo`, `getAffectedParents`) and cycle detection.

**SubscriptionManager has one refresh loop**, not two duplicate implementations.

**No platform dependencies in the core.** React, React Native AppState, and Toast are all optional/injectable.

## Testing

```bash
npm test              # run all tests
npm run test:watch    # watch mode
npm run test:coverage # coverage report
```

161 tests across 4 suites covering query/order parsing (50), FilterEngine (71), RelationshipGraph (30), and SubscriptionManager (10).