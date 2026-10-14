// How an operator script reads the Cloudflare API's failures: an answer that
// refused, as against a request that got no answer at all. Nothing here calls
// Cloudflare: `scripts/env.ts` does, and a script hands in the call, so a test
// can reach every decision without an account.

/** The API answered, and not with success: its status tells a missing resource from a refusal or an outage. */
export class ApiRefused extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiRefused";
    this.status = status;
  }
}

/** How long to wait before each retry of a request that got no good answer: four tries in about seven seconds. */
export const STORE_BACKOFF_MS: readonly number[] = [1_000, 2_000, 4_000];

/** Whether a failure says nothing of the store: no answer at all (a connect timeout, a reset), or the API's own 429 or 5xx. */
const untold = (error: unknown): boolean =>
  !(error instanceof ApiRefused) || error.status === 429 || error.status >= 500;

/**
 * Checks that the store `path` names exists, failing loudly with what to do.
 * Only the API's 404 says it does not exist. A request that got no answer, or a
 * 429 or 5xx, is tried again after each of `backoff`, then named unreachable,
 * which says nothing of the store. Any other answer is named as it came.
 */
export async function verifyStore(
  get: (path: string) => Promise<unknown>,
  path: string,
  store: { readonly name: string; readonly missing: string },
  wait: (ms: number) => Promise<void> = (ms) => new Promise((done) => setTimeout(done, ms)),
  backoff: readonly number[] = STORE_BACKOFF_MS,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await get(path);
      return;
    } catch (error) {
      if (error instanceof ApiRefused && error.status === 404)
        throw new Error(`${store.name} does not exist; ${store.missing}`, { cause: error });
      if (!untold(error))
        throw new Error(`${store.name} could not be checked: the API refused it`, { cause: error });
      const delay = backoff[attempt];
      if (delay === undefined)
        throw new Error(
          `${store.name} could not be checked: the Cloudflare API was unreachable in ${attempt + 1} tries, which says nothing of whether it exists; deploy again`,
          { cause: error },
        );
      await wait(delay);
    }
  }
}
