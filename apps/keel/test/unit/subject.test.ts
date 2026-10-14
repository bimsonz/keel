import { describe, expect, it } from "@effect/vitest";
import {
  declare,
  hearSubject,
  rely,
  revise,
  SUBJECT_HELD,
  subjectAddress,
  subjectIdOf,
  SUBJECT_HEARS,
} from "@keeltown/core/application/coordination";
import { Proposition, SubjectKey } from "@keeltown/core/domain/coordination";
import { type ChangeId, CommitSha, idPattern, makeId, ProjectId } from "@keeltown/core/kernel";
import { EventOutbox } from "@keeltown/core/ports";
import {
  makeCodeHostMemory,
  makeEventOutboxMemory,
  makeIdsMemory,
  makeLiveChangesMemory,
  makeDecisionsMemory,
  makeManualClock,
  makeWorkspacePoolMemory,
  sampleProjectId,
  ulidOf,
} from "@keeltown/testing";
import { Effect, Layer, Schema } from "effect";

const A = makeId("chg", ulidOf(1));
const B = makeId("chg", ulidOf(2));
const key = (value: string) => Schema.decodeUnknownSync(SubjectKey)(value);
const proposition = (value: Record<string, unknown>) =>
  Schema.decodeUnknownSync(Proposition)(value);

const LEAF = key("authz.permission-evaluation");
const ROOT = key("authz");
const freshPerRequest = proposition({
  subject: LEAF,
  predicate: "freshness",
  relation: "at-most",
  value: "per-request",
  gloss: "a revocation takes effect on the next request",
});
const fastChecks = proposition({
  subject: "authz.permission-evaluation",
  predicate: "bound",
  relation: "at-most",
  value: "5ms",
});
const sessionsCached = proposition({
  subject: "sessions.cache",
  predicate: "freshness",
  relation: "is",
  value: "per-session",
});

/** A Change DO's state in memory, declaring and revising as the DO does. */
function changeObject() {
  return Layer.mergeAll(
    makeEventOutboxMemory().layer,
    makeIdsMemory().layer,
    makeManualClock().layer,
    makeWorkspacePoolMemory({ baseSha: CommitSha.make("b".repeat(40)) }).layer,
    makeCodeHostMemory().layer,
    makeLiveChangesMemory().layer,
    makeDecisionsMemory().layer,
  );
}

const declaring = (changeId: ChangeId, premises: readonly Proposition[]) =>
  declare({
    changeId,
    agentId: makeId("agt", ulidOf(changeId === A ? 11 : 12)),
    projectId: sampleProjectId,
    origin: "agent",
    goal: "owners can revoke collaborators",
    footprint: [],
    premises,
    idempotencyKey: `declare-${changeId}`,
    fingerprint: `declare-${changeId}`,
  });

const logOf = (changeId: ChangeId) =>
  Effect.map(EventOutbox, (outbox) => outbox.log({ kind: "change", id: changeId }));

/** The subjects the change's events reach, by the outbox's own scoped subscriptions. */
const subjectsHearing = (changeId: ChangeId) =>
  Effect.map(EventOutbox, (outbox) =>
    outbox
      .subscribers("IntentRevised", { entity: { kind: "change", id: changeId }, affected: [] })
      .filter((subscriber) => subscriber.startsWith("subj:"))
      .toSorted(),
  );

/** A Subject DO's store and outbox, in memory: what its reaction runs over. */
const subjectObject = () => {
  const memory = makeEventOutboxMemory();
  return { store: memory.store.service, outbox: memory.service };
};

describe("[b21.subject-id] a subject's id derives from its project and key", () => {
  it("[b21.subject-id] is a well-formed sub_ id, the same for the same pair, and differs by project and by key", () => {
    const other = Schema.decodeUnknownSync(ProjectId)(`prj_${ulidOf(99)}`);
    const id = subjectIdOf(sampleProjectId, LEAF);
    expect(id).toMatch(idPattern("sub"));
    expect(subjectIdOf(sampleProjectId, LEAF)).toBe(id);
    expect(subjectIdOf(other, LEAF)).not.toBe(id);
    expect(subjectIdOf(sampleProjectId, ROOT)).not.toBe(id);
  });
});

