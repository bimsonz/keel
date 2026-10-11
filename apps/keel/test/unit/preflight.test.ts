import { describe, expect, it } from "@effect/vitest";
import { declare, rely, revise } from "@keeltown/core/application/coordination";
import { Proposition } from "@keeltown/core/domain/coordination";
import { type ChangeId, CommitSha, makeId } from "@keeltown/core/kernel";
import { EventOutbox } from "@keeltown/core/ports";
import {
  makeCodeHostMemory,
  makeEventOutboxMemory,
  makeIdsMemory,
  makeLiveChangesMemory,
  makeManualClock,
  makeWorkspacePoolMemory,
  sampleProjectId,
  ulidOf,
} from "@keeltown/testing";
import { Effect, Layer, Schema } from "effect";

const A = makeId("chg", ulidOf(1));
const B = makeId("chg", ulidOf(2));
const agentA = makeId("agt", ulidOf(11));
const agentB = makeId("agt", ulidOf(12));

/** S1's pair: A relies on revocation taking effect per request; B's cache makes it per session. */
const freshPerRequest = Schema.decodeUnknownSync(Proposition)({
  subject: "authz.permission-evaluation",
  predicate: "freshness",
  relation: "at-most",
  value: "per-request",
});
const cachedPerSession = Schema.decodeUnknownSync(Proposition)({
  subject: "authz.permission-evaluation",
  predicate: "freshness",
  relation: "is",
  value: "per-session",
});

/** One project's live index, shared by its changes' objects, as the Project DO is. */
function project() {
  const live = makeLiveChangesMemory();
  /** One Change DO's state, in memory, reading the project's index. */
  const object = () =>
    Layer.mergeAll(
      makeEventOutboxMemory().layer,
      makeIdsMemory().layer,
      makeManualClock().layer,
      makeWorkspacePoolMemory({ baseSha: CommitSha.make("b".repeat(40)) }).layer,
      makeCodeHostMemory().layer,
      live.layer,
    );
  /** Declares in that object, then delivers its events to the index, as the fan-out does after commit. */
  const declared = (
    layer: ReturnType<typeof object>,
    changeId: ChangeId,
    intent: { premises?: Proposition[]; declaredEffects?: Proposition[] },
  ) =>
    Effect.gen(function* () {
      const answer = yield* declare({
        changeId,
        agentId: changeId === A ? agentA : agentB,
        projectId: sampleProjectId,
        origin: "agent",
        goal: changeId === A ? "owners can revoke collaborators" : "speed up permission checks",
        footprint: [],
        premises: intent.premises ?? [],
        ...(intent.declaredEffects === undefined
          ? {}
          : { declaredEffects: intent.declaredEffects }),
        idempotencyKey: `declare-${changeId}`,
        fingerprint: `declare-${changeId}`,
      });
      for (const event of (yield* EventOutbox).log({ kind: "change", id: changeId }))
        live.hear(sampleProjectId, event);
      return answer;
    }).pipe(Effect.provide(layer));
  return { object, declared };
}

describe("[b21.contradiction] A's premise and B's declared effect on one subject", () => {
  it.effect("[b21.contradiction] B's declare finds A's premise, and suggests refining", () =>
    Effect.gen(function* () {
      const { object, declared } = project();
      const first = yield* declared(object(), A, { premises: [freshPerRequest] });
      expect(first.preflight).toMatchObject({ contradictions: [], suggestedMove: "proceed" });
      const second = yield* declared(object(), B, { declaredEffects: [cachedPerSession] });
      expect(second.preflight.contradictions.map((found) => found.holder)).toEqual([A]);
      expect(second.preflight.suggestedMove).toBe("refine");
      expect(second.change.state).toBe("working");
    }),
  );

  it.effect("[b21.contradiction] A's declare finds B's declared effect when B came first", () =>
    Effect.gen(function* () {
      const { object, declared } = project();
      yield* declared(object(), B, { declaredEffects: [cachedPerSession] });
      const second = yield* declared(object(), A, { premises: [freshPerRequest] });
      // `holder` names the premise's holder, A itself; B is the neighbour whose effect it meets.
      expect(second.preflight.contradictions).toEqual([
        { premise: freshPerRequest, with: cachedPerSession, holder: A },
      ]);
      expect(second.preflight.neighbours.map((found) => found.changeId)).toEqual([B]);
      expect(second.preflight.suggestedMove).toBe("refine");
    }),
  );
});

