import { useEffect, useState } from "react";
import { Collection } from "./Collection";
import { Filters, OrderDirection, SubscriptionRecord } from "./types";

interface LofiQueryResult<T> {
  results: T[];
  loading: boolean;
  error: string;
}

export interface UseLofiQueryArgs<
  B extends SubscriptionRecord,
  H extends SubscriptionRecord,
> {
  collection: Collection<B, H>;
  filters?: Filters;
  order?: string[];
  orderDirection?: OrderDirection;
}

/**
 * React hook that subscribes to a filtered collection query.
 * Re-renders the component whenever matching records change.
 *
 * ```tsx
 * import { useLofiQuery } from "lofidb/react";
 *
 * function MyComponent() {
 *   const { results, loading } = useLofiQuery({
 *     collection: db.todos,
 *     filters: [[["completed", "eq", { type: "constant", value: false }]]],
 *     order: ["createdAt"],
 *     orderDirection: ["desc"],
 *   });
 *
 *   if (loading) return <Spinner />;
 *   return results.map(todo => <TodoItem key={todo.id} todo={todo} />);
 * }
 * ```
 */
export function useLofiQuery<
  B extends SubscriptionRecord,
  H extends SubscriptionRecord,
>({
  collection,
  filters,
  order,
  orderDirection,
}: UseLofiQueryArgs<B, H>): LofiQueryResult<H> {
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
