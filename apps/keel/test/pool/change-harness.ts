import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { type Change, ChangeEvent, evolveChange } from "@keeltown/core/domain/coordination";
import { type ChangeId, type EventEnvelope, makeId } from "@keeltown/core/kernel";
import { CodeHost, type Clock, EventOutbox } from "@keeltown/core/ports";
import {
  CodeHostFixture,
  makeCodeHostMemory,
  makeManualClock,
  makeWorkspacePoolMemory,
  sampleProjectId,
} from "@keeltown/testing";
import { Effect, Exit, Layer, ManagedRuntime, Schema } from "effect";
import { ulid } from "ulid";
import type { ChangeDO } from "../../src/adapters/driving/do/change.ts";
import { backbone, type ChangeServices } from "../../src/composition/do.ts";
import { ChangeCodecs, decodeExit } from "../../src/rpc/index.ts";
import { drainAfter } from "./helpers.ts";

export const changeStub = (changeId = makeId("chg", ulid())) =>
  drainAfter(env.CHANGE.get(env.CHANGE.idFromName(`change:${changeId}`)));

/**
 * Runs the Change DO on these driven adapters (and, when given, this clock)
 * instead of its composition's. Test-only: it replaces the instance's runtime
 * from inside the object, so production code carries no hook for it. The pool
 * tests share the object's isolate, so an in-memory adapter here is the same
 * one the test inspects.
 */
export function rewire(
  stub: DurableObjectStub<ChangeDO>,
  driven: Layer.Layer<ChangeServices>,
  clock?: Layer.Layer<Clock>,
): Promise<void> {
  return runInDurableObject(stub, (instance: ChangeDO, state) => {
    const services = Layer.mergeAll(backbone(state.storage), driven);
    Reflect.set(
      instance,
      "runtime",
      ManagedRuntime.make(clock === undefined ? services : Layer.merge(services, clock)),
    );
  });
}

/** The value of a successful Exit; a failure throws with its cause, so a test sees why. */
export function ok<A, E>(exit: Exit.Exit<A, E>): A {
  if (Exit.isSuccess(exit)) return exit.value;
  throw new Error(`expected success, got ${JSON.stringify(exit.cause)}`);
}

/** The tag a failed Exit carries, or "success". */
export const refusal = (exit: Exit.Exit<unknown, unknown>): string =>
  Exit.isFailure(exit) ? JSON.stringify(exit.cause) : "success";

/** Folds the change's log with the domain's `evolve`: the state the events say. */
export const replayed = (log: readonly EventEnvelope[]): Change | undefined =>
  log.reduce<Change | undefined>(
    (state, event) =>
      evolveChange(state, {
        at: event.at,
        payload: Schema.decodeUnknownSync(ChangeEvent)(event.payload),
      }),
    undefined,
  );

/** A change without its lease's `renewedAt`: a renewal is state, not an event, so replay cannot rebuild it. */
export const unrenewed = (change: Change | undefined) =>
  change === undefined ? undefined : { ...change, lease: { ...change.lease, renewedAt: 0 } };

/**
 * A Change DO under test, reached over real RPC: an in-memory pool and code
 * host, and a clock that starts now and moves only when told, so a lease can
 * lapse without waiting and no deadline it arms is in the past.
 */
export async function changeUnderTest() {
  const changeId: ChangeId = makeId("chg", ulid());
  const agentId = makeId("agt", ulid());
  const stub = changeStub(changeId);
  // Drained after the change: what it delivers to its agent, pool and lane may owe flushes of their own.
  drainAfter(env.AGENT_SESSION.get(env.AGENT_SESSION.idFromName(`agent:${agentId}`)));
  drainAfter(env.WORKSPACE_POOL.get(env.WORKSPACE_POOL.idFromName(`pool:${sampleProjectId}`)));
  drainAfter(env.LANE.get(env.LANE.idFromName(`lane:${sampleProjectId}:main`)));
  const clock = makeManualClock(Date.now());
  const pool = makeWorkspacePoolMemory();
  const code = makeCodeHostMemory();
  await rewire(stub, Layer.merge(pool.layer, code.layer), clock.layer);

  const get = async () => decodeExit(ChangeCodecs.get, await stub.get());
  return {
    changeId,
    agentId,
    stub,
    clock,
    pool,
    get,
    /** The change as it stands; throws if it cannot be read. */
    current: async () => ok(await get()),
    declare: async (idempotencyKey = "declare-1") =>
      decodeExit(
        ChangeCodecs.declare,
        await stub.declare({
          changeId,
          agentId,
          projectId: sampleProjectId,
          goal: "Cache permission lookups per request",
          footprint: [{ path: "src/authz/**", op: "edit" }],
          premises: [],
          idempotencyKey,
          fingerprint: `body-${idempotencyKey}`,
        }),
      ),
    /** Pushes a commit to the change's workspace, as its agent would, and returns its sha. */
    push: async () => {
      const held = ok(decodeExit(ChangeCodecs.workspace, await stub.workspace()));
      return Effect.runPromise(
        Effect.gen(function* () {
          yield* (yield* CodeHost).create(held.repo);
          return yield* (yield* CodeHostFixture).commit(held.repo, "refs/heads/main", {
            "a.txt": "a",
          });
        }).pipe(Effect.provide(code.layer)),
      );
    },
    /** The change's events, in `seq` order. */
    log: () =>
      runInDurableObject(stub, (instance: ChangeDO) =>
        instance["runtime"].runPromise(
          Effect.map(EventOutbox, (outbox) => outbox.log({ kind: "change", id: changeId })),
        ),
      ),
  };
}
export type ChangeUnderTest = Awaited<ReturnType<typeof changeUnderTest>>;
