// One cache for the console's reads of Keel. A read already in flight is shared by everyone who asks for it at
// once, so a page and the link that led to it never ask twice; an answer still fresh is served from memory; and
// what can never change (a commit, and a directory or a file at one) is kept for the whole visit. Nothing is
// kept beyond the page: Keel answers whoever is signed in, and that can change between two visits.

import { QueryClient, type QueryKey } from "@tanstack/react-query";

/** How long an answer that can change is served from memory before Keel is asked again. */
export const FRESH_MS = 30_000;

/** How long an answer that cannot change is served: a read at a commit, or a commit itself. */
export const FOREVER = Number.POSITIVE_INFINITY;

/** The console's own cache, shared by every source and directory it makes. */
export const readCache = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: FRESH_MS,
      gcTime: 30 * 60_000,
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

/** Whether `ref` names one commit by its id, so that what is read at it never changes. */
export const pinned = (ref: string | undefined): boolean =>
  ref !== undefined && /^([0-9a-f]{40}|[0-9a-f]{64})$/.test(ref);

const nothing = (): void => undefined;

/**
 * Settles as `answer` does, or refuses as soon as `signal` aborts. The read goes on for whoever else asked for
 * it, and its answer is kept for the next to ask.
 */
function untilAborted<T>(answer: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return answer;
  if (signal.aborted) return Promise.reject(signal.reason);
  let abort: () => void = nothing;
  const aborted = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  return Promise.race([answer, aborted]).finally(() => signal.removeEventListener("abort", abort));
}

/**
 * Keel's answer to the read `key` names: asked once however many ask at a time, and served from memory for
 * `staleTime` after it came. A refusal is not kept: the next to ask asks Keel again. With no cache, `read`
 * is simply made.
 */
export function cachedRead<T>(
  cache: QueryClient | undefined,
  key: QueryKey,
  read: (signal: AbortSignal | undefined) => Promise<T>,
  staleTime: number,
  signal?: AbortSignal,
): Promise<T> {
  if (cache === undefined) return read(signal);
  return untilAborted(
    cache.fetchQuery({ queryKey: key, queryFn: ({ signal: own }) => read(own), staleTime }),
    signal,
  );
}
