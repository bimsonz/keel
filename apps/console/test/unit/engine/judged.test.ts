import { describe, expect, it } from "vitest";
import { noneDerived, verdictSaid } from "../../../src/engine/judged.ts";
import { changePageOf } from "../../../src/engine/select.ts";
import { World } from "../../../src/engine/world.ts";
import { ScriptBuilder } from "../../fixtures/mock/builder.ts";
import { createMockSource } from "../../fixtures/mock/MockSource.ts";
import { createRng } from "../../fixtures/prng.ts";
import { showing } from "../showing.ts";

const NO_RESOURCES = {
  probes: new Map(),
  diffs: new Map(),
  verdicts: new Map(),
  lattices: new Map(),
  refused: new Set<string>(),
};

const LANDED = "chg_0000000000000000000LANDED";
const WITHDRAWN = "chg_000000000000000WITHDRAWN";
const WAITING = "chg_00000000000000000WAITING";
const VERDICT = "vrd_00000000000000000000000001";
const BATCH = "bat_00000000000000000000000001";
const COMMIT = "c96bc39b527c51c1bf0bef6d65d660c5ccb70b7d";
/** The commit Keel composed on trunk for the change: another than the one its workspace pushed. */
const ON_TRUNK = "8b1f34de3eb2f8ffec648f7741698ee62ad3f138";
const PREVIEW = "dpl_00000000000000000000000001";
const ALIAS = "https://chg-landed-forge.example.workers.dev";
const OFF = "verification-off: the project's verification is off, so no plan ran";

/**
 * A log as Keel itself writes one, for a project whose verification is off: a change that pushed a commit Keel
 * derived no effect from and landed on its batch's verdict, one withdrawn before it pushed anything, and one
 * that has pushed and waits to be derived. The verdict names the batch, says no plan ran, and carries one line
 * of evidence and no sentence of its own.
 */
function asKeelWrites(): World {
  const b = new ScriptBuilder("2026-10-13T15:58:00.000Z", createRng(3));
  const declare = (changeId: string, goal: string): void => {
    b.emit({
      type: "IntentDeclared",
      entity: { kind: "change", id: changeId },
      payload: {
        changeId,
        agentId: "agt_1",
        origin: "agent",
        revision: 1,
        goal,
        footprint: [],
        premises: [],
        leaseId: "l",
      },
    });
  };
  const submit = (changeId: string, commitSha: string): void => {
    b.emit({
      type: "ChangeSubmitted",
      entity: { kind: "change", id: changeId },
      payload: { changeId, revision: 1, commitSha, workspaceId: "wsp_1" },
    });
  };
  b.at(1);
  declare(LANDED, "a file on imported history");
  submit(LANDED, COMMIT);
  b.emit({
    type: "EffectsDerived",
    entity: { kind: "change", id: LANDED },
    payload: { changeId: LANDED, revision: 1, effects: [], derivationRef: "sha256:f319" },
  });
  b.at(2).emit({
    type: "BatchFormed",
    entity: { kind: "batch", id: BATCH },
    payload: {
      batchId: BATCH,
      laneId: "lane_1",
      members: [LANDED],
      base: "7fd1a60",
      attempt: 1,
      chainEpoch: 0,
    },
  });
  b.emit({
    type: "VerdictIssued",
    entity: { kind: "verdict", id: VERDICT },
    payload: {
      verdictId: VERDICT,
      subject: BATCH,
      outcome: "land",
      evidence: [OFF],
      verified: false,
    },
  });
  b.emit({
    type: "BatchVerified",
    entity: { kind: "batch", id: BATCH },
    payload: {
      batchId: BATCH,
      candidateId: "cnd_1",
      verdictId: VERDICT,
      members: [LANDED],
      verified: false,
    },
  });
  // Keel's verification previews the candidate on the project's account, and tells the change where.
  b.emit({
    type: "PreviewDeployed",
    entity: { kind: "change", id: LANDED },
    payload: {
      deploymentId: PREVIEW,
      changeId: LANDED,
      candidateId: "cnd_1",
      world: "candidate",
      target: "production",
      provider: "cloudflare",
      url: "https://3f2a9c1e-forge.example.workers.dev",
      aliasUrl: ALIAS,
    },
  });
  b.emit({
    type: "ChangeLanded",
    entity: { kind: "change", id: LANDED },
    payload: {
      changeId: LANDED,
      commitSha: ON_TRUNK,
      // Trunk's head once the batch is on it: another commit, where a batch lands more than this change.
      trunkSha: "0f0e0d0c0b0a09080706050403020100ffeeddcc",
      candidateId: "cnd_1",
      proofId: "sha256:159a",
    },
  });
  b.at(3);
  declare(WITHDRAWN, "read trunk");
  b.emit({
    type: "ChangeWithdrawn",
    entity: { kind: "change", id: WITHDRAWN },
    payload: { changeId: WITHDRAWN, by: "agt_1" },
  });
  declare(WAITING, "a second file");
  submit(WAITING, "0a1b2c3");
  const world = new World();
  const log = b.build();
  log.events.forEach((event, index) => world.apply(event, log.eventTimes[index] ?? 0));
  return world;
}

