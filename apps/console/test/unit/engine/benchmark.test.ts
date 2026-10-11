import { describe, expect, it, vi } from "vitest";
import type { UnsealObservation } from "../../../src/contract/observations.ts";
import { createMockSource } from "../../fixtures/mock/MockSource.ts";
import type { Player } from "../../../src/engine/player.ts";
import {
  type BenchmarkState,
  entriesOf,
  benchmarkOf,
  sealHolds,
} from "../../../src/engine/benchmark.ts";
import { showing } from "../showing.ts";

// A test here replays the whole swarm. On a busy machine that takes longer than the default five seconds.
vi.setConfig({ testTimeout: 30_000 });

async function playerAt(scenario: "s1" | "swarm", seconds: number): Promise<Player> {
  const player = showing(createMockSource({ scenario, seed: 42 }));
  await player.load();
  player.seek(seconds * 1000);
  return player;
}

/** The benchmark as it would stand had the runner published `rewrite(what it did publish)`. */
function republished(
  player: Player,
  rewrite: (unseal: UnsealObservation) => UnsealObservation,
): BenchmarkState {
  const published = player.world.unseal;
  if (published === undefined) throw new Error("nothing has been unsealed");
  player.world.observe(rewrite(published));
  const state = benchmarkOf(player.world);
  player.world.observe(published);
  return state;
}

/** Republishes a manifest with every entry of one kind called the other. */
const flip =
  (from: string, to: string) =>
  (unseal: UnsealObservation): UnsealObservation => ({
    ...unseal,
    sealed: unseal.sealed.replaceAll(`"kind":"${from}"`, `"kind":"${to}"`),
  });

