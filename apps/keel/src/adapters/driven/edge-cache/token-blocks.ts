import type { TokenBlocks } from "../../driving/http/token-limits.ts";

/** Where a blocked address is marked: a name in the colo's cache that no request can fetch. */
const markOf = (address: string) =>
  new Request(`https://token-blocks.keel.invalid/${encodeURIComponent(address)}`);

/**
 * The addresses refused token exchanges, marked in the colo's cache
 * (`caches.default`) for the rest of the window: read before the provider is
 * asked, and gone when the mark expires. The limiter that counts the failures
 * is the colo's too, so the mark lives where the count did.
 */
export function cachedTokenBlocks(cache: Cache): TokenBlocks {
  return {
    has: async (address) => (await cache.match(markOf(address))) !== undefined,
    add: async (address, seconds) =>
      cache.put(
        markOf(address),
        new Response(null, { headers: { "cache-control": `max-age=${seconds}` } }),
      ),
  };
}
