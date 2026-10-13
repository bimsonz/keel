import { env } from "cloudflare:workers";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import {
  type Bucket,
  type Rehoming,
  rehome,
  unsettled,
} from "../../../../scripts/lib/rehome-r2.ts";

/** A personal org and the user whose namespace takes its objects, neither seen before. */
const pair = (handle = "someone"): Rehoming => ({
  from: `org_${ulid()}`,
  to: `usr_${ulid()}`,
  handle,
});

const buckets = { bundles: env.BUNDLES, archive: env.ARCHIVE };

const keysUnder = async (bucket: R2Bucket, prefix: string): Promise<string[]> =>
  (await bucket.list({ prefix })).objects.map((object) => object.key).toSorted();

const textAt = async (bucket: R2Bucket, key: string): Promise<string | undefined> =>
  (await bucket.get(key))?.text();

const versionAt = async (bucket: R2Bucket, key: string): Promise<string | undefined> =>
  (await bucket.head(key))?.version;

/** One namespace's objects as Keel writes them: a bundle and a pointer, a plan and a record. */
async function lived(namespace: string): Promise<void> {
  await env.BUNDLES.put(`ns/${namespace}/bundles/aa11`, `bundle of ${namespace}`, {
    httpMetadata: { contentType: "application/gzip" },
  });
  await env.BUNDLES.put(`ns/${namespace}/deps/bb22`, "aa11", {
    customMetadata: { toolchain: "node v22 pnpm 11" },
  });
  await env.ARCHIVE.put(`ns/${namespace}/plans/cc33`, `{"plan":"${namespace}"}`, {
    httpMetadata: { contentType: "application/json" },
  });
  await env.ARCHIVE.put(`ns/${namespace}/evidence/dd44`, `{"evidence":"${namespace}"}`, {
    httpMetadata: { contentType: "application/json" },
  });
}

const LIVED = ["bundles/aa11", "deps/bb22"] as const;
const ARCHIVED = ["evidence/dd44", "plans/cc33"] as const;

/** `real`, except that the first `times` looks at a key find nothing there. */
const blindAtFirst = (real: R2Bucket, times: number): Bucket => {
  let looks = 0;
  return {
    list: (options) => real.list(options),
    get: (key) => real.get(key),
    put: (key, value, options) => real.put(key, value, options),
    head: async (key) => ((looks += 1) <= times ? null : real.head(key)),
  };
};

