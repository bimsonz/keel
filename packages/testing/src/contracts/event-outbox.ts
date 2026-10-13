import { describe, expect, it } from "@effect/vitest";
import { Actor, ChangeId, type EntityRef, type EventEnvelope, RunRef } from "@keeltown/core/kernel";
import {
  type Clock,
  commit,
  EntityStore,
  type EventDraft,
  EventOutbox,
  flushOutbox,
  REDELIVERY_CAP_MS,
  STUCK_AFTER_ATTEMPTS,
} from "@keeltown/core/ports";
import { Effect, Exit, Layer, Result, Schema } from "effect";
import {
  type ManualClock,
  makeEventOutboxMemory,
  makeManualClock,
  makeScriptedFanOut,
  type ScriptedFanOut,
} from "../memory/event-outbox.ts";

export type OutboxServices = EventOutbox | EntityStore | Clock;

/**
 * One outbox for one test. `run` executes a program against it, inside
 * whatever context its storage needs (a Durable Object's, for DO SQLite);
 * every `run` in a test sees the same storage.
 */
export interface OutboxHarness {
  readonly run: <A, E>(program: Effect.Effect<A, E, OutboxServices>) => Effect.Effect<A, E>;
  readonly fanOut: ScriptedFanOut;
  readonly clock: ManualClock;
}

