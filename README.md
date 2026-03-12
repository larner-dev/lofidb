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
// Create
await db.todos.create({
  id: "todo-1",
  title: "Buy milk",
  completed: false,
  categoryId: "cat-1",
  createdAt: new Date(),
});

// Update
await db.todos.update("todo-1", { completed: true });

// Upsert (update if exists, create if not)
await db.todos.upsert({ id: "todo-1", title: "Buy oat milk", ... });

// Delete
await db.todos.delete("todo-1");

// Fetch one
const todo = await db.todos.fetchOrThrow("todo-1");
```

All CRUD operations automatically notify active subscriptions.

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
db.on("create", ({ collection, id, after }) => {
  console.log(`Created ${collection} ${id}`);
});

db.on("update", ({ collection, id, before, after }) => {
  console.log(`Updated ${collection} ${id}`);
});

db.on("delete", ({ collection, id, before }) => {
  console.log(`Deleted ${collection} ${id}`);
});
```

Or at the collection level:

```typescript
db.todos.on("create", ({ id, after, input }) => {
  // Sync to server, etc.
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