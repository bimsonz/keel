import { describe, expect, it } from "@effect/vitest";
import {
  LIVE_ANCHOR,
  LIVE_CLAIM,
  LIVE_FOOTPRINT,
  LIVE_SUBJECT,
} from "@keeltown/core/application/coordination";
import { Intent, type LiveChange } from "@keeltown/core/domain/coordination";
import { type ChangeId, EventEnvelope, makeId, ProjectId } from "@keeltown/core/kernel";
import { LiveChanges } from "@keeltown/core/ports";
import { Effect, type Layer, Schema } from "effect";

/**
 * The `LiveChanges` suite feeds each adapter's index an event of one of a
 * project's changes, as the fan-out would, and reads the ids of the index's
 * rows of a kind, as the Project DO's storage holds them.
 */
export interface LiveChangesHarness {
  readonly layer: Layer.Layer<LiveChanges>;
  readonly hear: (projectId: ProjectId, event: EventEnvelope) => Effect.Effect<void>;
  readonly rows: (projectId: ProjectId, kind: string) => Effect.Effect<readonly string[]>;
  /** Every live change the index holds, read where it is kept. */
  readonly live: (projectId: ProjectId) => Effect.Effect<readonly LiveChange[]>;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ulid = () =>
  [...crypto.getRandomValues(new Uint8Array(26))].map((b) => CROCKFORD[b % 32] ?? "0").join("");
let seq = 0;

/** An event of `changeId`, encoded as the fan-out delivers it: at `position` on the change's log when given. */
function eventOf(
  changeId: ChangeId,
  payload: { readonly _tag: string } & Record<string, unknown>,
  position?: number,
) {
  seq += 1;
  return Schema.decodeUnknownSync(EventEnvelope)({
    eventId: makeId("evt", ulid()),
    type: payload._tag,
    entity: { kind: "change", id: changeId },
    seq: position ?? seq,
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

/** What a Precheck pass derived for `changeId`: one extractor's ruling that `subject` is cached per session. */
const derivation = (changeId: ChangeId, ref: string, subjects: readonly string[]) => ({
  _tag: "EffectsDerived" as const,
  changeId,
  revision: 1,
  effects: subjects.map((subject) => {
    const anchors = [{ path: `src/${subject}.ts`, commit: "c".repeat(40) }];
    return {
      proposition: {
        subject,
        predicate: "freshness",
        relation: "is",
        value: "per-session",
        anchors,
      },
      anchors,
      declared: false,
      method: "extractor",
      evidenceClass: "ruling",
    };
  }),
  derivationRef: ref,
});

/** A change declared with this intent, beside the premise `declared` gives. */
const declaredWith = (changeId: ChangeId, intent: Record<string, unknown>) =>
  eventOf(changeId, {
    _tag: "IntentDeclared",
    changeId,
    agentId: makeId("agt", ulid()),
    origin: "agent",
    revision: 1,
    goal: "cache the sessions",
    footprint: [],
    premises: [],
    leaseId: makeId("lse", ulid()),
    ...intent,
  });

const KEY_KINDS = [LIVE_SUBJECT, LIVE_FOOTPRINT, LIVE_ANCHOR, LIVE_CLAIM];
/** Change ids in the order the index lists them. */
const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

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
          const live = yield* harness.live(projectId);
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
    it.live(
      "[b21.index-derivation-order] holds the derivation latest on the change's log: a later one replaces it, an earlier one arriving late does not, though both are of one revision",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const projectId = Schema.decodeUnknownSync(ProjectId)(`prj_${ulid()}`);
          const changeId = makeId("chg", ulid());
          const derivedSubjects = Effect.map(harness.live(projectId), (live) =>
            live.map((row) => row.derived.map((effect) => effect.proposition.subject)),
          );
          yield* harness.hear(projectId, declared(changeId));
          yield* harness.hear(
            projectId,
            eventOf(changeId, derivation(changeId, "second", ["authz.sessions"]), 9),
          );
          yield* harness.hear(
            projectId,
            eventOf(changeId, derivation(changeId, "first", ["authz.tokens"]), 5),
          );
          const afterLate = yield* derivedSubjects;
          yield* harness.hear(
            projectId,
            eventOf(changeId, derivation(changeId, "third", ["billing.invoices"]), 12),
          );
          expect([afterLate, yield* derivedSubjects]).toEqual([
            [["authz.sessions"]],
            [["billing.invoices"]],
          ]);
        }).pipe(Effect.provide(harness.layer));
      },
    );
    it.live(
      "[t694.near-contract] reads the changes near an intent by key, in change id order, says what it compared, and an end takes every key row of the change",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const projectId = Schema.decodeUnknownSync(ProjectId)(`prj_${ulid()}`);
          const fresh = () => makeId("chg", ulid());
          const [relies, caches, elsewhere, edits, self] = [
            fresh(),
            fresh(),
            fresh(),
            fresh(),
            fresh(),
          ];
          const cache = { ...premise, relation: "is", value: "per-session" };
          const billing = { ...premise, subject: "billing.invoices" };
          // One relies on my premise's subject, with a row of every kind; one's cache breaks it;
          // one works elsewhere; one edits a file under my footprint, on a subject of its own.
          yield* harness.hear(
            projectId,
            declaredWith(relies, {
              premises: [{ ...premise, anchors: [{ path: "src/a|b.ts", commit: "a".repeat(40) }] }],
              declaredEffects: [billing],
              footprint: [{ path: "docs/*.md", op: "edit" }],
            }),
          );
          yield* harness.hear(projectId, declaredWith(caches, { declaredEffects: [cache] }));
          yield* harness.hear(
            projectId,
            declaredWith(elsewhere, {
              premises: [billing],
              footprint: [{ path: "docs/**", op: "edit" }],
            }),
          );
          yield* harness.hear(
            projectId,
            declaredWith(edits, {
              premises: [{ ...billing, subject: "search.ranking" }],
              footprint: [{ path: "src/authz/check.ts", op: "edit" }],
            }),
          );
          const intent = Schema.decodeUnknownSync(Intent)({
            revision: 1,
            goal: "revoke on every request",
            footprint: [{ path: "src/authz/**", op: "edit" }],
            premises: [premise],
          });
          const index = yield* LiveChanges;
          const rowsOf = (changeId: ChangeId) =>
            Effect.forEach(KEY_KINDS, (kind) =>
              Effect.map(harness.rows(projectId, kind), (ids) =>
                ids.filter((id) => id.endsWith(changeId)),
              ),
            );

          const near = yield* index.near(projectId, self, intent);
          const held = yield* rowsOf(relies);
          yield* harness.hear(
            projectId,
            eventOf(relies, { _tag: "ChangeWithdrawn", changeId: relies, by: "agent" }),
          );
          const after = yield* index.near(projectId, self, intent);

          expect(near.changes.map((live) => live.id)).toEqual(
            [relies, caches, edits].toSorted(byId),
          );
          expect(near.compared).toEqual({ changes: 3, subjects: 1 });
          expect(held).toEqual([
            [
              `authz.permission-evaluation/${relies}`,
              `authz/${relies}`,
              `billing.invoices/${relies}`,
              `billing/${relies}`,
            ],
            [`docs|${relies}`],
            [`src%2Fa%7Cb.ts|${relies}`],
            [
              expect.stringMatching(
                new RegExp(`^\\["\\{.*billing\\.invoices.*\\}"\\]\\|${relies}$`),
              ),
            ],
          ]);
          expect(after.changes.map((live) => live.id)).toEqual([caches, edits].toSorted(byId));
          expect(yield* rowsOf(relies)).toEqual([[], [], [], []]);
        }).pipe(Effect.provide(harness.layer));
      },
    );
  });
}
