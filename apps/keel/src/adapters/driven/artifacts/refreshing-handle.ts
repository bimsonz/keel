/**
 * How many object reads one Artifacts handle serves before a fresh one is
 * opened. A handle fails at its 5,004th read, whatever the pace (live, 14 Oct:
 * `INTERNAL_ERROR` at read 5004 of 6,000, 8 in flight at 50 a second, in a
 * Worker allowed 100,000 subrequests), and a fresh `get()` every 4,000 reads
 * read 6,000 of 6,000.
 */
export const HANDLE_READS = 4_000;

/** The reads a handle serves: the ones a walk of a whole tree makes by the thousand. */
export type HandleReads = Pick<ArtifactsRepo, "readTree" | "readBlob" | "readCommit">;

interface Held {
  readonly handle: ArtifactsRepo;
  served: number;
  inFlight: number;
  retired: boolean;
}

/** A handle's reads that go on through fresh handles, and any other call on the handle read through now. */
export interface RefreshingReads extends HandleReads, Disposable {
  /** Runs `call` on the current handle, which is not disposed until it settles; it counts as no read. */
  use<A>(call: (handle: ArtifactsRepo) => Promise<A>): Promise<A>;
}

/**
 * Reads through `first` until it has served `limit`, then through a fresh
 * handle from `open`, and so on: one open at a time, shared by every read
 * waiting on it. A handle left behind is disposed once the reads and calls it
 * took have settled, and disposing the reader disposes the one it reads
 * through (or the one being opened, once it opens). An open that fails fails
 * the reads that waited on it, and the next read opens again.
 */
export function refreshingReads(
  first: ArtifactsRepo,
  open: () => Promise<ArtifactsRepo>,
  limit = HANDLE_READS,
): RefreshingReads {
  let held: Held = { handle: first, served: 0, inFlight: 0, retired: false };
  let opening: Promise<void> | undefined;
  let disposed = false;
  const settle = (each: Held) => {
    if (each.retired && each.inFlight === 0) each.handle[Symbol.dispose]();
  };
  const retire = (each: Held) => {
    if (each.retired) return;
    each.retired = true;
    settle(each);
  };
  const take = async (): Promise<Held> => {
    while (held.served >= limit) {
      opening ??= (async () => {
        try {
          const handle = await open();
          const old = held;
          held = { handle, served: 0, inFlight: 0, retired: false };
          retire(old);
          if (disposed) retire(held);
        } finally {
          opening = undefined;
        }
      })();
      // Each read waits for the one open in flight.
      await opening;
    }
    held.served += 1;
    held.inFlight += 1;
    return held;
  };
  const on = async <A>(using: Held, call: (handle: ArtifactsRepo) => Promise<A>): Promise<A> => {
    try {
      return await call(using.handle);
    } finally {
      using.inFlight -= 1;
      settle(using);
    }
  };
  const through =
    <A>(call: (handle: ArtifactsRepo, hash: string) => Promise<A>) =>
    async (hash: string): Promise<A> =>
      on(await take(), (handle) => call(handle, hash));
  return {
    readTree: through((handle, hash) => handle.readTree(hash)),
    readBlob: through((handle, hash) => handle.readBlob(hash)),
    readCommit: through((handle, hash) => handle.readCommit(hash)),
    use: (call) => {
      held.inFlight += 1;
      return on(held, call);
    },
    [Symbol.dispose]: () => {
      disposed = true;
      retire(held);
    },
  };
}
