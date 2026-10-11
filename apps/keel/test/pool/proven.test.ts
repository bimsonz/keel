import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  PARTY_CONFLICT,
  probeCellRan,
  probeDrafted,
  subjectAddress,
  subjectIdOf,
  suspectConflict,
} from "@keeltown/core/application/coordination";
import { Proposition, SubjectKey } from "@keeltown/core/domain/coordination";
import type { ConflictCommand, ProbeOutcome, World } from "@keeltown/core/domain/verification";
import {
  type ChangeId,
  type ConflictId,
  ContentHash,
  EventEnvelope,
  makeId,
  type ProjectId,
} from "@keeltown/core/kernel";
import { EntityStore } from "@keeltown/core/ports";
import { Effect, Exit, Schema } from "effect";
import { ulid } from "ulid";
import { describe, expect, it, vi } from "vitest";
import type { ChangeDO } from "../../src/adapters/driving/do/change.ts";
import type { SubjectDO } from "../../src/adapters/driving/do/subject.ts";
import { ChangeCodecs, decodeExit } from "../../src/rpc/index.ts";
import { type ChangeUnderTest, changeUnderTest, ok } from "./change-harness.ts";
import { drainAfter } from "./helpers.ts";
import { inertPrecheck } from "./inert-precheck.ts";

const key = Schema.decodeUnknownSync(SubjectKey);
const LEAF = key("authz.permission-evaluation");
const PLAN_HASH = `sha256:${"0".repeat(64)}`;

const premise = (subject: SubjectKey, value: string) =>
  Schema.decodeUnknownSync(Proposition)({ subject, predicate: "freshness", relation: "is", value });

const subjectOf = (projectId: ProjectId) =>
  drainAfter(env.SUBJECT.get(env.SUBJECT.idFromName(subjectAddress(projectId, LEAF))));

/** Opens a semantic conflict on the subject's real Subject DO, as its fallout does: the first party's premise against the last's effect. */
async function suspect(projectId: ProjectId, parties: readonly [ChangeId, ...ChangeId[]]) {
  const conflictId = makeId("cfl", ulid());
  const command: Extract<ConflictCommand, { _tag: "Suspect" }> = {
    _tag: "Suspect",
    kind: "semantic",
    parties,
    subjectId: subjectIdOf(projectId, LEAF),
    predicate: "freshness",
    origin: "fallout",
    premise: { holder: parties[0], proposition: premise(LEAF, "per-request") },
    effect: { changeId: parties.at(-1) ?? parties[0], proposition: premise(LEAF, "per-session") },
  };
  // Committed through the runtime, so arm the flush as an answered call would.
  await runInDurableObject(subjectOf(projectId), async (instance: SubjectDO) => {
    await instance["runtime"].runPromise(suspectConflict(projectId, conflictId, command));
    await instance["armFlush"]();
  });
  return conflictId;
}

/** One run that discriminates: passes on trunk and for the holder, fails combined and against the do-nothing mutant. */
const DISCRIMINATING: readonly (readonly [World, ProbeOutcome])[] = [
  ["trunk", "pass"],
  ["A", "pass"],
  ["AB", "fail"],
  ["A-noop", "fail"],
];

/** Proves the conflict for real on its Subject DO: a drafted probe and three discriminating runs, which settle it as proven. */
async function prove(projectId: ProjectId, conflictId: ConflictId) {
  await runInDurableObject(subjectOf(projectId), async (instance: SubjectDO) => {
    await instance["runtime"].runPromise(
      Effect.gen(function* () {
        const drafted = yield* probeDrafted(projectId, {
          conflictId,
          attempts: 1,
          bundleHash: ContentHash.make(`sha256:${"a".repeat(64)}`),
        });
        const probeId = drafted.probe?.id;
        if (probeId === undefined) throw new Error("the draft answers its probe");
        for (const run of [1, 2, 3])
          for (const [world, outcome] of DISCRIMINATING)
            yield* probeCellRan(projectId, {
              conflictId,
              probeId,
              world,
              run,
              outcome,
              resultRef: `r2://probe/${run}/${world}`,
            });
      }),
    );
    await instance["armFlush"]();
  });
}

/** What the change's own Change DO keeps of a conflict it is a party to. */
const partyRow = (c: ChangeUnderTest, conflictId: string) =>
  runInDurableObject(c.stub, (instance: ChangeDO) =>
    instance["runtime"].runPromise(
      Effect.map(EntityStore, (store) => store.get(PARTY_CONFLICT, conflictId)),
    ),
  );

/** BatchFormed as the change's lane delivers it to a member. */
const batchFormed = (c: ChangeUnderTest) => {
  const batchId = makeId("bat", ulid());
  return Schema.encodeSync(EventEnvelope)(
    Schema.decodeUnknownSync(EventEnvelope)({
      eventId: makeId("evt", ulid()),
      type: "BatchFormed",
      entity: { kind: "batch", id: batchId },
      seq: 1,
      at: Date.now(),
      dedupeKey: `batch:${batchId}/formed/BatchFormed#1`,
      affected: [{ kind: "change", id: c.changeId }],
      notified: [],
      payload: {
        _tag: "BatchFormed",
        batchId,
        laneId: `lane:${c.projectId}:main`,
        members: [c.changeId],
        base: "a".repeat(40),
        attempt: 1,
        chainEpoch: 0,
      },
    }),
  );
};

