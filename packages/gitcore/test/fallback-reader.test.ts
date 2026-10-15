// FallbackReader over readers that count their calls: what a restack's reads
// cost when each member's objects live only in its own workspace.

import { describe, expect, it } from "vitest";
import { FallbackReader } from "../src/compose.ts";
import { MissingObject } from "../src/diff.ts";
import type { ObjectReader } from "../src/merge.ts";

const missing = (oid: string) => Promise.reject(new MissingObject(oid));

/** A repo holding `oids` as one-byte blobs, counting every read it is asked for. */
function counted(oids: ReadonlySet<string>, calls: { n: number }): ObjectReader {
  return {
    readBlob: (oid) => {
      calls.n += 1;
      return oids.has(oid) ? Promise.resolve(new Uint8Array([1])) : missing(oid);
    },
    readTree: (oid) => {
      calls.n += 1;
      return missing(oid);
    },
    readCommit: (oid) => {
      calls.n += 1;
      return missing(oid);
    },
  };
}

/**
 * The reads a restack of `members` members makes: for each member in turn,
 * `pairs` reads alternating between trunk's objects (in staging) and the
 * member's own (in its workspace). Answers how many reader calls they took.
 */
async function restackReads(members: number, pairs: number): Promise<number> {
  const calls = { n: 0 };
  const staging = new Set(Array.from({ length: pairs }, (_, i) => `trunk-${i}`));
  const workspaces = Array.from(
    { length: members },
    (_, m) => new Set(Array.from({ length: pairs }, (__, i) => `m${m}-${i}`)),
  );
  const reader = new FallbackReader([
    counted(staging, calls),
    ...workspaces.map((oids) => counted(oids, calls)),
  ]);
  for (let m = 0; m < members; m++)
    for (let i = 0; i < pairs; i++) {
      await reader.readBlob(`trunk-${i}`);
      await reader.readBlob(`m${m}-${i}`);
    }
  return calls.n;
}

describe("FallbackReader", () => {
  it("[composer.reads-linear] a restack's reads cost about one miss each, whatever the batch's size: a batch twice as large takes about twice the reader calls, not four times", async () => {
    const pairs = 20;
    const [sixteen, thirtyTwo] = [await restackReads(16, pairs), await restackReads(32, pairs)];
    // Each read takes at most two calls, plus one pass over the readers for a member's first object.
    expect(sixteen).toBeLessThanOrEqual(16 * pairs * 2 * 2 + (16 * 17) / 2);
    expect(thirtyTwo / sixteen).toBeLessThan(2.5);
  });

  it("[composer.reads-found] every object is read from the reader holding it, wherever it stands, and one no reader holds is missing", async () => {
    const calls = { n: 0 };
    const reader = new FallbackReader([
      counted(new Set(["a"]), calls),
      counted(new Set(["b"]), calls),
      counted(new Set(["c"]), calls),
    ]);
    for (const oid of ["c", "a", "b", "c", "c", "a"])
      expect(await reader.readBlob(oid)).toEqual(new Uint8Array([1]));
    await expect(reader.readBlob("d")).rejects.toThrow(MissingObject);
  });
});
