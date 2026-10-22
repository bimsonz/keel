import { heldLease } from "@keeltown/testing";
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
import {
  type PredicatePolicies,
  Proposition,
  SubjectKey,
} from "@keeltown/core/domain/coordination";
import type { ConflictCommand, ProbeOutcome, World } from "@keeltown/core/domain/verification";
import {
  type AgentId,
  type ChangeId,
  type ConflictId,
  ContentHash,
  makeId,
  type ProjectId,
} from "@keeltown/core/kernel";
import { EntityStore, EventOutbox } from "@keeltown/core/ports";
import { Effect, Schema } from "effect";
import { ulid } from "ulid";
import { describe, expect, it, vi } from "vitest";
import type { ChangeDO } from "../../src/adapters/driving/do/change.ts";
import type { SubjectDO } from "../../src/adapters/driving/do/subject.ts";
import { AgentSessionCodecs, ChangeCodecs, decodeExit } from "../../src/rpc/index.ts";
import { type ChangeUnderTest, changeUnderTest, ok } from "./change-harness.ts";
import { drainAfter, drainOutbox } from "./helpers.ts";
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

/** Declares, pushes, submits and starts Precheck: the change is deriving, awaiting its plan. */
async function deriving(c: ChangeUnderTest) {
  const lease = heldLease(ok(await c.declare()).change).id;
  const commitSha = await c.push();
  ok(
    decodeExit(
      ChangeCodecs.submit,
      await c.stub.submit({
        agentId: c.agentId,
        projectId: c.projectId,
        leaseId: lease,
        commitSha,
        idempotencyKey: "s-1",
      }),
    ),
  );
  ok(
    decodeExit(
      ChangeCodecs.precheckStarted,
      await c.stub.precheckStarted({ revision: 1, instanceId: "p-1" }),
    ),
  );
}

const WAIT = { timeout: 15_000, interval: 100 };

/** Every notice in the agent's inbox, read from the start. */
async function inboxOf(agentId: AgentId) {
  const agent = env.AGENT_SESSION.get(env.AGENT_SESSION.idFromName(`agent:${agentId}`));
  return ok(decodeExit(AgentSessionCodecs.inbox, await agent.inbox({ waitMs: 0 }))).notices;
}

/** The change's events of one type, as its own DO committed them. */
const eventsOf = async (c: ChangeUnderTest, type: string) =>
  (await c.log()).filter((event) => event.type === type).map((event) => event.payload);

const compile = async (c: ChangeUnderTest, predicatePolicy?: PredicatePolicies) =>
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

  it("[b21.proven-blocks] [b21.policy-default] a plan compiled under block with a conflict proven against the change bounces it, citing the conflict; without a policy it queues", async () => {
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
    await vi.waitFor(async () => {
      expect(await partyRow(blocked, conflictId)).toBeDefined();
      expect(await partyRow(advised, conflictId)).toBeDefined();
    }, WAIT);
    await prove(projectId, conflictId);
    await vi.waitFor(async () => {
      expect(await partyRow(blocked, conflictId)).toMatchObject({ state: "proven" });
      expect(await partyRow(advised, conflictId)).toMatchObject({ state: "proven" });
    }, WAIT);

    const bounced = ok(await compile(blocked, { freshness: "block" }));
    const queued = ok(await compile(advised));

    expect(bounced).toMatchObject({ state: "bounced", predicatePolicy: { freshness: "block" } });
    expect(await eventsOf(blocked, "ChangeBounced")).toEqual([
      expect.objectContaining({
        conflictId,
        nextActions: expect.arrayContaining([expect.anything()]),
      }),
    ]);
    expect(await eventsOf(blocked, "ChangeQueued")).toEqual([]);
    expect(queued.state).toBe("queued");
  });

  it("[b21.proven-bounces] [b21.compile-policy] a queued change under block is bounced by a conflict proven against it, citing the conflict, and its lane is owed the bounce", async () => {
    await using precheck = await inertPrecheck();
    void precheck;
    const projectId = makeId("prj", ulid());
    const c = await changeUnderTest(projectId);
    await deriving(c);
    expect(ok(await compile(c, { freshness: "block" })).state).toBe("queued");
    expect(await eventsOf(c, "PlanCompiled")).toEqual([
      expect.objectContaining({ predicatePolicy: { freshness: "block" } }),
    ]);
    const conflictId = await suspect(projectId, [c.changeId]);
    await vi.waitFor(async () => expect(await partyRow(c, conflictId)).toBeDefined(), WAIT);
    await prove(projectId, conflictId);

    await vi.waitFor(async () => expect((await c.current()).state).toBe("bounced"), WAIT);
    expect(await eventsOf(c, "ChangeBounced")).toEqual([
      expect.objectContaining({
        conflictId,
        nextActions: expect.arrayContaining([expect.anything()]),
      }),
    ]);
    const owed = await runInDurableObject(c.stub, (instance: ChangeDO) =>
      instance["runtime"].runPromise(
        Effect.map(EventOutbox, (outbox) =>
          outbox.subscribers("ChangeBounced", {
            entity: { kind: "change", id: c.changeId },
            affected: [],
          }),
        ),
      ),
    );
    expect(owed).toContain(`lane:${projectId}:main`);
  });

  it("[b21.conflict-noted] a conflict proven against changes whose plans advise or annotate is noted on each, with the probe as evidence; the agent hears the advice and not the annotation", async () => {
    await using precheck = await inertPrecheck();
    void precheck;
    const projectId = makeId("prj", ulid());
    const [advised, annotated] = await Promise.all([
      changeUnderTest(projectId),
      changeUnderTest(projectId),
    ]);
    for (const [c, policy] of [
      [advised, "advise"],
      [annotated, "annotate"],
    ] as const) {
      await deriving(c);
      expect(ok(await compile(c, { freshness: policy })).state).toBe("queued");
    }
    const conflictId = await suspect(projectId, [advised.changeId, annotated.changeId]);
    await vi.waitFor(async () => {
      expect(await partyRow(advised, conflictId)).toBeDefined();
      expect(await partyRow(annotated, conflictId)).toBeDefined();
    }, WAIT);
    await prove(projectId, conflictId);
    await vi.waitFor(async () => {
      expect(await eventsOf(advised, "ConflictNoted")).toHaveLength(1);
      expect(await eventsOf(annotated, "ConflictNoted")).toHaveLength(1);
    }, WAIT);

    expect(await eventsOf(advised, "ConflictNoted")).toEqual([
      expect.objectContaining({
        conflictId,
        predicate: "freshness",
        policy: "advise",
        evidenceRef: expect.stringMatching(/^probe:prb_/),
      }),
    ]);
    expect(await eventsOf(annotated, "ConflictNoted")).toEqual([
      expect.objectContaining({ conflictId, policy: "annotate" }),
    ]);
    expect((await advised.current()).state).toBe("queued");
    await drainOutbox(advised.stub);
    await drainOutbox(annotated.stub);
    expect((await inboxOf(advised.agentId)).map((n) => n.kind)).toContain("ConflictNoted");
    expect((await inboxOf(annotated.agentId)).map((n) => n.kind)).not.toContain("ConflictNoted");
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
