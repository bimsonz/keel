import { describe, expect, it } from "vitest";
import { ApiRefused, STORE_BACKOFF_MS, verifyStore } from "../../../scripts/lib/cloudflare-api.ts";

/**
 * The deploy's check that each store a Worker binds exists, as `scripts/deploy.ts`
 * runs it, with the API's call and the wait handed in: what a 404, a request
 * with no answer and any other refusal each make of it.
 */
const BUCKET = { name: "keel: R2 bucket keel-bundles", missing: "declare it in infra/staging" };
const PATH = "/r2/buckets/keel-bundles";

/** A call that fails with each of `failures` in turn, then answers; and every path it was asked. */
function calls(...failures: readonly unknown[]) {
  const asked: string[] = [];
  const get = async (path: string): Promise<unknown> => {
    asked.push(path);
    const failure = failures[asked.length - 1];
    if (failure !== undefined) throw failure;
    return { name: "keel-bundles" };
  };
  return { get, asked };
}

/** A wait that returns at once, keeping each delay it was asked for. */
function waits() {
  const waited: number[] = [];
  return { wait: async (ms: number) => void waited.push(ms), waited };
}

const noAnswer = () =>
  new TypeError("fetch failed", {
    cause: new Error("Connect Timeout Error (api.cloudflare.com:443)"),
  });
const answered = (status: number) =>
  new ApiRefused(status, `GET ${PATH}: ${status} {"success":false}`);

describe("the deploy's store check", () => {
  it("[deploy.store-missing] the API's 404 says the store does not exist, with what to do, at once", async () => {
    const { get, asked } = calls(answered(404));
    const { wait, waited } = waits();
    await expect(verifyStore(get, PATH, BUCKET, wait)).rejects.toThrow(
      "keel: R2 bucket keel-bundles does not exist; declare it in infra/staging",
    );
    expect([asked.length, waited]).toEqual([1, []]);
  });

  it("[deploy.store-unreachable] a request with no answer, or a 429 or 5xx, is tried again after each backoff, then named unreachable and never missing; an answer on a retry passes", async () => {
    const always = calls(...Array.from({ length: STORE_BACKOFF_MS.length + 1 }, noAnswer));
    const told = waits();
    const failure = verifyStore(always.get, PATH, BUCKET, told.wait);
    await expect(failure).rejects.toThrow(
      "keel: R2 bucket keel-bundles could not be checked: the Cloudflare API was unreachable in 4 tries",
    );
    await expect(failure).rejects.not.toThrow(/does not exist/);
    expect([always.asked.length, told.waited]).toEqual([4, [1_000, 2_000, 4_000]]);

    const recovered = calls(noAnswer(), answered(503), answered(429));
    const again = waits();
    await expect(verifyStore(recovered.get, PATH, BUCKET, again.wait)).resolves.toBeUndefined();
    expect([recovered.asked, again.waited]).toEqual([
      [PATH, PATH, PATH, PATH],
      [1_000, 2_000, 4_000],
    ]);
  });

  it("[deploy.store-refused] any other answer, a 403, is named as refused, not missing, and not tried again", async () => {
    const { get, asked } = calls(answered(403));
    const { wait, waited } = waits();
    const failure = verifyStore(get, PATH, BUCKET, wait);
    await expect(failure).rejects.toThrow(
      "keel: R2 bucket keel-bundles could not be checked: the API refused it",
    );
    await expect(failure).rejects.toMatchObject({ cause: { status: 403 } });
    expect([asked.length, waited]).toEqual([1, []]);
  });
});