describe("[b21.revise-preflight] a revision's preflight reads the intent it leaves", () => {
  it.effect("[b21.revise-preflight] B's revision adding the cache finds A's premise", () =>
    Effect.gen(function* () {
      const { object, declared } = project();
      yield* declared(object(), A, { premises: [freshPerRequest] });
      const layerB = object();
      const before = yield* declared(layerB, B, {});
      expect(before.preflight.contradictions).toEqual([]);
      const revised = yield* revise(B, {
        agentId: agentB,
        leaseId: before.change.lease.id,
        ifMatchRevision: 1,
        premisesAdded: [],
        premisesRetracted: [],
        declaredEffects: [cachedPerSession],
        idempotencyKey: "revise-b",
      }).pipe(Effect.provide(layerB));
      expect(revised.preflight.contradictions.map((found) => found.holder)).toEqual([A]);
      expect(revised.preflight.suggestedMove).toBe("refine");
    }),
  );
});

/** A's effect: deploys run before migrations, written from the lesser event, as stored. */
const deployBeforeMigrate = Schema.decodeUnknownSync(Proposition)({
  subject: "deploy",
  predicate: "ordering",
  relation: "before",
  value: "migrate",
});
/** B's premise, written from the other event: migrations run before deploys, i.e. deploy after migrate. */
const migrateBeforeDeploy = Schema.decodeUnknownSync(Proposition)({
  subject: "migrate",
  predicate: "ordering",
  relation: "before",
  value: "deploy",
});

describe("[b21.canonical] an ordering written from either event is compared and subscribed as one", () => {
  it.effect(
    "[b21.canonical] B's declared premise, written from the other event, meets A's held ordering, and B subscribes the canonical subject",
    () =>
      Effect.gen(function* () {
        const { object, declared } = project();
        yield* declared(object(), A, { declaredEffects: [deployBeforeMigrate] });
        const layerB = object();
        const second = yield* declared(layerB, B, { premises: [migrateBeforeDeploy] });
        expect(second.preflight.contradictions.map((found) => found.holder)).toEqual([B]);
        expect(second.preflight.suggestedMove).toBe("refine");
        const hearing = yield* Effect.map(EventOutbox, (outbox) =>
          outbox
            .subscribers("IntentRevised", { entity: { kind: "change", id: B }, affected: [] })
            .filter((subscriber) => subscriber.startsWith("subj:")),
        ).pipe(Effect.provide(layerB));
        expect(hearing).toEqual([`subj:${sampleProjectId}:deploy`]);
      }),
  );

  it.effect(
    "[b21.canonical] B's relied premise, written from the other event, meets A's held ordering",
    () =>
      Effect.gen(function* () {
        const { object, declared } = project();
        yield* declared(object(), A, { declaredEffects: [deployBeforeMigrate] });
        const layerB = object();
        const before = yield* declared(layerB, B, {});
        expect(before.preflight.contradictions).toEqual([]);
        const relied = yield* rely(B, {
          agentId: agentB,
          leaseId: before.change.lease.id,
          premise: migrateBeforeDeploy,
          idempotencyKey: "rely-b",
        }).pipe(Effect.provide(layerB));
        expect(relied.preflight.contradictions.map((found) => found.holder)).toEqual([B]);
        expect(relied.change.intent.premises.map((premise) => premise.subject)).toEqual(["deploy"]);
      }),
  );
});
