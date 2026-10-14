import { describe, expect, it } from "vitest";
import {
  BUNDLE_MANIFEST,
  BUNDLE_ROOT,
  type BundleFile,
  BundleRefused,
  BundleUnreadable,
  readBundle,
  sha256Hex,
  writeBundle,
} from "../src/index.ts";
import * as oracle from "./support/bundle-oracle.ts";
import { fc } from "./support/fast-check.ts";

// The writer streams the archive into gzip in 64 KiB pieces, and the reader
// takes it apart as it unpacks; the oracle is both as they were, built whole.
// These hold the bundle's bytes, and every answer a reader gives, unchanged.

const enc = new TextEncoder();

const gzip = async (tar: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(
    await new Response(
      new Blob([tar.slice()]).stream().pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer(),
  );

const joined = (...parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/** Where two byte strings first differ, or -1 when they are equal. */
const firstDifference = (a: Uint8Array, b: Uint8Array): number => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : Math.min(a.length, b.length);
};

/** Fills `bytes` from `seed` (xorshift): noise, or text of four letters, which gzip shrinks. */
const fill = (bytes: Uint8Array, seed: number, text: boolean): Uint8Array => {
  let x = seed | 1;
  for (let i = 0; i < bytes.length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    bytes[i] = text ? 97 + ((x >>> 0) % 4) : x & 0xff;
  }
  return bytes;
};

/** Segments of a safe path: plain names, and names in other scripts (several bytes a character, some a surrogate pair). */
const segment = fc
  .oneof(
    fc.stringMatching(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,30}$/),
    fc.string({
      unit: fc.constantFrom("a", "-", "é", "ß", "Ω", "日", "本", "😀", "🧭"),
      minLength: 1,
      maxLength: 30,
    }),
  )
  .filter((s) => s !== "." && s !== "..");

/** A safe path, some long enough in bytes to need a PAX header. */
const pathArb = fc
  .array(segment, { minLength: 1, maxLength: 6 })
  .map((s) => s.join("/"))
  .filter((p) => p !== BUNDLE_MANIFEST);

/** File sizes: empty, either side of a block, pieces' worth, and large enough to span several pieces. */
const sizeArb = (large: boolean) =>
  fc.oneof(
    { weight: 3, arbitrary: fc.constantFrom(0, 1, 100, 511, 512, 513, 1023, 1024, 1025) },
    { weight: 3, arbitrary: fc.nat(4_000) },
    {
      weight: 1,
      arbitrary: large ? fc.constantFrom(65_535, 65_536, 65_537, 131_072) : fc.nat(20_000),
    },
    {
      weight: 1,
      arbitrary: large ? fc.integer({ min: 60_000, max: 200_000 }) : fc.nat(40_000),
    },
  );

/**
 * A set of files with distinct safe paths, each its own buffer or, when
 * `shared`, every one a view into one buffer (overlapping, as subarrays may).
 */
const filesArb = (large: boolean): fc.Arbitrary<BundleFile[]> =>
  fc
    .record({
      specs: fc.uniqueArray(
        fc.record({
          path: pathArb,
          size: sizeArb(large),
          seed: fc.nat(),
          text: fc.boolean(),
          at: fc.nat(),
          executable: fc.option(fc.boolean(), { nil: undefined }),
        }),
        { selector: (f) => f.path, maxLength: 6 },
      ),
      shared: fc.boolean(),
      seed: fc.nat(),
    })
    .map(({ specs, shared, seed }) => {
      const pool = fill(
        new Uint8Array(Math.max(0, ...specs.map((s) => s.size)) + 4_096),
        seed,
        false,
      );
      return specs.map((s) => ({
        path: s.path,
        bytes: shared
          ? pool.subarray(s.at % (pool.length - s.size + 1)).subarray(0, s.size)
          : fill(new Uint8Array(s.size), s.seed, s.text),
        ...(s.executable === undefined ? {} : { executable: s.executable }),
      }));
    });

/** How a writer answered: the bundle, or the reason it refused. */
const written = async (
  write: (files: readonly BundleFile[]) => Promise<Uint8Array>,
  files: readonly BundleFile[],
): Promise<{ bundle: Uint8Array } | { refused: string }> => {
  try {
    return { bundle: await write(files) };
  } catch (error) {
    if (error instanceof BundleRefused) return { refused: error.reason };
    throw error;
  }
};

/** How a reader answered: its files (each bytes by length and sha256), or the reason it could not read. */
const read = async (
  reader: (bytes: Uint8Array) => Promise<BundleFile[]>,
  bytes: Uint8Array,
): Promise<unknown> => {
  try {
    const files = await reader(bytes);
    return {
      files: await Promise.all(
        files.map(async (f) => ({
          path: f.path,
          executable: f.executable,
          length: f.bytes.length,
          sha256: await sha256Hex(f.bytes),
        })),
      ),
    };
  } catch (error) {
    if (error instanceof BundleUnreadable) return { unreadable: error.reason };
    throw error;
  }
};

describe("the streaming writer", () => {
  it("[bundle.stream-equal] writes the bytes the whole-archive writer wrote, and leaves its input as it was", async () => {
    await fc.assert(
      fc.asyncProperty(filesArb(true), async (files) => {
        const before = files.map((f) => f.bytes.slice());
        const ours = await writeBundle(files);
        const theirs = await oracle.writeBundle(files);
        expect(firstDifference(ours, theirs)).toBe(-1);
        expect(files.map((f, i) => firstDifference(f.bytes, before[i] ?? theirs))).toEqual(
          files.map(() => -1),
        );
      }),
      { numRuns: 100 },
    );
  });

  it("[bundle.stream-equal] refuses the paths the whole-archive writer refused, for the same reasons", async () => {
    const unsafe = fc.constantFrom(
      "",
      "/etc/passwd",
      "../up",
      "a/../b",
      "a//b",
      "./a",
      "a/",
      "nul\0byte",
      "line\nbreak",
      BUNDLE_MANIFEST,
    );
    await fc.assert(
      fc.asyncProperty(
        filesArb(false),
        fc.oneof(
          unsafe.map((path) => ({ path })),
          fc.nat().map((which) => ({ which })),
        ),
        fc.nat(),
        async (files, bad, where) => {
          const path =
            "path" in bad ? bad.path : (files[bad.which % Math.max(1, files.length)]?.path ?? "");
          const all = files.toSpliced(where % (files.length + 1), 0, {
            path,
            bytes: enc.encode("x"),
          });
          const ours = await written(writeBundle, all);
          expect(ours).toEqual({ refused: expect.any(String) });
          expect(ours).toEqual(await written(oracle.writeBundle, all));
        },
      ),
      { numRuns: 100 },
    );
  });
});

/** The offsets of an archive's headers, up to its end marker. */
const headersOf = (tar: Uint8Array): number[] => {
  const offsets: number[] = [];
  for (let at = 0; at + 512 <= tar.length && tar.subarray(at, at + 512).some((b) => b !== 0);) {
    offsets.push(at);
    const size = Number.parseInt(new TextDecoder().decode(tar.subarray(at + 124, at + 135)), 8);
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return offsets;
};

/** Sets a header's checksum to what its bytes now sum to. */
const resum = (tar: Uint8Array, at: number): void => {
  tar.fill(32, at + 148, at + 156);
  const sum = tar.subarray(at, at + 512).reduce((t, b) => t + b, 0);
  tar.set(enc.encode(`${sum.toString(8).padStart(6, "0")}\0 `), at + 148);
};

/**
 * What can happen to a bundle on its way to a reader, or be made to look like
 * one: nothing; cut short; a byte flipped anywhere, or in the gzip trailer;
 * bytes appended; or a valid gzip of its archive cut short, with a byte
 * flipped, or with bytes after its end marker (and then, perhaps, a bad
 * trailer, found only after the reader has seen the whole archive). Or a
 * header rewritten, its checksum made right again: any byte of it, its type,
 * its name another header's, or its name one a reader must refuse.
 */
const alterationArb = fc.oneof(
  fc.constant({ kind: "none" as const }),
  fc.record({ kind: fc.constant("cut" as const), at: fc.nat() }),
  fc.record({
    kind: fc.constant("flip" as const),
    at: fc.nat(),
    mask: fc.integer({ min: 1, max: 255 }),
  }),
  fc.record({
    kind: fc.constant("trailer" as const),
    at: fc.nat(7),
    mask: fc.integer({ min: 1, max: 255 }),
  }),
  fc.record({
    kind: fc.constant("append" as const),
    bytes: fc.uint8Array({ minLength: 1, maxLength: 24 }),
  }),
  fc.record({ kind: fc.constant("tar-cut" as const), at: fc.nat() }),
  fc.record({
    kind: fc.constant("tar-flip" as const),
    at: fc.nat(),
    mask: fc.integer({ min: 1, max: 255 }),
  }),
  fc.record({
    kind: fc.constant("tar-field" as const),
    header: fc.nat(),
    at: fc.nat(511),
    value: fc.oneof(fc.nat(255), fc.constantFrom(0, 32, 48, 55, 120)),
  }),
  fc.record({
    kind: fc.constant("tar-type" as const),
    header: fc.nat(),
    type: fc.constantFrom("x", "2", "5", "g", "0", "\0"),
  }),
  fc.record({ kind: fc.constant("tar-name" as const), from: fc.nat(), to: fc.nat() }),
  fc.record({
    kind: fc.constant("tar-path" as const),
    header: fc.nat(),
    name: fc.constantFrom(
      `${BUNDLE_ROOT}/../up`,
      `${BUNDLE_ROOT}/a//b`,
      `${BUNDLE_ROOT}/./a`,
      `${BUNDLE_ROOT}/`,
      `${BUNDLE_ROOT}/${BUNDLE_MANIFEST}`,
      `elsewhere/${BUNDLE_MANIFEST}`,
    ),
  }),
  fc.record({
    kind: fc.constant("tar-past-end" as const),
    length: fc.integer({ min: 32_768, max: 98_304 }),
    seed: fc.nat(),
    trailer: fc.option(fc.record({ at: fc.nat(7), mask: fc.integer({ min: 1, max: 255 }) }), {
      nil: undefined,
    }),
  }),
);

type Alteration = typeof alterationArb extends fc.Arbitrary<infer A> ? A : never;

const flipped = (bytes: Uint8Array, at: number, mask: number): Uint8Array => {
  const out = bytes.slice();
  if (out.length > 0) out[at % out.length] = (out[at % out.length] ?? 0) ^ mask;
  return out;
};

/** A bundle after an alteration; the archive inside it is `tar`. */
const altered = async (bundle: Uint8Array, tar: Uint8Array, a: Alteration): Promise<Uint8Array> => {
  switch (a.kind) {
    case "none":
      return bundle;
    case "cut":
      return bundle.slice(0, a.at % bundle.length);
    case "flip":
      return flipped(bundle, a.at, a.mask);
    case "trailer":
      return flipped(bundle, bundle.length - 8 + a.at, a.mask);
    case "append":
      return joined(bundle, a.bytes);
    case "tar-cut":
      return gzip(tar.slice(0, a.at % tar.length));
    case "tar-flip":
      return gzip(flipped(tar, a.at, a.mask));
    case "tar-field": {
      const headers = headersOf(tar);
      const at = headers[a.header % headers.length] ?? 0;
      const out = tar.slice();
      out[at + a.at] = a.value;
      if (a.at < 148 || a.at >= 156) resum(out, at);
      return gzip(out);
    }
    case "tar-type": {
      const headers = headersOf(tar);
      const at = headers[a.header % headers.length] ?? 0;
      const out = tar.slice();
      out[at + 156] = a.type.charCodeAt(0);
      resum(out, at);
      return gzip(out);
    }
    case "tar-path": {
      const headers = headersOf(tar);
      const at = headers[a.header % headers.length] ?? 0;
      const out = tar.slice();
      out.fill(0, at, at + 100);
      out.set(enc.encode(a.name), at);
      resum(out, at);
      return gzip(out);
    }
    case "tar-name": {
      const headers = headersOf(tar);
      const from = headers[a.from % headers.length] ?? 0;
      const to = headers[a.to % headers.length] ?? 0;
      const out = tar.slice();
      out.copyWithin(to, from, from + 100);
      resum(out, to);
      return gzip(out);
    }
    default: {
      const gzipped = await gzip(joined(tar, fill(new Uint8Array(a.length), a.seed, false)));
      return a.trailer === undefined
        ? gzipped
        : flipped(gzipped, gzipped.length - 8 + a.trailer.at, a.trailer.mask);
    }
  }
};

describe("the streaming reader", () => {
  it("[bundle.read-equal] answers as the whole-archive reader did, on bundles whole and altered", async () => {
    await fc.assert(
      fc.asyncProperty(filesArb(false), alterationArb, async (files, alteration) => {
        const bundle = await oracle.writeBundle(files);
        const bytes = await altered(bundle, await oracle.tarOf(files), alteration);
        const before = bytes.slice();
        const ours = await read(readBundle, bytes);
        expect(ours).toEqual(await read(oracle.readBundle, bytes));
        expect(firstDifference(bytes, before)).toBe(-1);
      }),
      { numRuns: 200 },
    );
  });

  it("[bundle.read-own-buffers] gives each file its bytes in a buffer of their own, exactly their size", async () => {
    await fc.assert(
      fc.asyncProperty(filesArb(true), fc.nat(64), async (files, offset) => {
        // The bundle itself a view into a larger buffer, as one read from a stream may be.
        const bundle = await writeBundle(files);
        const within = new Uint8Array(bundle.length + offset + 64);
        within.set(bundle, offset);
        const back = await readBundle(within.subarray(offset, offset + bundle.length));
        expect(back.map((f) => f.path).toSorted()).toEqual(files.map((f) => f.path).toSorted());
        for (const f of back)
          expect({
            path: f.path,
            offset: f.bytes.byteOffset,
            owned: f.bytes.buffer.byteLength,
          }).toEqual({
            path: f.path,
            offset: 0,
            owned: f.bytes.byteLength,
          });
        expect(new Set(back.map((f) => f.bytes.buffer)).size).toBe(back.length);
      }),
      { numRuns: 100 },
    );
  });
});
