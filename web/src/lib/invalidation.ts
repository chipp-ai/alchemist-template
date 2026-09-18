/**
 * `invalidateEntity(entity)`: refresh every cached view derived from one
 * server entity. The dependents live in `invalidation-map.ts` (pure data,
 * shared with the lint test); this module is the runtime side that talks
 * to the query cache.
 *
 * Prefer this over a hand-written list of `invalidateQueries(...)` calls
 * in a mutation. When a mutation changes more than one entity, call it
 * once per entity.
 */
import { invalidateQueries } from "./query.svelte";
import { ENTITY_DEPENDENTS, type InvalidationEntity } from "./invalidation-map";

export function invalidateEntity(entity: InvalidationEntity): void {
  for (const prefix of ENTITY_DEPENDENTS[entity]) invalidateQueries(prefix);
}

export type { InvalidationEntity };
