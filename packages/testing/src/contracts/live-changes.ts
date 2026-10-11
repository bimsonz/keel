import { describe, expect, it } from "@effect/vitest";
import type { Intent } from "@keeltown/core/domain/coordination";
import { type ChangeId, EventEnvelope, makeId, ProjectId } from "@keeltown/core/kernel";
import { LiveChanges } from "@keeltown/core/ports";
import { Effect, type Layer, Schema } from "effect";

/** The `LiveChanges` suite feeds each adapter's index an event of one of a project's changes, as the fan-out would. */
export interface LiveChangesHarness {
  readonly layer: Layer.Layer<LiveChanges>;
  readonly hear: (projectId: ProjectId, event: EventEnvelope) => Effect.Effect<void>;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ulid = () =>
  [...crypto.getRandomValues(new Uint8Array(26))].map((b) => CROCKFORD[b % 32] ?? "0").join("");
let seq = 0;

/** An event of `changeId`, encoded as the fan-out delivers it. */
function eventOf(changeId: ChangeId, payload: { readonly _tag: string } & Record<string, unknown>) {
  seq += 1;
  return Schema.decodeUnknownSync(EventEnvelope)({
    eventId: makeId("evt", ulid()),
    type: payload._tag,
    entity: { kind: "change", id: changeId },
    seq,
    at: Date.now(),
    dedupeKey: `change:${changeId}/cause-${seq}/${payload._tag}#1`,
    affected: [],
    notified: [],
    payload,
  });
}

const premise = {
  subject: "authz.permission-evaluation",
  predicate: "freshness",
  relation: "at-most",
  value: "per-request",
};

const declared = (changeId: ChangeId) =>
  eventOf(changeId, {
    _tag: "IntentDeclared",
    changeId,
    agentId: makeId("agt", ulid()),
    origin: "agent",
    revision: 1,
    goal: "cache the sessions",
    footprint: [],
    premises: [premise],
    leaseId: makeId("lse", ulid()),
  });

export function describeLiveChangesContract(adapter: string, make: () => LiveChangesHarness) {
  describe(`LiveChanges contract: ${adapter}`, () => {
    it.live(
      "[b21.live-index] keeps each change from its declare to its end, revisions folded, per project",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const projectId = Schema.decodeUnknownSync(ProjectId)(`prj_${ulid()}`);
          const other = Schema.decodeUnknownSync(ProjectId)(`prj_${ulid()}`);
          const first = makeId("chg", ulid());
          const second = makeId("chg", ulid());
          yield* harness.hear(projectId, declared(first));
          yield* harness.hear(projectId, declared(second));
          yield* harness.hear(other, declared(makeId("chg", ulid())));
          yield* harness.hear(
            projectId,
            eventOf(first, {
              _tag: "IntentRevised",
              changeId: first,
              revision: 2,
              goal: "cache the sessions for longer",
              premisesAdded: [],
              premisesRetracted: [premise],
            }),
          );
          yield* harness.hear(
            projectId,
            eventOf(second, {
              _tag: "ChangeWithdrawn",
              changeId: second,
              by: "agent",
            }),
          );
          const live = yield* (yield* LiveChanges).of(projectId);
          const expected: Intent = {
            revision: 2,
            goal: "cache the sessions for longer",
            footprint: [],
            premises: [],
          };
          expect(live).toEqual([{ id: first, intent: expected, derived: [] }]);
        }).pipe(Effect.provide(harness.layer));
      },
    );
  });
}