describe("[b21.relying-subscribes] relying on a subject subscribes it and its ancestors", () => {
  it.effect(
    "[b21.relying-subscribes] declare, revise and rely subscribe every premise's subject and its ancestors, scoped to the change",
    () =>
      Effect.gen(function* () {
        const declared = yield* declaring(A, [freshPerRequest]);
        expect(yield* subjectsHearing(A)).toEqual(
          [subjectAddress(sampleProjectId, ROOT), subjectAddress(sampleProjectId, LEAF)].toSorted(),
        );
        // Another change's events never reach them: the subscription is scoped to A.
        const unrelated = yield* Effect.map(EventOutbox, (outbox) =>
          outbox.subscribers("IntentRevised", { entity: { kind: "change", id: B }, affected: [] }),
        );
        expect(unrelated.filter((subscriber) => subscriber.startsWith("subj:"))).toEqual([]);

        yield* revise(A, {
          agentId: declared.change.agentId,
          leaseId: declared.change.lease.id,
          ifMatchRevision: 1,
          premisesAdded: [],
          premisesRetracted: [],
          declaredEffects: [sessionsCached],
          idempotencyKey: "revise-a",
        });
        yield* rely(A, {
          agentId: declared.change.agentId,
          leaseId: declared.change.lease.id,
          premise: proposition({
            subject: "billing.invoices.totals",
            predicate: "invariant",
            relation: "is",
            value: "half-even rounding",
          }),
          idempotencyKey: "rely-a",
        });
        expect(yield* subjectsHearing(A)).toEqual(
          [
            "authz",
            "authz.permission-evaluation",
            "sessions",
            "sessions.cache",
            "billing",
            "billing.invoices",
            "billing.invoices.totals",
          ]
            .map((subject) => subjectAddress(sampleProjectId, key(subject)))
            .toSorted(),
        );
        const types = yield* Effect.map(EventOutbox, (outbox) =>
          SUBJECT_HEARS.filter((type) =>
            outbox
              .subscribers(type, { entity: { kind: "change", id: A }, affected: [] })
              .includes(subjectAddress(sampleProjectId, ROOT)),
          ),
        );
        expect(types).toEqual([...SUBJECT_HEARS]);
      }).pipe(Effect.provide(changeObject())),
  );

  it.effect(
    "[b21.relying-subscribes] the premise's own subject mints once and relies each new premise; an ancestor mints and only keeps it",
    () =>
      Effect.gen(function* () {
        const leaf = subjectObject();
        const root = subjectObject();
        const hear = (changeId: ChangeId) =>
          Effect.map(logOf(changeId), (log) =>
            log.map((event) => ({
              leaf: hearSubject(leaf, sampleProjectId, LEAF, event),
              root: hearSubject(root, sampleProjectId, ROOT, event),
            })),
          );
        const a = changeObject();
        const declaredA = yield* declaring(A, [freshPerRequest]).pipe(Effect.provide(a));
        const heardA = yield* hear(A).pipe(Effect.provide(a));
        const leafId = subjectIdOf(sampleProjectId, LEAF);
        const rootId = subjectIdOf(sampleProjectId, ROOT);
        expect(heardA.map(({ leaf: reaction }) => reaction)).toContainEqual({
          entity: { kind: "subject", id: leafId },
          project: sampleProjectId,
          drafts: [
            {
              payload: {
                _tag: "SubjectMinted",
                subjectId: leafId,
                key: LEAF,
                anchors: [],
                gloss: "a revocation takes effect on the next request",
                mintedBy: "agent",
              },
            },
            {
              payload: {
                _tag: "PremiseRelied",
                subjectId: leafId,
                changeId: A,
                premise: Schema.encodeSync(Proposition)(freshPerRequest),
              },
            },
          ],
        });
        expect(heardA.map(({ root: reaction }) => reaction)).toContainEqual({
          entity: { kind: "subject", id: rootId },
          project: sampleProjectId,
          drafts: [
            {
              payload: {
                _tag: "SubjectMinted",
                subjectId: rootId,
                key: ROOT,
                anchors: [],
                gloss: "authz",
                mintedBy: "agent",
              },
            },
          ],
        });
        expect(root.store.get(SUBJECT_HELD, A)).toMatchObject({ premises: [{ subject: LEAF }] });

        // B relies on the same subject: no second mint, its own PremiseRelied.
        const b = changeObject();
        yield* declaring(B, [freshPerRequest]).pipe(Effect.provide(b));
        const heardB = yield* hear(B).pipe(Effect.provide(b));
        const leafDrafts = heardB.flatMap(({ leaf: reaction }) => reaction.drafts);
        expect(leafDrafts.map((draft) => draft.payload._tag)).toEqual(["PremiseRelied"]);
        expect(heardB.flatMap(({ root: reaction }) => reaction.drafts)).toEqual([]);

        // A adds a second premise at the leaf and retracts the first: only the new one is relied.
        const before = (yield* logOf(A).pipe(Effect.provide(a))).length;
        yield* revise(A, {
          agentId: declaredA.change.agentId,
          leaseId: declaredA.change.lease.id,
          ifMatchRevision: 1,
          premisesAdded: [fastChecks],
          premisesRetracted: [freshPerRequest],
          idempotencyKey: "revise-a",
        }).pipe(Effect.provide(a));
        const revised = (yield* logOf(A).pipe(Effect.provide(a))).slice(before);
        const relied = revised.flatMap(
          (event) => hearSubject(leaf, sampleProjectId, LEAF, event).drafts,
        );
        expect(relied).toEqual([
          {
            payload: {
              _tag: "PremiseRelied",
              subjectId: leafId,
              changeId: A,
              premise: Schema.encodeSync(Proposition)(fastChecks),
            },
          },
        ]);
        expect(leaf.store.get(SUBJECT_HELD, A)).toMatchObject({
          premises: [{ predicate: "bound" }],
        });

        // A revision that leaves the premise held relies nothing again.
        const held = (yield* logOf(A).pipe(Effect.provide(a))).length;
        yield* revise(A, {
          agentId: declaredA.change.agentId,
          leaseId: declaredA.change.lease.id,
          ifMatchRevision: 2,
          goal: "owners can revoke collaborators at once",
          premisesAdded: [],
          premisesRetracted: [],
          idempotencyKey: "revise-a-goal",
        }).pipe(Effect.provide(a));
        const unchanged = (yield* logOf(A).pipe(Effect.provide(a))).slice(held);
        expect(unchanged.map((event) => event.type)).toContain("IntentRevised");
        expect(
          unchanged.flatMap((event) => hearSubject(leaf, sampleProjectId, LEAF, event).drafts),
        ).toEqual([]);

        // An end drops the change.
        const [withdrawn] = revised;
        if (withdrawn === undefined) throw new Error("the revision committed nothing");
        hearSubject(leaf, sampleProjectId, LEAF, {
          ...withdrawn,
          type: "ChangeWithdrawn",
          payload: { _tag: "ChangeWithdrawn", changeId: A, by: "agent" },
        });
        expect(leaf.store.get(SUBJECT_HELD, A)).toBeUndefined();
        expect(leaf.store.get(SUBJECT_HELD, B)).toBeDefined();
      }),
  );
});