/** The in-memory harness: the memory outbox, its memory store and a manual clock. */
export function memoryOutboxHarness(): OutboxHarness {
  const outbox = makeEventOutboxMemory();
  const clock = makeManualClock();
  const layer = Layer.mergeAll(outbox.layer, clock.layer);
  return { run: (program) => Effect.provide(program, layer), fanOut: makeScriptedFanOut(), clock };
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const randomUlid = () =>
  [...crypto.getRandomValues(new Uint8Array(26))].map((b) => CROCKFORD[b % 32] ?? "0").join("");

/** A fresh change per call: a real adapter's storage may outlive one test. */
const change = (): EntityRef => ({
  kind: "change",
  id: Schema.decodeUnknownSync(ChangeId)(`chg_${randomUlid()}`),
});
const cause = () => `cause-${randomUlid()}`;

/** A change's event of `tag`, on the change itself. */
const changeEvent = (tag: string, entity: EntityRef): EventDraft => ({
  entity,
  payload: { _tag: tag, changeId: entity.id },
});
const started = (entity: EntityRef, revision: number, type = "PrecheckStarted"): EventDraft => ({
  payload: { _tag: type, changeId: entity.id, revision, instanceId: `instance-${revision}` },
});

/** Commits `count` events for `entity` under a fresh cause. */
const emit = (entity: EntityRef, count = 1, type?: string) =>
  commit({ entity, cause: cause() }, () =>
    Result.succeed({
      drafts: Array.from({ length: count }, (_, i) => started(entity, i + 1, type)),
      value: null,
    }),
  );

const log = (entity: EntityRef) => Effect.map(EventOutbox, (outbox) => outbox.log(entity));
const flush = (h: OutboxHarness) => h.run(flushOutbox(h.fanOut.fanOut));
const ids = (events: readonly EventEnvelope[]) => events.map((event) => event.eventId);

/** An event about `entity` alone, as a scoped subscriber is matched against it. */
const aboutOnly = (entity: EntityRef) => ({ entity, affected: [] });

export function describeEventOutboxContract(adapter: string, harness: () => OutboxHarness) {
  describe(`EventOutbox contract: ${adapter}`, () => {
    it.effect(
      "[run.envelope] every event a commit makes names the run whose command it was, beside the actor, and a commit that names none stamps none",
      () =>
        Effect.gen(function* () {
          const h = harness();
          const entity = change();
          const actor = Schema.decodeUnknownSync(Actor)(`agent:agt_${randomUlid()}`);
          const run = Schema.decodeUnknownSync(RunRef)({
            id: `run_${randomUlid()}`,
            label: "run-c",
          });
          const unlabelled = Schema.decodeUnknownSync(RunRef)({ id: `run_${randomUlid()}` });
          const one = (revision: number) =>
            Result.succeed({ drafts: [started(entity, revision)], value: null });
          const events = yield* h.run(
            Effect.gen(function* () {
              yield* commit({ entity, cause: cause(), actor, run }, () =>
                Result.succeed({ drafts: [started(entity, 1), started(entity, 2)], value: null }),
              );
              yield* commit({ entity, cause: cause(), actor, run: unlabelled }, () => one(3));
              yield* commit({ entity, cause: cause(), actor }, () => one(4));
              yield* emit(entity);
              return yield* log(entity);
            }),
          );
          expect(events.map((event) => [event.actor, event.run])).toEqual([
            [actor, run],
            [actor, run],
            [actor, unlabelled],
            [actor, undefined],
            [undefined, undefined],
          ]);
          expect(events.map((event) => "run" in event)).toEqual([true, true, true, false, false]);
        }),
    );
    it.effect(
      "numbers each entity's events 1..n, gap-free and independently of other entities",
      () =>
        Effect.gen(function* () {
          const h = harness();
          const [a, b] = [change(), change()];
          const logs = yield* h.run(
            Effect.gen(function* () {
              yield* emit(a, 2);
              yield* emit(b);
              yield* emit(a);
              yield* emit(b, 2);
              return [yield* log(a), yield* log(b)] as const;
            }),
          );
          expect(logs.map((events) => events.map((event) => event.seq))).toEqual([
            [1, 2, 3],
            [1, 2, 3],
          ]);
        }),
    );

    it.effect(
      "[b11.draft-entity] numbers a draft for another entity on that entity's own seq, in the same commit",
      () =>
        Effect.gen(function* () {
          const h = harness();
          const a = change();
          const verdict: EntityRef = { kind: "verdict", id: `vrd_${randomUlid()}` };
          const issued = (n: number): EventDraft => ({
            entity: verdict,
            payload: { _tag: "VerdictIssued", verdictId: verdict.id, n },
          });
          const logs = yield* h.run(
            Effect.gen(function* () {
              yield* emit(a, 2);
              yield* commit({ entity: a, cause: cause() }, () =>
                Result.succeed({ drafts: [issued(1), started(a, 3)], value: null }),
              );
              yield* commit({ entity: a, cause: cause() }, () =>
                Result.succeed({ drafts: [started(a, 4), issued(2)], value: null }),
              );
              return [yield* log(a), yield* log(verdict)] as const;
            }),
          );
          const [ofChange, ofVerdict] = logs;
          expect(ofChange.map((event) => [event.type, event.seq])).toEqual([
            ["PrecheckStarted", 1],
            ["PrecheckStarted", 2],
            ["PrecheckStarted", 3],
            ["PrecheckStarted", 4],
          ]);
          expect(ofVerdict.map((event) => [event.entity, event.seq])).toEqual([
            [verdict, 1],
            [verdict, 2],
          ]);
          expect(
            ofVerdict.every((event) => event.dedupeKey.startsWith(`verdict:${verdict.id}/`)),
          ).toBe(true);
        }),
    );

    it.effect(
      "[b1.seq-gap-free] writes nothing and consumes no seq when a transition is refused or throws",
      () =>
        Effect.gen(function* () {
          const h = harness();
          const entity = change();
          const outcome = yield* h.run(
            Effect.gen(function* () {
              yield* emit(entity);
              const refused = yield* Effect.exit(
                commit({ entity, cause: cause() }, ({ store }) => {
                  store.put("probe", entity.id, "written by a refused transition");
                  return Result.fail("refused" as const);
                }),
              );
              const threw = yield* Effect.exit(
                commit({ entity, cause: cause() }, ({ store }) => {
                  store.put("probe", entity.id, "written by a throwing transition");
                  throw new Error("decision threw");
                }),
              );
              yield* emit(entity);
              const store = yield* EntityStore;
              return {
                refused,
                threw,
                state: store.get("probe", entity.id) ?? null,
                seqs: (yield* log(entity)).map((event) => event.seq),
              };
            }),
          );
          expect(outcome.refused).toEqual(Exit.fail("refused"));
          expect(Exit.isFailure(outcome.threw)).toBe(true);
          expect(outcome.state).toBeNull();
          expect(outcome.seqs).toEqual([1, 2]);
        }),
    );

    it.effect(
      "[b1.commit-atomic] [b1.seq-gap-free] rolls back the state written with an event the envelope rejects, and leaves no gap",
      () =>
        Effect.gen(function* () {
          const h = harness();
          const entity = change();
          const outcome = yield* h.run(
            Effect.gen(function* () {
              const rejected = yield* Effect.exit(
                commit({ entity, cause: cause() }, ({ store }) => {
                  store.put("probe", entity.id, "written with a rejected event");
                  return Result.succeed({
                    drafts: [started(entity, 1), { payload: { _tag: "" } }],
                    value: null,
                  });
                }),
              );
              const store = yield* EntityStore;
              const state = store.get("probe", entity.id) ?? null;
              yield* emit(entity);
              return { rejected, state, seqs: (yield* log(entity)).map((event) => event.seq) };
            }),
          );
          expect(Exit.isFailure(outcome.rejected)).toBe(true);
          expect(outcome.state).toBeNull();
          expect(outcome.seqs).toEqual([1]);
        }),
    );

    it.effect(
      "[b1.dedupe-ordinal] gives one transition's events of one type distinct dedupe keys",
      () =>
        Effect.gen(function* () {
          const h = harness();
          const entity = change();
          const events = yield* h.run(
            Effect.gen(function* () {
              yield* commit({ entity, cause: "debounce@1" }, () =>
                Result.succeed({
                  drafts: [1, 2, 3].map((n) => started(entity, n, "PromotionDeclined")),
                  value: null,
                }),
              );
              return yield* log(entity);
            }),
          );
          expect(events.map((event) => event.dedupeKey)).toEqual(
            [1, 2, 3].map((n) => `change:${entity.id}/debounce@1/PromotionDeclined#${n}`),
          );
        }),
    );

    it.effect(
      "[b1.cause-once] commits nothing for a replayed cause, and tells a different command under it apart",
      () =>
        Effect.gen(function* () {
          const h = harness();
          const entity = change();
          let decisions = 0;
          const decide = () => {
            decisions += 1;
            return Result.succeed({ drafts: [started(entity, 1)], value: "first" });
          };
          const outcome = yield* h.run(
            Effect.gen(function* () {
              const first = yield* commit(
                { entity, cause: "key-1", fingerprint: "submit:abc" },
                decide,
              );
              const retry = yield* commit(
                { entity, cause: "key-1", fingerprint: "submit:abc" },
                decide,
              );
              const reused = yield* commit(
                { entity, cause: "key-1", fingerprint: "submit:def" },
                decide,
              );
              return { first, retry, reused, log: yield* log(entity) };
            }),
          );
          expect(decisions).toBe(1);
          expect(outcome.first.duplicate).toBe(false);
          expect(outcome.retry).toEqual({
            duplicate: true,
            sameCommand: true,
            events: outcome.first.events,
          });
          expect(outcome.reused).toMatchObject({ duplicate: true, sameCommand: false });
          expect(ids(outcome.log)).toEqual(ids(outcome.first.events));
        }),
    );

    it.effect(
      "[b1.notified-at-commit] records in notified[] the subscribers of the event's type at commit time",
      () =>
        Effect.gen(function* () {
          const h = harness();
          const entity = change();
          const notified = yield* h.run(
            Effect.gen(function* () {
              const outbox = yield* EventOutbox;
              yield* commit({ entity, cause: cause() }, () => {
                outbox.subscribe("agent:a", "*");
                outbox.subscribe("lane:p:b", ["ChangeSubmitted"]);
                return Result.succeed({ drafts: [started(entity, 1)], value: null });
              });
              yield* commit({ entity, cause: cause() }, () => {
                outbox.subscribe("lane:p:b", ["PrecheckStarted"]);
                return Result.succeed({ drafts: [started(entity, 2)], value: null });
              });
              yield* commit({ entity, cause: cause() }, () => {
                outbox.unsubscribe("agent:a");
                return Result.succeed({ drafts: [started(entity, 3)], value: null });
              });
              return (yield* log(entity)).map((event) => event.notified);
            }),
          );
          expect(notified).toEqual([["agent:a"], ["agent:a", "lane:p:b"], ["lane:p:b"]]);
        }),
    );

    it.effect(
      "[b1.owed-stays-owed] keeps a delivery owed at commit after its subscriber unsubscribes",
      () =>
        Effect.gen(function* () {
          const h = harness();
          const entity = change();
          const committed = yield* h.run(
            Effect.gen(function* () {
              const outbox = yield* EventOutbox;
              const done = yield* commit({ entity, cause: cause() }, () => {
                outbox.subscribe("agent:a", "*");
                return Result.succeed({ drafts: [started(entity, 1)], value: null });
              });
              yield* commit({ entity, cause: cause() }, () => {
                outbox.unsubscribe("agent:a");
                return Result.succeed({ drafts: [], value: null });
              });
              return done;
            }),
          );
          yield* flush(h);
          expect(ids(h.fanOut.deliveredTo("agent:a"))).toEqual(ids(committed.events));
        }),
    );

    it.effect(
      "[b1.ack-after-delivery] [b1.backoff-capped] [b1.nudge] acknowledges a delivery only once taken, retrying after 1 s and doubling to a 60 s cap",
      () =>
        Effect.gen(function* () {
          const h = harness();
          const entity = change();
          const committed = yield* h.run(
            Effect.gen(function* () {
              const outbox = yield* EventOutbox;
              return yield* commit({ entity, cause: cause() }, () => {
                outbox.subscribe("agent:a", "*");
                return Result.succeed({ drafts: [started(entity, 1)], value: null });
              });
            }),
          );
          h.fanOut.failing.add("agent:a");
          const delays: number[] = [];
          for (let attempt = 1; attempt <= 8; attempt += 1) {
            const report = yield* flush(h);
            expect(report).toMatchObject({ delivered: 0, failed: ["agent:a"] });
            const owed = yield* h.run(Effect.map(EventOutbox, (outbox) => outbox.backlog()));
            expect(owed).toEqual([
              {
                subscriber: "agent:a",
                pending: 1,
                attempts: attempt,
                nextAttemptAt: report.nextAttemptAt,
              },
            ]);
            delays.push((report.nextAttemptAt ?? 0) - h.clock.now());
            // Not due yet: a flush now must not try again.
            const early = h.fanOut.attempts.length;
            yield* flush(h);
            expect(h.fanOut.attempts.length).toBe(early);
            h.clock.advance(delays.at(-1) ?? 0);
          }
          expect(delays).toEqual([
            1000,
            2000,
            4000,
            8000,
            16000,
            32000,
            REDELIVERY_CAP_MS,
            REDELIVERY_CAP_MS,
          ]);
          h.fanOut.failing.delete("agent:a");
          const report = yield* flush(h);
          expect(report).toEqual({ delivered: 1, failed: [], stuck: [] });
          expect(ids(h.fanOut.deliveredTo("agent:a"))).toEqual(ids(committed.events));
          expect(h.fanOut.nudges()).toBe(1);
          expect(yield* h.run(Effect.map(EventOutbox, (outbox) => outbox.backlog()))).toEqual([]);
        }),
    );

    it.effect(
      "holds back only a stalled subscriber's own deliveries, which then arrive in order",
      () =>
        Effect.gen(function* () {
          const h = harness();
          const entity = change();
          yield* h.run(
            Effect.gen(function* () {
              const outbox = yield* EventOutbox;
              yield* commit({ entity, cause: cause() }, () => {
                outbox.subscribe("agent:a", "*");
                outbox.subscribe("lane:p:b", "*");
                return Result.succeed({ drafts: [started(entity, 1)], value: null });
              });
              yield* emit(entity);
            }),
          );
          h.fanOut.failing.add("agent:a");
          yield* flush(h);
          const events = yield* h.run(log(entity));
          expect(ids(h.fanOut.deliveredTo("lane:p:b"))).toEqual(ids(events));
          expect(h.fanOut.deliveredTo("agent:a")).toEqual([]);
          h.fanOut.failing.delete("agent:a");
          h.clock.advance(1000);
          yield* flush(h);
          expect(ids(h.fanOut.deliveredTo("agent:a"))).toEqual(ids(events));
        }),
    );

    it.effect(
      "[b13.scoped] owes a scoped subscriber only the events about its scope, by entity or by affected",
      () =>
        Effect.gen(function* () {
          const h = harness();
          const [mine, other] = [change(), change()];
          const member = `change:${mine.id}`;
          const batch: EntityRef = { kind: "batch", id: `bat_${randomUlid()}` };
          const formed = (affected: readonly EntityRef[]): EventDraft => ({
            entity: batch,
            payload: { _tag: "BatchFormed", batchId: batch.id },
            affected,
          });
          const outcome = yield* h.run(
            Effect.gen(function* () {
              const outbox = yield* EventOutbox;
              const committed = yield* commit({ entity: batch, cause: cause() }, () => {
                outbox.subscribe(member, ["BatchFormed", "PrecheckStarted"], mine);
                return Result.succeed({
                  drafts: [
                    formed([other]),
                    formed([other, mine]),
                    { ...started(mine, 1), entity: mine },
                  ],
                  value: null,
                });
              });
              const about = { entity: batch, affected: [mine] };
              const heard = outbox.subscribers("BatchFormed", about);
              const unaddressed = outbox.subscribers("BatchFormed");
              outbox.unsubscribe(member);
              return {
                committed,
                heard,
                unaddressed,
                after: outbox.subscribers("BatchFormed", about),
              };
            }),
          );
          const [another, ours, own] = outcome.committed.events;
          expect(another?.notified).not.toContain(member);
          expect(ours?.notified).toContain(member);
          expect(own?.notified).toContain(member);
          expect(outcome.heard).toContain(member);
          expect(outcome.unaddressed).not.toContain(member);
          expect(outcome.after).not.toContain(member);
          yield* flush(h);
          expect(ids(h.fanOut.deliveredTo(member))).toEqual(
            ids([ours, own].filter((e) => e !== undefined)),
          );
        }),
    );

    it.effect(
      "[outbox.once] a one-shot subscriber is owed the first event that notifies it, in the append that commits it, and nothing after",
      () =>
        Effect.gen(function* () {
          const h = harness();
          const [mine, other] = [change(), change()];
          const probe = "workflow:Probe/probe-1";
          const steady = `change:${mine.id}`;
          const outcome = yield* h.run(
            Effect.gen(function* () {
              const outbox = yield* EventOutbox;
              outbox.subscribe(probe, ["ChangeSubmitted", "ChangeWithdrawn"], mine, { once: true });
              outbox.subscribe(steady, ["ChangeSubmitted", "ChangeWithdrawn"], mine);
              const unrelated = yield* commit({ entity: other, cause: cause() }, () =>
                Result.succeed({ drafts: [changeEvent("ChangeSubmitted", other)], value: null }),
              );
              const first = yield* commit({ entity: mine, cause: cause() }, () =>
                Result.succeed({
                  drafts: [
                    changeEvent("ChangeSubmitted", mine),
                    changeEvent("ChangeWithdrawn", mine),
                  ],
                  value: null,
                }),
              );
              const later = yield* commit({ entity: mine, cause: cause() }, () =>
                Result.succeed({ drafts: [changeEvent("ChangeSubmitted", mine)], value: null }),
              );
              return {
                unrelated,
                first,
                later,
                after: outbox.subscribers("ChangeSubmitted", { entity: mine, affected: [] }),
              };
            }),
          );
          // Out of its scope, it is not notified, so it is not spent.
          expect(outcome.unrelated.events[0]?.notified).not.toContain(probe);
          const [submitted, withdrawn] = outcome.first.events;
          expect(submitted?.notified).toContain(probe);
          expect(withdrawn?.notified).not.toContain(probe);
          expect(withdrawn?.notified).toContain(steady);
          expect(outcome.later.events[0]?.notified).not.toContain(probe);
          expect(outcome.after).toEqual([steady]);
          yield* flush(h);
          expect(ids(h.fanOut.deliveredTo(probe))).toEqual(
            ids([submitted].filter((e) => e !== undefined)),
          );
        }),
    );

    it.effect(
      "[outbox.unsubscribe-scope] a scoped unsubscribe drops only that scope: the subscriber's other scopes and unscoped types stay",
      () =>
        Effect.gen(function* () {
          const h = harness();
          const [mine, other] = [change(), change()];
          const agent = "agent:a";
          const outcome = yield* h.run(
            Effect.gen(function* () {
              const outbox = yield* EventOutbox;
              outbox.subscribe(agent, ["ConflictNoted"], mine);
              outbox.subscribe(agent, ["ConflictNoted"], other);
              outbox.subscribe(agent, ["ChangeLanded"]);
              outbox.unsubscribe(agent, ["ConflictNoted"], mine);
              const typed = {
                mine: outbox.subscribers("ConflictNoted", aboutOnly(mine)),
                other: outbox.subscribers("ConflictNoted", aboutOnly(other)),
                unscoped: outbox.subscribers("ChangeLanded"),
              };
              outbox.unsubscribe(agent, undefined, other);
              return {
                typed,
                other: outbox.subscribers("ConflictNoted", aboutOnly(other)),
                unscoped: outbox.subscribers("ChangeLanded"),
              };
            }),
          );
          expect(outcome.typed.mine).not.toContain(agent);
          expect(outcome.typed.other).toContain(agent);
          expect(outcome.typed.unscoped).toContain(agent);
          expect(outcome.other).not.toContain(agent);
          expect(outcome.unscoped).toContain(agent);
        }),
    );

    it.effect(
      "[b13.commit-order] delivers one commit's events to a subscriber in commit order, a retry included",
      () =>
        Effect.gen(function* () {
          const h = harness();
          const mine = change();
          const member = `change:${mine.id}`;
          const batch: EntityRef = { kind: "batch", id: `bat_${randomUlid()}` };
          const verdict: EntityRef = { kind: "verdict", id: `vrd_${randomUlid()}` };
          const committed = yield* h.run(
            Effect.gen(function* () {
              const outbox = yield* EventOutbox;
              return yield* commit({ entity: batch, cause: cause() }, () => {
                outbox.subscribe(member, ["VerdictIssued", "BatchFailed"], mine);
                return Result.succeed({
                  drafts: [
                    {
                      entity: verdict,
                      payload: { _tag: "VerdictIssued", verdictId: verdict.id, subject: batch.id },
                      affected: [mine],
                    },
                    {
                      entity: batch,
                      payload: { _tag: "BatchFailed", batchId: batch.id, verdictId: verdict.id },
                      affected: [mine],
                    },
                  ],
                  value: null,
                });
              });
            }),
          );
          h.fanOut.failing.add(member);
          yield* flush(h);
          h.fanOut.failing.delete(member);
          h.clock.advance(1000);
          yield* flush(h);
          // The failed attempt and the retry both carry the commit's order: the verdict first.
          const tried = h.fanOut.attempts.filter((attempt) => attempt.subscriber === member);
          expect(tried.map((attempt) => attempt.eventIds)).toEqual([
            ids(committed.events),
            ids(committed.events),
          ]);
          expect(h.fanOut.deliveredTo(member).map((event) => event.type)).toEqual([
            "VerdictIssued",
            "BatchFailed",
          ]);
        }),
    );

    it.effect(
      `reports a backlog stuck after ${STUCK_AFTER_ATTEMPTS} failed attempts, and keeps retrying it`,
      () =>
        Effect.gen(function* () {
          const h = harness();
          const entity = change();
          yield* h.run(
            Effect.gen(function* () {
              const outbox = yield* EventOutbox;
              yield* commit({ entity, cause: cause() }, () => {
                outbox.subscribe("agent:a", "*");
                return Result.succeed({ drafts: [started(entity, 1)], value: null });
              });
            }),
          );
          h.fanOut.failing.add("agent:a");
          const stuck: number[] = [];
          for (let attempt = 1; attempt <= STUCK_AFTER_ATTEMPTS + 1; attempt += 1) {
            const report = yield* flush(h);
            stuck.push(report.stuck.length);
            h.clock.advance(REDELIVERY_CAP_MS);
          }
          expect(stuck).toEqual([
            ...Array.from({ length: STUCK_AFTER_ATTEMPTS - 1 }, () => 0),
            1,
            1,
          ]);
          expect(h.fanOut.attempts.length).toBe(STUCK_AFTER_ATTEMPTS + 1);
        }),
    );

    it.effect(
      "receives a dedupe key once, and forgets a receipt whose transaction rolled back",
      () =>
        Effect.gen(function* () {
          const h = harness();
          const key = `change:${change().id}/c/PrecheckStarted#1`;
          const rolledBack = `${key}-rolled-back`;
          const seen = yield* h.run(
            Effect.gen(function* () {
              const outbox = yield* EventOutbox;
              const store = yield* EntityStore;
              const now = h.clock.now();
              const first = outbox.receive(key, now);
              const again = outbox.receive(key, now);
              try {
                store.transaction(() => {
                  outbox.receive(rolledBack, now);
                  throw new Error("the reaction failed");
                });
              } catch {
                // The receipt went with the transaction.
              }
              return [first, again, outbox.receive(rolledBack, now)];
            }),
          );
          expect(seen).toEqual([true, false, true]);
        }),
    );

    it.effect("delivers nothing, nudges nothing and asks for no retry when nothing is owed", () =>
      Effect.gen(function* () {
        const h = harness();
        yield* h.run(emit(change()));
        expect(yield* flush(h)).toEqual({ delivered: 0, failed: [], stuck: [] });
        expect(h.fanOut.nudges()).toBe(0);
      }),
    );
  });
}