describe("carrying a namespace's objects to its new id", () => {
  it("[rehome.copy] writes every object of both buckets under the new id, with its bytes and metadata, and leaves the old ones", async () => {
    const { from, to, handle } = pair();
    await lived(from);

    const moves = await rehome(buckets, [{ from, to, handle }], { apply: true });

    expect(moves).toEqual([
      ...LIVED.map((rest) => ({
        bucket: "bundles",
        source: `ns/${from}/${rest}`,
        destination: `ns/${to}/${rest}`,
        size: expect.any(Number),
        state: "copied",
      })),
      ...ARCHIVED.map((rest) => ({
        bucket: "archive",
        source: `ns/${from}/${rest}`,
        destination: `ns/${to}/${rest}`,
        size: expect.any(Number),
        state: "copied",
      })),
    ]);
    expect(await textAt(env.BUNDLES, `ns/${to}/bundles/aa11`)).toBe(`bundle of ${from}`);
    expect(await textAt(env.BUNDLES, `ns/${to}/deps/bb22`)).toBe("aa11");
    expect(await textAt(env.ARCHIVE, `ns/${to}/plans/cc33`)).toBe(`{"plan":"${from}"}`);
    expect(await textAt(env.ARCHIVE, `ns/${to}/evidence/dd44`)).toBe(`{"evidence":"${from}"}`);
    const bundle = await env.BUNDLES.head(`ns/${to}/bundles/aa11`);
    expect(bundle?.httpMetadata?.contentType).toBe("application/gzip");
    const pointer = await env.BUNDLES.head(`ns/${to}/deps/bb22`);
    expect(pointer?.customMetadata).toEqual({ toolchain: "node v22 pnpm 11" });
    expect(await keysUnder(env.BUNDLES, `ns/${from}/`)).toEqual(
      LIVED.map((rest) => `ns/${from}/${rest}`),
    );
    expect(await keysUnder(env.ARCHIVE, `ns/${from}/`)).toEqual(
      ARCHIVED.map((rest) => `ns/${from}/${rest}`),
    );
  });

  it("[rehome.dry] names every copy it would make and writes nothing", async () => {
    const { from, to, handle } = pair();
    await lived(from);

    const moves = await rehome(buckets, [{ from, to, handle }], { apply: false });

    expect(moves.map((move) => move.state)).toEqual(["copy", "copy", "copy", "copy"]);
    expect(moves.map((move) => move.destination).toSorted()).toEqual(
      [...LIVED, ...ARCHIVED].map((rest) => `ns/${to}/${rest}`).toSorted(),
    );
    expect(await keysUnder(env.BUNDLES, `ns/${to}/`)).toEqual([]);
    expect(await keysUnder(env.ARCHIVE, `ns/${to}/`)).toEqual([]);
  });

  it("[rehome.again] copies nothing the second time and rewrites nothing", async () => {
    const { from, to, handle } = pair();
    await lived(from);
    await rehome(buckets, [{ from, to, handle }], { apply: true });
    const written = await versionAt(env.BUNDLES, `ns/${to}/bundles/aa11`);
    expect(written).toBeDefined();

    const again = await rehome(buckets, [{ from, to, handle }], { apply: true });

    expect(again.map((move) => move.state)).toEqual(["same", "same", "same", "same"]);
    expect(again.some(unsettled)).toBe(false);
    expect(await versionAt(env.BUNDLES, `ns/${to}/bundles/aa11`)).toBe(written);
  });

  it("[rehome.differs] leaves a destination that holds other bytes, says so, and still copies the rest", async () => {
    const { from, to, handle } = pair();
    await lived(from);
    await env.BUNDLES.put(`ns/${to}/deps/bb22`, "ee55");
    const before = await versionAt(env.BUNDLES, `ns/${to}/deps/bb22`);

    const moves = await rehome(buckets, [{ from, to, handle }], { apply: true });

    expect(moves.map((move) => move.state)).toEqual(["copied", "differs", "copied", "copied"]);
    expect(moves.filter(unsettled).map((move) => move.destination)).toEqual([`ns/${to}/deps/bb22`]);
    expect(await textAt(env.BUNDLES, `ns/${to}/deps/bb22`)).toBe("ee55");
    expect(await versionAt(env.BUNDLES, `ns/${to}/deps/bb22`)).toBe(before);
  });

  it("[rehome.each-to-its-own] carries each org to its own user, and no org the mapping does not name", async () => {
    const first = pair("first");
    const second = pair("second");
    const bystander = pair("bystander");
    await lived(first.from);
    await lived(second.from);
    await lived(bystander.from);

    await rehome(buckets, [first, second], { apply: true });

    expect(await textAt(env.BUNDLES, `ns/${first.to}/bundles/aa11`)).toBe(
      `bundle of ${first.from}`,
    );
    expect(await textAt(env.BUNDLES, `ns/${second.to}/bundles/aa11`)).toBe(
      `bundle of ${second.from}`,
    );
    expect(await textAt(env.ARCHIVE, `ns/${second.to}/plans/cc33`)).toBe(
      `{"plan":"${second.from}"}`,
    );
    expect(await keysUnder(env.BUNDLES, `ns/${bystander.to}/`)).toEqual([]);
    expect(await keysUnder(env.ARCHIVE, `ns/${bystander.to}/`)).toEqual([]);
    expect(await keysUnder(env.BUNDLES, `ns/${first.to}/`)).toEqual(
      LIVED.map((rest) => `ns/${first.to}/${rest}`),
    );
  });

  it("[rehome.pages] carries a namespace whose listing takes several calls", async () => {
    const { from, to, handle } = pair();
    const names = ["a", "b", "c", "d", "e", "f", "g"].map((letter) => `bundles/${letter}`);
    await Promise.all(names.map((name) => env.BUNDLES.put(`ns/${from}/${name}`, name)));

    const moves = await rehome({ bundles: env.BUNDLES }, [{ from, to, handle }], {
      apply: true,
      page: 3,
    });

    expect(moves.map((move) => move.state)).toEqual(names.map(() => "copied"));
    expect(await keysUnder(env.BUNDLES, `ns/${to}/`)).toEqual(
      names.map((name) => `ns/${to}/${name}`),
    );
  });

  it("[rehome.checked] stores nothing when the bytes read are not the source's", async () => {
    const { from, to, handle } = pair();
    await env.BUNDLES.put(`ns/${from}/bundles/aa11`, "the bundle");
    const garbling: Bucket = {
      list: (options) => env.BUNDLES.list(options),
      head: (key) => env.BUNDLES.head(key),
      put: (key, value, options) => env.BUNDLES.put(key, value, options),
      get: async (key) => {
        const real = await env.BUNDLES.get(key);
        return real === null
          ? null
          : {
              key: real.key,
              size: real.size,
              etag: real.etag,
              arrayBuffer: () => new Response("THE bundle").arrayBuffer(),
            };
      },
    };

    await expect(
      rehome({ bundles: garbling }, [{ from, to, handle }], { apply: true }),
    ).rejects.toThrow(/MD5/);

    expect(await keysUnder(env.BUNDLES, `ns/${to}/`)).toEqual([]);
  });

  it("[rehome.in-parts] leaves an object uploaded in parts, in a dry run and a real one, and says so", async () => {
    const { from, to, handle } = pair();
    const upload = await env.BUNDLES.createMultipartUpload(`ns/${from}/bundles/aa11`);
    await upload.complete([await upload.uploadPart(1, "one part")]);

    const dry = await rehome({ bundles: env.BUNDLES }, [{ from, to, handle }], { apply: false });
    const real = await rehome({ bundles: env.BUNDLES }, [{ from, to, handle }], { apply: true });

    expect(dry.map((move) => move.state)).toEqual(["in-parts"]);
    expect(real.map((move) => move.state)).toEqual(["in-parts"]);
    expect(real.every(unsettled)).toBe(true);
    expect(await keysUnder(env.BUNDLES, `ns/${to}/`)).toEqual([]);
  });

  it("[rehome.raced] never writes over a destination that appeared after it looked", async () => {
    const equal = pair("equal");
    const other = pair("other");
    await env.BUNDLES.put(`ns/${equal.from}/bundles/aa11`, "the bundle");
    await env.BUNDLES.put(`ns/${equal.to}/bundles/aa11`, "the bundle");
    await env.BUNDLES.put(`ns/${other.from}/deps/bb22`, "aa11");
    await env.BUNDLES.put(`ns/${other.to}/deps/bb22`, "ee55");
    const before = [
      await versionAt(env.BUNDLES, `ns/${equal.to}/bundles/aa11`),
      await versionAt(env.BUNDLES, `ns/${other.to}/deps/bb22`),
    ];

    const sameBytes = await rehome({ bundles: blindAtFirst(env.BUNDLES, 1) }, [equal], {
      apply: true,
    });
    const otherBytes = await rehome({ bundles: blindAtFirst(env.BUNDLES, 1) }, [other], {
      apply: true,
    });

    expect(sameBytes.map((move) => move.state)).toEqual(["same"]);
    expect(otherBytes.map((move) => move.state)).toEqual(["differs"]);
    expect(await textAt(env.BUNDLES, `ns/${other.to}/deps/bb22`)).toBe("ee55");
    expect([
      await versionAt(env.BUNDLES, `ns/${equal.to}/bundles/aa11`),
      await versionAt(env.BUNDLES, `ns/${other.to}/deps/bb22`),
    ]).toEqual(before);
  });
});