/** Keel's own verdict: an outcome, whether a plan ran, and no sentence. */
const keels = (outcome: Parameters<typeof verdictSaid>[0]["outcome"], unverified = false): string =>
  verdictSaid({ summary: "", outcome, unverified });

/** A change of scenario 1 whose page has a verdict to show. */
const judged = (player: ReturnType<typeof showing>): string =>
  [...player.world.changes.keys()].find(
    (id) => changePageOf(player.world, id, player)?.verdict !== undefined,
  ) ?? "";

describe("a change's page, in Keel's own fields", () => {
  it("[judged.verdict] says a verdict in its own summary where it has one, and by Keel's outcome where it has none, with that no plan ran where Keel says so", () => {
    expect(verdictSaid({ summary: "The plan passed", outcome: "land", unverified: false })).toBe(
      "The plan passed.",
    );
    expect(keels("land")).toBe("Keel's verdict was to land it.");
    expect(keels("land", true)).toBe("Keel's verdict was to land it, without verification.");
    expect(
      (["bounce", "park", "hold", "supersede"] as const).map((outcome) => keels(outcome)),
    ).toEqual([
      "Keel's verdict was to bounce it.",
      "Keel's verdict was to park it.",
      "Keel's verdict was to hold it.",
      "Keel's verdict was to supersede it.",
    ]);
  });

  it("[judged.derived] says why no derived effect is listed: no commit was pushed, Keel has not derived from it yet, or it derived none", () => {
    expect(noneDerived({ commit: "", derived: false })).toBe(
      "This change pushed no commit, so Keel derived nothing.",
    );
    expect(noneDerived({ commit: COMMIT, derived: false })).toBe(
      "Keel has not derived what this commit does yet.",
    );
    expect(noneDerived({ commit: COMMIT, derived: true })).toBe(
      "Keel derived no effect from this commit.",
    );
  });

  it("[judged.as-keel-writes] reads a log as Keel writes one: a batch's verdict with no sentence of its own, a commit no effect was derived from, and a change withdrawn before it pushed", () => {
    const world = asKeelWrites();
    const landed = changePageOf(world, LANDED, NO_RESOURCES);
    expect(landed?.verdict).toMatchObject({
      id: VERDICT,
      summary: "",
      said: "Keel's verdict was to land it, without verification.",
      evidence: [],
    });
    expect(landed?.verdict?.recorded).toBeUndefined();
    expect(landed?.change).toMatchObject({ commit: COMMIT, derived: true });
    expect(landed?.derived).toEqual([]);

    const withdrawn = changePageOf(world, WITHDRAWN, NO_RESOURCES);
    expect(withdrawn?.verdict).toBeUndefined();
    expect(withdrawn?.change).toMatchObject({ state: "withdrawn", commit: "", derived: false });

    // Pushed, and not derived from yet: a commit to name, and nothing said to have been found in it.
    expect(changePageOf(world, WAITING, NO_RESOURCES)?.change).toMatchObject({
      commit: "0a1b2c3",
      derived: false,
    });
  });

  it("[judged.landed-as] names the commit a change landed as on trunk, which Keel's landing names and is not the one its workspace pushed, and names none for a change that has not landed", () => {
    const world = asKeelWrites();
    expect(changePageOf(world, LANDED, NO_RESOURCES)?.change).toMatchObject({
      state: "landed",
      commit: COMMIT,
      landedAs: ON_TRUNK,
    });
    expect(changePageOf(world, WITHDRAWN, NO_RESOURCES)?.change.landedAs).toBeUndefined();
    expect(changePageOf(world, WAITING, NO_RESOURCES)?.change.landedAs).toBeUndefined();
  });

  it("[judged.preview] says where Keel previewed a change, by the change's own address where Keel gives one, and that it was taken down once Keel says so", () => {
    const world = asKeelWrites();
    expect(changePageOf(world, LANDED, NO_RESOURCES)?.change.preview).toEqual({
      url: ALIAS,
      down: false,
    });
    expect(changePageOf(world, WAITING, NO_RESOURCES)?.change.preview).toBeUndefined();
    const later = new ScriptBuilder("2026-10-13T16:30:00.000Z", createRng(4));
    later.emit({
      type: "PreviewTornDown",
      entity: { kind: "deployment", id: PREVIEW },
      payload: { deploymentId: PREVIEW },
    });
    const [down] = later.build().events;
    if (down !== undefined) world.apply(down, 99);
    expect(changePageOf(world, LANDED, NO_RESOURCES)?.change.preview).toEqual({
      url: ALIAS,
      down: true,
    });
  });

  it("[judged.recorded] lists what the verdict's own event recorded where Keel serves no view of the verdict, and nothing of it where Keel serves one or has not answered", () => {
    const world = asKeelWrites();
    // Keel was asked for its view of the verdict and served none.
    const unserved = { ...NO_RESOURCES, refused: new Set([VERDICT]) };
    expect(changePageOf(world, LANDED, unserved)?.verdict?.recorded).toEqual([OFF]);
    // Asked about something else, or not answered yet.
    expect(
      changePageOf(world, LANDED, { ...NO_RESOURCES, refused: new Set([LANDED]) })?.verdict
        ?.recorded,
    ).toBeUndefined();
    expect(changePageOf(world, LANDED, NO_RESOURCES)?.verdict?.recorded).toBeUndefined();
  });

  it("[judged.unserved] is told when Keel serves no view of a verdict, and is told nothing of the kind when it serves one", async () => {
    const serving = showing(createMockSource({ scenario: "s1", seed: 42 }));
    await serving.load();
    serving.seek(700_000);
    const id = judged(serving);
    serving.wantVerdict(id);
    await Promise.resolve();
    await Promise.resolve();
    const served = changePageOf(serving.world, id, serving)?.verdict;
    expect(served?.recorded).toBeUndefined();
    // Each line of a landing's evidence names the step it describes, so it is shown under that step.
    expect(served?.plan?.steps.flatMap((step) => step.lines).length).toBeGreaterThan(0);

    const refusing = showing({
      ...createMockSource({ scenario: "s1", seed: 42 }),
      getVerdict: () => Promise.reject(new Error("Keel does not serve this")),
    });
    await refusing.load();
    refusing.seek(700_000);
    refusing.wantVerdict(id);
    await Promise.resolve();
    await Promise.resolve();
    const unserved = changePageOf(refusing.world, id, refusing)?.verdict;
    expect(unserved?.evidence).toEqual([]);
    expect(unserved?.recorded).toEqual(
      refusing.world.verdicts.get(unserved?.id ?? "")?.evidence ?? ["no such verdict"],
    );
  });
});
