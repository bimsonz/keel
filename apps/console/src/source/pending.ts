// Whether the console is still waiting on Keel, for a page that shows its skeleton meanwhile. The reads are the
// ones the cache makes (cache.ts); the project's log is the player's, and says itself when it is read
// (`player.loaded`).

import { useIsFetching } from "@tanstack/react-query";

/**
 * Whether any read of Keel whose key begins with `prefix` is on its way: `["repo"]` for the code, `["project"]`
 * for the project itself, or any read at all with none.
 */
export function usePending(prefix: readonly string[] = []): boolean {
  return useIsFetching(prefix.length === 0 ? {} : { queryKey: prefix }) > 0;
}
