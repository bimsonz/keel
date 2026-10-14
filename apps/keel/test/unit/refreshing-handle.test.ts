// One Artifacts handle fails at its 5,004th read (live, 14 Oct): a walk past
// that reads on through fresh handles, and none is disposed under a read.
import { CodeHost } from "@keeltown/core/ports";
import { Effect, Result } from "effect";
import { describe, expect, it } from "vitest";
import { CodeHostArtifacts } from "../../src/adapters/driven/artifacts/code-host.ts";
import { ArtifactsObjects } from "../../src/adapters/driven/artifacts/objects.ts";
import {
  HANDLE_READS,
  refreshingReads,
} from "../../src/adapters/driven/artifacts/refreshing-handle.ts";
import { FakeArtifacts } from "./fake-artifacts.ts";

const NAMESPACE = "keel-core";
const REPO = { namespace: NAMESPACE, name: "big" };
/** The reads a live handle serves: its 5,004th fails. */
const CEILING = 5_003;
const oid = (n: number) => n.toString(16).padStart(40, "0");
const oids = (count: number) => Array.from({ length: count }, (_, n) => oid(n));

/** A binding serving `count` blobs from one repo, each handle failing past CEILING. */
const serving = (count: number) => {
  const binding = new FakeArtifacts();
  binding.handleReads = CEILING;
  binding.serve(REPO.name, {
    blobs: Object.fromEntries(oids(count).map((hash, n) => [hash, `blob ${n}`])),
  });
  return binding;
};

/** Reads every blob through `read`, 8 in flight, as the bundle walk does. */
const readAll = async (count: number, read: (hash: string) => Promise<Uint8Array>) => {
  const queue = oids(count).entries();
  const texts: string[] = [];
  const reader = async () => {
    for (const [at, hash] of queue) texts[at] = new TextDecoder().decode(await read(hash));
  };
  await Promise.all(Array.from({ length: 8 }, reader));
  return texts;
};

const blobTexts = (count: number) => oids(count).map((_, n) => `blob ${n}`);

describe("an Artifacts handle's reads", () => {
  it("[artifacts.handle-refresh] a walk past one handle's reads goes on through fresh ones: 10,000 reads through ArtifactsObjects and 9,000 through readBlobs all succeed, a fresh handle every HANDLE_READS, and each handle is disposed once", async () => {
    const objects = serving(10_000);
    const reader = await ArtifactsObjects({ [NAMESPACE]: objects })(REPO);
    const texts = await readAll(10_000, (hash) => reader.readBlob(hash));
    reader[Symbol.dispose]();
    expect(texts).toEqual(blobTexts(10_000));
    expect(objects.handles.map((h) => [h.reads, h.disposed])).toEqual([
      [HANDLE_READS, 1],
      [HANDLE_READS, 1],
      [10_000 - 2 * HANDLE_READS, 1],
    ]);

    const host = serving(9_000);
    const answers = await Effect.runPromise(
      Effect.flatMap(CodeHost, (codeHost) => codeHost.readBlobs(REPO, oids(9_000))).pipe(
        Effect.provide(CodeHostArtifacts({ [NAMESPACE]: host })),
      ),
    );
    expect(
      answers.map((answer) =>
        Result.isSuccess(answer) ? new TextDecoder().decode(answer.success) : "missing",
      ),
    ).toEqual(blobTexts(9_000));
    expect(host.handles.map((h) => [h.reads, h.disposed])).toEqual([
      [HANDLE_READS, 1],
      [HANDLE_READS, 1],
      [9_000 - 2 * HANDLE_READS, 1],
    ]);
  });

  it("[artifacts.handle-refresh-settles] a handle left behind is disposed only once the reads it took have settled, and disposing the reader disposes the one it reads through", async () => {
    const binding = serving(4);
    let release: (() => void) | undefined;
    binding.gates.set(
      oid(0),
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const reads = refreshingReads(await binding.get(REPO.name), () => binding.get(REPO.name), 2);
    const held = reads.readBlob(oid(0));
    await reads.readBlob(oid(1));
    // A third read opens a second handle, while the first still has a read in flight.
    expect(await reads.readBlob(oid(2))).not.toBeNull();
    expect(binding.handles.map((h) => h.disposed)).toEqual([0, 0]);
    release?.();
    expect(await held).not.toBeNull();
    expect(binding.handles.map((h) => h.disposed)).toEqual([1, 0]);
    reads[Symbol.dispose]();
    expect(binding.handles.map((h) => h.disposed)).toEqual([1, 1]);
  });
});