/** Declares, pushes, submits and starts Precheck: the change is deriving, awaiting its plan. */
async function deriving(c: ChangeUnderTest) {
  const lease = ok(await c.declare()).change.lease.id;
  const commitSha = await c.push();
  ok(
    decodeExit(
      ChangeCodecs.submit,
      await c.stub.submit({ agentId: c.agentId, leaseId: lease, commitSha, idempotencyKey: "s-1" }),
    ),
  );
  ok(
    decodeExit(
      ChangeCodecs.precheckStarted,
      await c.stub.precheckStarted({ revision: 1, instanceId: "p-1" }),
    ),
  );
}

const compile = async (c: ChangeUnderTest, predicatePolicy?: { readonly freshness: "block" }) =>
  decodeExit(
    ChangeCodecs.planCompiled,
    await c.stub.planCompiled({
      revision: 1,
      instanceId: "p-1",
      planHash: PLAN_HASH,
      steps: 1,
      costEstimate: 1,
      ...(predicatePolicy === undefined ? {} : { predicatePolicy }),
    }),
  );

describe("a conflict proven against a change", () => {
  it("[b21.party-hears] the conflict's Subject DO tells each party's Change DO, and no other", async () => {
    const projectId = makeId("prj", ulid());
    const [a, b, outsider] = await Promise.all([
      changeUnderTest(projectId),
      changeUnderTest(projectId),
      changeUnderTest(projectId),
    ]);
    for (const c of [a, b, outsider]) ok(await c.declare());
    const conflictId = await suspect(projectId, [a.changeId, b.changeId]);

    await vi.waitFor(
      async () => {
        expect(await partyRow(a, conflictId)).toMatchObject({ conflictId, state: "open" });
        expect(await partyRow(b, conflictId)).toMatchObject({ predicate: "freshness" });
      },
      { timeout: 15_000, interval: 100 },
    );
    expect(await partyRow(outsider, conflictId)).toBeUndefined();
  });

  it("[b21.proven-blocks] [b21.policy-default] a proven conflict blocks the queue under its plan's block policy, and only advises without one", async () => {
    await using precheck = await inertPrecheck();
    void precheck;
    const projectId = makeId("prj", ulid());
    const [blocked, advised] = await Promise.all([
      changeUnderTest(projectId),
      changeUnderTest(projectId),
    ]);
    await deriving(blocked);
    await deriving(advised);
    const conflictId = await suspect(projectId, [blocked.changeId, advised.changeId]);
    await vi.waitFor(
      async () => {
        expect(await partyRow(blocked, conflictId)).toBeDefined();
        expect(await partyRow(advised, conflictId)).toBeDefined();
      },
      { timeout: 15_000, interval: 100 },
    );
    await prove(projectId, conflictId);
    await vi.waitFor(
      async () => {
        expect(await partyRow(blocked, conflictId)).toMatchObject({ state: "proven" });
        expect(await partyRow(advised, conflictId)).toMatchObject({ state: "proven" });
      },
      { timeout: 15_000, interval: 100 },
    );

    const refusedQueue = await compile(blocked, { freshness: "block" });
    const queued = ok(await compile(advised));

    const why = JSON.stringify(Exit.isFailure(refusedQueue) ? refusedQueue.cause : null);
    expect(why).toContain("ChangeBlocked");
    expect(why).toContain(conflictId);
    expect((await blocked.current()).state).toBe("deriving");
    expect(queued.state).toBe("queued");
  });

  it("[b21.proven-blocks] a queued change under block refuses its batch once a conflict is proven against it", async () => {
    await using precheck = await inertPrecheck();
    void precheck;
    const projectId = makeId("prj", ulid());
    const c = await changeUnderTest(projectId);
    await deriving(c);
    expect(ok(await compile(c, { freshness: "block" })).state).toBe("queued");
    const conflictId = await suspect(projectId, [c.changeId]);
    await vi.waitFor(async () => expect(await partyRow(c, conflictId)).toBeDefined(), {
      timeout: 15_000,
      interval: 100,
    });
    await prove(projectId, conflictId);
    await vi.waitFor(
      async () => expect(await partyRow(c, conflictId)).toMatchObject({ state: "proven" }),
      { timeout: 15_000, interval: 100 },
    );
    await c.stub.receive([batchFormed(c)]);

    expect((await c.current()).state).toBe("queued");
    expect((await c.log()).map((event) => event.type)).not.toContain("ChangeBatched");
  });

  it("[b21.workspace-subjects] Precheck reads the subjects the change's intent names, each once and without ancestors", async () => {
    const c = await changeUnderTest(makeId("prj", ulid()));
    ok(
      await c.declare("declare-1", {
        premises: [premise(LEAF, "per-request")],
        declaredEffects: [premise(LEAF, "per-session"), premise(key("billing.invoice"), "draft")],
      }),
    );
    const held = ok(decodeExit(ChangeCodecs.workspace, await c.stub.workspace()));

    expect([...held.subjects].toSorted()).toEqual([key("billing.invoice"), LEAF].toSorted());
  });
});
