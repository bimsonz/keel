// The candidate bundle writer and reader in workerd, where the Lane's Durable
// Object runs them: the writer streams the archive into gzip in pieces and the
// reader takes it apart as it unpacks, so neither holds the whole archive.
import { type BundleFile, readBundle, writeBundle } from "@keeltown/runner-protocol";
import { describe, expect, it } from "vitest";

const through = async (
  bytes: Uint8Array,
  stream: CompressionStream | DecompressionStream,
): Promise<Uint8Array> =>
  new Uint8Array(
    await new Response(new Blob([bytes.slice()]).stream().pipeThrough(stream)).arrayBuffer(),
  );

/** Where two byte strings first differ, or -1 when they are equal. */
const firstDifference = (a: Uint8Array, b: Uint8Array): number => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : Math.min(a.length, b.length);
};

describe("candidate bundles in workerd", () => {
  it("[bundle.workerd-stream] reads back files that are views into one buffer, writes the bytes one gzip of the whole archive makes, and leaves the buffer whole", async () => {
    // One buffer, as a pack read into memory is: noise in its first half, text in its second.
    const shared = new Uint8Array(400_000);
    for (let at = 0; at < 200_000; at += 65_536)
      crypto.getRandomValues(shared.subarray(at, Math.min(at + 65_536, 200_000)));
    shared.set(new TextEncoder().encode("export const line = 1;\n".repeat(8_000)), 200_000);
    const files: BundleFile[] = [
      { path: "package.json", bytes: shared.subarray(0, 300) },
      { path: "assets/noise.bin", bytes: shared.subarray(100, 150_100) },
      { path: "src/lines.ts", bytes: shared.subarray(210_000, 280_001) },
      { path: `${"deep/".repeat(25)}exactly-a-piece.ts`, bytes: shared.subarray(300_000, 365_536) },
      { path: "scripts/run.sh", bytes: shared.subarray(5, 517), executable: true },
      { path: "empty", bytes: shared.subarray(10, 10) },
    ];
    const before = shared.slice();
    const lengths = files.map((f) => f.bytes.length);

    const bundle = await writeBundle(files);
    const written = bundle.slice();
    const back = await readBundle(bundle);

    expect(
      back.map((f) => ({ path: f.path, executable: f.executable === true, bytes: f.bytes })),
    ).toEqual(
      files
        .map((f) => ({ path: f.path, executable: f.executable === true, bytes: f.bytes.slice() }))
        .toSorted((a, b) => (a.path < b.path ? -1 : 1)),
    );
    const tar = await through(bundle, new DecompressionStream("gzip"));
    expect(firstDifference(await through(tar, new CompressionStream("gzip")), bundle)).toBe(-1);
    expect(shared.byteLength).toBe(before.byteLength);
    expect(firstDifference(shared, before)).toBe(-1);
    expect(files.map((f) => f.bytes.length)).toEqual(lengths);
    expect(firstDifference(bundle, written)).toBe(-1);
  });
});
