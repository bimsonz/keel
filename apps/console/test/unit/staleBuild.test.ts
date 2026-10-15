import { describe, expect, it } from "vitest";
import { AGAIN_MS, reloadOnce } from "../../src/staleBuild.ts";

/** A session's storage, kept in a map. */
const kept = () => {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  };
};

/** Storage the browser refuses to the page. */
const refused = () => {
  throw new Error("storage refused");
};

describe("a page whose build a deploy has replaced", () => {
  it("[stale.once] loads itself again once for a missing file, not again within AGAIN_MS, and again after it", () => {
    const storage = kept();
    const reloads: number[] = [];
    const tried = [0, 1_000, AGAIN_MS + 1].map((now) =>
      reloadOnce(
        () => storage,
        now,
        () => reloads.push(now),
      ),
    );
    expect(tried).toEqual([true, false, true]);
    expect(reloads).toEqual([0, AGAIN_MS + 1]);
  });

  it("[stale.no-storage] never loads itself again where it cannot keep when it last did", () => {
    let reloaded = false;
    expect(reloadOnce(refused, 0, () => (reloaded = true))).toBe(false);
    expect(reloaded).toBe(false);
  });
});
