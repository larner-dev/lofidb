import { useEffect, useRef, useState } from "react";
import { Collection } from "./Collection";
import { Filters, OrderDirection, SubscriptionRecord } from "./types";
import { ParsedQuery, ParsedOrder } from "./query";

interface LofiQueryResult<T> {
  results: T[];
  loading: boolean;
  error: string;
}

// ──────────────────────────────────────────────
// Overloaded signatures
// ──────────────────────────────────────────────

/**
 * Subscribe to a collection with no filters or ordering.
 *
 * ```ts
 * const { results } = useLofiQuery(db.todos);
 * ```
 */
export function useLofiQuery<
  B extends SubscriptionRecord,
  H extends SubscriptionRecord,
>(collection: Collection<B, H>): LofiQueryResult<H>;

/**
 * Subscribe with a query filter.
 *
 * ```ts
 * const { results } = useLofiQuery(db.todos, query`completed=${false}`);
 * ```
 */
export function useLofiQuery<
  B extends SubscriptionRecord,
  H extends SubscriptionRecord,
>(collection: Collection<B, H>, q: ParsedQuery): LofiQueryResult<H>;

/**
 * Subscribe with ordering only (no filter).
 *
 * ```ts
 * const { results } = useLofiQuery(db.todos, order`createdAt desc`);
 * ```
 */
export function useLofiQuery<
  B extends SubscriptionRecord,
  H extends SubscriptionRecord,
>(collection: Collection<B, H>, o: ParsedOrder): LofiQueryResult<H>;

/**
 * Subscribe with both a query filter and ordering.
 *
 * ```ts
 * const { results } = useLofiQuery(
 *   db.todos,
 *   query`completed=${false} AND priority>=${minPri}`,
 *   order`createdAt desc`,
 * );
 * ```
 */
export function useLofiQuery<
  B extends SubscriptionRecord,
  H extends SubscriptionRecord,
>(
  collection: Collection<B, H>,
  q: ParsedQuery,
  o: ParsedOrder,
): LofiQueryResult<H>;

// ──────────────────────────────────────────────
// Implementation
// ──────────────────────────────────────────────

export function useLofiQuery<
  B extends SubscriptionRecord,
  H extends SubscriptionRecord,
>(
  collection: Collection<B, H>,
  second?: ParsedQuery | ParsedOrder,
  third?: ParsedOrder,
): LofiQueryResult<H> {
  // Disambiguate overloads via _brand
  let filters: Filters | undefined;
  let ord: string[] | undefined;
  let ordDir: OrderDirection | undefined;
  let stableKey = "";

  if (second?._brand === "query") {
    filters = second.filters;
    stableKey = second.key;
  } else if (second?._brand === "order") {
    ord = second.order;
    ordDir = second.orderDirection;
    stableKey = second.key;
  }

  if (third?._brand === "order") {
    ord = third.order;
    ordDir = third.orderDirection;
    stableKey += "|" + third.key;
  }

  // Ref keeps the latest parsed values for the effect closure
  // without adding object references to the dependency array.
  const argsRef = useRef({ filters, ord, ordDir });
  argsRef.current = { filters, ord, ordDir };

  const existing = collection.subscriptions.getSubscription(
    filters,
    ord,
    ordDir,
  );

  const [state, setState] = useState<LofiQueryResult<H>>({
    results: existing ? existing.getResultList<H>() : [],
    loading: existing ? existing.loading : true,
    error: "",
  });

  useEffect(() => {
    const { filters: f, ord: o, ordDir: od } = argsRef.current;
    const { remove } = collection.subscriptions.subscribe(
      f,
      o,
      od,
      (newState) => setState(newState),
    );
    return remove;
    // stableKey changes if and only if an actual interpolated value
    // in the query or order changed. Template string parts (field
    // names, operators, AND/OR) are compile-time constants.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stableKey, collection]);

  return state;
}

// ──────────────────────────────────────────────
// Legacy API
// ──────────────────────────────────────────────

export interface UseLofiQueryRawArgs<
  B extends SubscriptionRecord,
  H extends SubscriptionRecord,
> {
  collection: Collection<B, H>;
  filters?: Filters;
  order?: string[];
  orderDirection?: OrderDirection;
}

/**
 * Legacy hook that accepts raw Filters objects.
 *
 * ⚠️  You must stabilize `filters`, `order`, and `orderDirection`
 * yourself (e.g. with useMemo) or they will cause infinite
 * re-subscribes. Prefer `useLofiQuery` with the template literal API.
 */
export function useLofiQueryRaw<
  B extends SubscriptionRecord,
  H extends SubscriptionRecord,
>({
  collection,
  filters,
  order,
  orderDirection,
}: UseLofiQueryRawArgs<B, H>): LofiQueryResult<H> {
  const existing = collection.subscriptions.getSubscription(
    filters,
    order,
    orderDirection,
  );

  const [state, setState] = useState<LofiQueryResult<H>>({
    results: existing ? existing.getResultList<H>() : [],
    loading: existing ? existing.loading : true,
    error: "",
  });

  useEffect(() => {
    const { remove } = collection.subscriptions.subscribe(
      filters,
      order,
      orderDirection,
      (newState) => setState(newState),
    );
    return remove;
  }, [filters, order, orderDirection, collection]);

  return state;
}
