import { describe, expect, it } from "@effect/vitest";
import { type EventEnvelope, VerdictId } from "@keeltown/core/kernel";
import { Verdicts } from "@keeltown/core/ports";
import { Effect, type Layer, Result } from "effect";
import { projectEvents } from "./project-views.ts";

/**
 * What the `Verdicts` suite needs beside the port: a way to make an event
 * arrive, as a committing object's outbox delivers it to the Projector. A real
 * Projector is shared, so every case works in a project of its own.
 */
export interface VerdictsHarness {
  readonly layer: Layer.Layer<Verdicts>;
  readonly arrive: (event: EventEnvelope) => Effect.Effect<void>;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ulid = () =>
  [...crypto.getRandomValues(new Uint8Array(26))].map((b) => CROCKFORD[b % 32] ?? "0").join("");
const id = (prefix: string) => `${prefix}_${ulid()}`;
const PLAN = `sha256:${"b".repeat(64)}`;

/** A verdict on a batch of `events`' project, as the lane commits it, with a plan when `planned`. */
function issued(
  events: ReturnType<typeof projectEvents>,
  outcome: "land" | "bounce",
  evidence: readonly string[],
  planned = true,
) {
  const verdictId = id("vrd");
  return events.of({ kind: "verdict", id: verdictId }, {
    _tag: "VerdictIssued",
    verdictId,
    subject: id("bat"),
    outcome,
    evidence,
    ...(planned ? { planHash: PLAN } : {}),
  } as { _tag: string });
}

/** What the index serves for an issued verdict: its event's payload, project and time. */
const indexed = (event: EventEnvelope) => ({
  verdict: event.payload,
  project: event.project,
  issuedAt: event.at,
});

export function describeVerdictsContract(adapter: string, make: () => VerdictsHarness) {
  describe(`Verdicts contract: ${adapter}`, () => {
    it.live(
      "[verdicts.contract] a verdict reads by its id alone, with the VerdictIssued that issued it, its project and when, another project's by its own id, and an id never issued is VerdictNotFound naming it",
      () => {
        const harness = make();
        const ours = projectEvents();
        const theirs = projectEvents();
        const landed = issued(ours, "land", ["passed: keel.test"]);
        const elsewhere = issued(theirs, "bounce", ["failed: keel.test"], false);
        return Effect.gen(function* () {
          yield* harness.arrive(landed);
          yield* harness.arrive(elsewhere);
          const verdicts = yield* Verdicts;

          expect(yield* verdicts.get(VerdictId.make(landed.entity.id))).toEqual(indexed(landed));
          expect(yield* verdicts.get(VerdictId.make(elsewhere.entity.id))).toEqual(
            indexed(elsewhere),
          );
          const never = VerdictId.make(id("vrd"));
          const missing = yield* Effect.result(verdicts.get(never));
          expect(Result.isFailure(missing) && missing.failure).toMatchObject({
            _tag: "VerdictNotFound",
            verdictId: never,
          });
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live(
      "[verdicts.contract] each of a project's verdicts reads as issued among the project's other events, and a verdict arriving after a read is found by the next",
      () => {
        const harness = make();
        const events = projectEvents();
        const changeId = id("chg");
        const first = issued(events, "bounce", ["failed: keel.test <src/a.test.ts>"]);
        const second = issued(events, "land", ["passed: keel.check", "passed: keel.test"]);
        const later = issued(events, "bounce", ["failed: keel.check"], false);
        return Effect.gen(function* () {
          for (const event of [
            events.declared(changeId, id("agt"), "Cache the sessions"),
            first,
            events.started(changeId),
            second,
          ])
            yield* harness.arrive(event);
          const verdicts = yield* Verdicts;

          expect(yield* verdicts.get(VerdictId.make(second.entity.id))).toEqual(indexed(second));
          expect(yield* verdicts.get(VerdictId.make(first.entity.id))).toEqual(indexed(first));
          yield* harness.arrive(later);
          expect(yield* verdicts.get(VerdictId.make(later.entity.id))).toEqual(indexed(later));
        }).pipe(Effect.provide(harness.layer));
      },
    );
  });
}