describe("the benchmark, on the swarm", () => {
  const finished = playerAt("swarm", 9999);

  it("shows only the commitment and Keel's own tally while the run is sealed", async () => {
    const state = benchmarkOf((await playerAt("swarm", 100)).world);
    expect(state.phase).toBe("sealed");
    expect(state).toMatchObject({ planted: 13, decoys: 8, rows: [], caught: 0, missed: 0 });
    expect(state.commitment).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(state.sealedText).toBeUndefined();
    // What Keel has done is no secret: it is in the log.
    expect(state.keel.proven + state.keel.dismissed + state.keel.open).toBeGreaterThan(10);
    expect(state.keel.open).toBeGreaterThan(0);
  });

  it("unseals to twelve caught, one missed, and every decoy dismissed", async () => {
    const state = benchmarkOf((await finished).world);
    expect(state.phase).toBe("unsealed");
    expect(state.rows).toHaveLength(21);
    expect(state).toMatchObject({
      planted: 13,
      decoys: 8,
      caught: 12,
      missed: 1,
      decoysCleared: 8,
      decoysRaised: 8,
      falsePositives: 0,
      undecided: 0,
      unplanted: [],
    });
    expect(state.keel).toEqual({ proven: 12, dismissed: 8, open: 0 });
    // Keel's log bears out every change the runner names.
    expect(state.rows.filter((row) => !row.borneOut)).toEqual([]);
    // The miss leads: it is the row that most needs reading.
    expect(state.rows[0]?.outcome).toBe("missed");
  });

  it("explains the miss from Keel's own log: Clef derived something else, and nothing was raised", async () => {
    const state = benchmarkOf((await finished).world);
    const miss = state.rows.find((row) => row.outcome === "missed");
    // Told to rely on freshness at most per-call, and told to make it per-request: one step up Keel's own lattice.
    expect(miss?.entry).toMatchObject({
      kind: "planted",
      predicate: "freshness",
      alters: { to: "per-request" },
      relies: { atMost: "per-call" },
    });
    expect(miss?.conflict).toBeUndefined();
    expect(miss?.alters?.landed).toBe(true);
    expect(miss?.derived).toMatchObject({ method: "clef", value: "per-call" });
    expect(miss?.derived?.p).toBeLessThan(0.72);
  });

  it("ties each caught disagreement to the conflict and the guard that came of it", async () => {
    const state = benchmarkOf((await finished).world);
    const caught = state.rows.filter((row) => row.outcome === "caught");
    expect(
      caught.every(
        (row) => row.conflict?.state === "resolved" && /^G-\d+$/.test(row.conflict.guard ?? ""),
      ),
    ).toBe(true);
    expect(caught.filter((row) => row.conflict?.decision !== undefined)).toHaveLength(2);
    const dismissed = state.rows.filter((row) => row.outcome === "dismissed");
    expect(
      dismissed.every((row) => row.entry.kind === "decoy" && row.conflict?.state === "dismissed"),
    ).toBe(true);
    // A proof costs the template, the draft and fifteen cells. A false alarm is over two cells sooner.
    expect([...new Set(caught.map((row) => row.conflict?.costUsd))]).toEqual([0.002]);
    expect([...new Set(dismissed.map((row) => row.conflict?.costUsd))]).toEqual([0.001872]);
  });

  it("checks the published text against the commitment, and refuses one that was changed afterwards", async () => {
    const state = benchmarkOf((await finished).world);
    expect(await sealHolds(state.sealedText ?? "", state.commitment ?? "")).toBe(true);
    expect(
      await sealHolds(
        (state.sealedText ?? "").replace('"kind":"planted"', '"kind":"decoy"'),
        state.commitment ?? "",
      ),
    ).toBe(false);
  });

  it("scores against what the runner sealed, not what Keel concluded", async () => {
    const player = await playerAt("swarm", 9999);
    // Had every decoy been a real disagreement, the eight Keel dismissed would be eight misses.
    expect(republished(player, flip("decoy", "planted"))).toMatchObject({
      caught: 12,
      missed: 9,
      decoysCleared: 0,
    });
    // Had every planted one been a decoy, the twelve Keel proved would be twelve false positives.
    expect(republished(player, flip("planted", "decoy"))).toMatchObject({
      caught: 0,
      falsePositives: 12,
      decoysCleared: 9,
      decoysRaised: 8,
    });
  });

  it("names a conflict Keel proved that the runner never planted", async () => {
    const player = await playerAt("swarm", 9999);
    const caught = benchmarkOf(player.world).rows.find((row) => row.outcome === "caught");
    const state = republished(player, (unseal) => {
      const entries: unknown = JSON.parse(unseal.sealed.slice(unseal.sealed.indexOf("\n") + 1));
      const kept = Array.isArray(entries)
        ? entries.filter(
            (entry: unknown) => JSON.stringify(entry) !== JSON.stringify(caught?.entry),
          )
        : [];
      return { ...unseal, sealed: `salt\n${JSON.stringify(kept)}` };
    });
    expect(state.rows).toHaveLength(20);
    expect(state.unplanted).toEqual([caught?.conflict?.label]);
  });

  it("leaves an entry undecided while its changes are still in flight, rather than calling it a miss", async () => {
    const published = (await finished).world.unseal;
    const early = await playerAt("swarm", 60);
    if (published !== undefined) early.world.observe(published);
    const state = benchmarkOf(early.world);
    expect(state.undecided).toBeGreaterThan(5);
    expect(state.missed).toBe(0);
    expect(state.caught + state.decoysCleared + state.undecided).toBe(21);
    // Nothing is scored that Keel has not finished with.
    expect(
      state.rows.filter((row) => row.outcome !== "undecided" && row.conflict === undefined),
    ).toEqual([]);
  });

  it("does not take the runner's word for which changes it meant", async () => {
    const player = await playerAt("swarm", 9999);
    const [first, second] = entriesOf(player.world.unseal?.sealed ?? "");
    const state = republished(player, (unseal) => ({
      ...unseal,
      // The runner points its first entry at the changes of its second.
      changes: {
        ...unseal.changes,
        [first?.id ?? ""]: unseal.changes[second?.id ?? ""] ?? { relies: "", alters: "" },
      },
    }));
    expect(state.rows.filter((row) => !row.borneOut).map((row) => row.entry.id)).toEqual([
      first?.id,
    ]);
    // Or it names the right changes, but says another agent made one of them.
    const renamed = republished(player, (unseal) => ({
      ...unseal,
      sealed: unseal.sealed.replace(
        `"agent":"${first?.alters.agent ?? ""}"`,
        '"agent":"synthetic-000"',
      ),
    }));
    expect(renamed.rows.filter((row) => !row.borneOut).map((row) => row.entry.id)).toEqual([
      first?.id,
    ]);
  });
});

describe("the benchmark, elsewhere", () => {
  it("has nothing to show where no run was sealed", async () => {
    const state = benchmarkOf((await playerAt("s1", 9999)).world);
    expect(state).toMatchObject({ phase: "none", rows: [], planted: 0, decoys: 0 });
    expect(state.keel).toEqual({ proven: 1, dismissed: 0, open: 0 });
  });

  it("reads nothing out of a manifest that is not one", () => {
    expect(entriesOf("salt\nnot json")).toEqual([]);
    expect(entriesOf('salt\n{"kind":"planted"}')).toEqual([]);
    expect(entriesOf('salt\n[{"kind":"neither"},{"kind":"decoy","id":"M-01"}]')).toEqual([
      {
        id: "M-01",
        kind: "decoy",
        subject: "",
        predicate: "",
        relies: { agent: "", atMost: "" },
        alters: { agent: "", to: "" },
      },
    ]);
  });
});
