import { describe, expect, it } from "vitest";
import {
  BUNDLE_MANIFEST,
  type BundleFile,
  BundleUnreadable,
  readBundle,
  writeBundle,
} from "../src/index.ts";
import { fc } from "./support/fast-check.ts";

const enc = new TextEncoder();

const gzip = async (tar: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(
    await new Response(
      new Blob([tar.slice()]).stream().pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer(),
  );

/** The uncompressed archive of a bundle written from `files`. */
const tarOf = async (files: readonly BundleFile[]): Promise<Uint8Array> =>
  new Uint8Array(
    await new Response(
      new Blob([(await writeBundle(files)).slice()])
        .stream()
        .pipeThrough(new DecompressionStream("gzip")),
    ).arrayBuffer(),
  );

const bytewise = (a: BundleFile, b: BundleFile): number => {
  const x = enc.encode(a.path);
  const y = enc.encode(b.path);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return x.length - y.length;
};

/** Files as a reader gives them back: in bytewise path order, `executable` only when set. */
const normalised = (files: readonly BundleFile[]): BundleFile[] =>
  files
    .map((f) => ({
      path: f.path,
      bytes: f.bytes,
      ...(f.executable === true ? { executable: true } : {}),
    }))
    .toSorted(bytewise);

const segment = fc
  .stringMatching(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,30}$/)
  .filter((s) => s !== BUNDLE_MANIFEST);
/** A bundle's files: safe, distinct paths (some long enough to need a PAX header), any bytes. */
const filesArb: fc.Arbitrary<BundleFile[]> = fc
  .uniqueArray(
    fc.record({
      path: fc.array(segment, { minLength: 1, maxLength: 6 }).map((s) => s.join("/")),
      bytes: fc.uint8Array({ maxLength: 700 }),
      executable: fc.option(fc.boolean(), { nil: undefined }),
    }),
    { selector: (f) => f.path, minLength: 1, maxLength: 6 },
  )
  .filter((files) =>
    // No path may also be a directory of another.
    files.every((f) => files.every((g) => !g.path.startsWith(`${f.path}/`))),
  )
  .map((files) =>
    files.map((f) => ({
      path: f.path,
      bytes: f.bytes,
      ...(f.executable === undefined ? {} : { executable: f.executable }),
    })),
  );

const unreadable = async (bytes: Uint8Array): Promise<string> => {
  try {
    await readBundle(bytes);
  } catch (error) {
    if (error instanceof BundleUnreadable) return error.reason;
    throw error;
  }
  throw new Error("the bundle was read");
};

describe("reading a bundle back", () => {
  it("[bundle.read-back] reads back exactly the files a bundle was written from, long paths too", async () => {
    await fc.assert(
      fc.asyncProperty(filesArb, async (files) => {
        expect(await readBundle(await writeBundle(files))).toEqual(normalised(files));
      }),
      { numRuns: 100 },
    );
    const long = [{ path: `${"d".repeat(60)}/${"f".repeat(60)}.ts`, bytes: enc.encode("x") }];
    expect(await readBundle(await writeBundle(long))).toEqual(long);
  });

  it("[bundle.truncated-refused] refuses a bundle cut short anywhere", async () => {
    await fc.assert(
      fc.asyncProperty(filesArb, fc.double({ min: 0, max: 1, noNaN: true }), async (files, at) => {
        const bytes = await writeBundle(files);
        const cut = Math.min(bytes.length - 1, Math.floor(bytes.length * at));
        expect(await unreadable(bytes.slice(0, cut))).toEqual(expect.any(String));
      }),
      { numRuns: 100 },
    );
  });

  it("[bundle.manifest-checked] refuses an archive whose files are not the ones its manifest lists", async () => {
    await fc.assert(
      fc.asyncProperty(
        filesArb,
        fc.nat(),
        fc.uint8Array({ minLength: 1, maxLength: 40 }),
        async (files, which, bytes) => {
          const i = which % files.length;
          const target = files[i];
          fc.pre(target !== undefined && enc.encode(target.path).length <= 100);
          const altered = files.map((f, j) =>
            j === i ? { ...f, bytes: new Uint8Array([...f.bytes, ...bytes]) } : f,
          );
          // The manifest is the archive's first entry, and the same size for both: splice the original's in.
          const original = await tarOf(files);
          const tampered = await tarOf(altered);
          const size = Number.parseInt(new TextDecoder().decode(original.subarray(124, 135)), 8);
          const span = 512 + Math.ceil(size / 512) * 512;
          tampered.set(original.subarray(0, span), 0);
          expect(await unreadable(await gzip(tampered))).toBe(
            "the files are not the ones the manifest lists",
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  it("refuses bytes that are not gzip, and an archive with no manifest", async () => {
    expect(await unreadable(enc.encode("not a bundle"))).toBe("not gzip, or cut short");
    expect(await unreadable(await gzip(new Uint8Array(1024)))).toBe(`no ${BUNDLE_MANIFEST}`);
  });

  it("refuses an entry that is not a regular file", async () => {
    const tar = await tarOf([{ path: "a.ts", bytes: enc.encode("x") }]);
    // The second header is a.ts's: make it a symlink and fix its checksum.
    const size = Number.parseInt(new TextDecoder().decode(tar.subarray(124, 135)), 8);
    const at = 512 + Math.ceil(size / 512) * 512;
    tar[at + 156] = "2".charCodeAt(0);
    tar.fill(32, at + 148, at + 156);
    const sum = tar.subarray(at, at + 512).reduce((t, b) => t + b, 0);
    tar.set(enc.encode(`${sum.toString(8).padStart(6, "0")}\0 `), at + 148);
    expect(await unreadable(await gzip(tar))).toMatch(/only regular files/);
  });
});
