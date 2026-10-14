import { introspectWorkflow, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import { type EntityRef, EventEnvelope, makeId } from "@keeltown/core/kernel";
import { commit, type EventDraft, EventOutbox } from "@keeltown/core/ports";
import { makeManualClock, makeScriptedFanOut, type OutboxHarness, PORTS } from "@keeltown/testing";
import { Effect, Exit, Layer, Result, Schema } from "effect";
import { ulid } from "ulid";
import { FanOutRpc, workflowInstanceId } from "../../src/adapters/driven/do-rpc/fan-out.ts";
import { EntityStoreSql } from "../../src/adapters/driven/do-storage/entity-store.ts";
import { EventOutboxSql } from "../../src/adapters/driven/do-storage/event-outbox.ts";
import type { AgentSessionDO } from "../../src/adapters/driving/do/agent-session.ts";
import {
  ALARM_START_LIMIT,
  armedAlarms,
  ALARM_RETRY_MS,
  dueAlarms,
  finishAlarm,
  type RunningAlarm,
  scheduleAlarm,
  startAlarm,
  type StartedAlarm,
} from "../../src/adapters/driving/do/alarm.ts";
import { OUTBOX_FLUSH, OUTBOX_REDELIVERY } from "../../src/adapters/driving/do/keel-object.ts";
import type { ChangeDO } from "../../src/adapters/driving/do/change.ts";
import type { ProjectorDO } from "../../src/adapters/driving/do/projector.ts";
import type { DurableObjectServices } from "../../src/composition/do.ts";
import { decodeExit, EventCodecs, exitCodec } from "../../src/rpc/index.ts";
import { drainAfter } from "./helpers.ts";

const changeStub = (changeId = makeId("chg", ulid())) =>
  drainAfter(env.CHANGE.get(env.CHANGE.idFromName(`change:${changeId}`)));
const agentStub = (agentId: string) =>
  drainAfter(env.AGENT_SESSION.get(env.AGENT_SESSION.idFromName(`agent:${agentId}`)));
const projectorStub = () => env.PROJECTOR.get(env.PROJECTOR.idFromName("projector"));

// The real adapter passes the same contract suite as the in-memory one. DO SQLite can only be touched from inside its
// Durable Object, so each program runs there, against adapters built on that object's storage. The object is a
// Projector-class one: every other class subscribes the Projector as it starts, and the contract owns its subscriptions.
PORTS.EventOutbox.contract("do-sqlite", (): OutboxHarness => {
  const stub = env.PROJECTOR.get(env.PROJECTOR.idFromName(`contract:${ulid()}`));
  const clock = makeManualClock();
  return {
    fanOut: makeScriptedFanOut(),
    clock,
    run: (program) =>
      Effect.flatMap(
        Effect.promise(() =>
          runInDurableObject(stub, (_instance: ProjectorDO, state) =>
            Effect.runPromiseExit(
              Effect.provide(
                program,
                Layer.mergeAll(
                  EntityStoreSql(state.storage),
                  EventOutboxSql(state.storage),
                  clock.layer,
                ),
              ),
            ),
          ),
        ),
        (exit) => exit,
      ),
  };
});

/** Runs a program through the object's own `answer`, exactly as one of its RPC methods would, so the flush is armed. */
const CommitCodec = exitCodec(Schema.Struct({ duplicate: Schema.Boolean }), Schema.Never);
function through(
  stub: DurableObjectStub<ChangeDO>,
  program: Effect.Effect<{ readonly duplicate: boolean }, never, DurableObjectServices>,
) {
  return runInDurableObject(stub, async (instance: ChangeDO) =>
    decodeExit(CommitCodec, await instance["answer"](CommitCodec, program)),
  );
}

const started = (entity: EntityRef, revision: number): EventDraft => ({
  payload: {
    _tag: "PrecheckStarted",
    changeId: entity.id,
    revision,
    instanceId: `instance-${revision}`,
  },
});

/** Commits one PrecheckStarted for `entity`, subscribing `subscribers` first; the probe row counts the commits. */
const emit = (entity: EntityRef, cause: string, subscribers: readonly string[] = []) =>
  Effect.map(
    commit({ entity, cause }, ({ store, outbox }) => {
      for (const subscriber of subscribers) outbox.subscribe(subscriber, "*");
      const seen = store.get("probe", entity.id);
      const count = (typeof seen === "number" ? seen : 0) + 1;
      store.put("probe", entity.id, count);
      return Result.succeed({ drafts: [started(entity, count)], value: null });
    }),
    (committed) => ({ duplicate: committed.duplicate }),
  );

/** What a Durable Object holds: its entities, events, receipts and owed deliveries, for before/after comparisons. */
function tables(state: DurableObjectState) {
  const all = (query: string) => state.storage.sql.exec(query).toArray();
  return {
    entities: all("SELECT kind, id, value FROM entities ORDER BY kind, id"),
    events: all(
      "SELECT entity_kind, entity_id, seq, envelope FROM keel_events ORDER BY entity_kind, entity_id, seq",
    ),
    received: all("SELECT dedupe_key FROM keel_received ORDER BY dedupe_key"),
    deliveries: all("SELECT event_id, subscriber, attempts FROM keel_deliveries ORDER BY position"),
  };
}

/** How long a test waits for a flush it cannot trigger synchronously. */
const WAIT = { timeout: 10_000, interval: 20 };

const InboxRow = Schema.Struct({ eventId: Schema.String, seq: Schema.Int });
const Revision = Schema.Struct({ revision: Schema.Int });

const inbox = (agentId: string) =>
  runInDurableObject(agentStub(agentId), (_instance: AgentSessionDO, state) =>
    state.storage.sql
      .exec<{ value: string }>("SELECT value FROM entities WHERE kind = 'inbox' ORDER BY id")
      .toArray()
      .map((row) => Schema.decodeUnknownSync(InboxRow)(JSON.parse(row.value))),
  );

const nudges = () =>
  runInDurableObject(projectorStub(), (_instance, state) => {
    const row = state.storage.sql
      .exec<{ value: string }>(
        "SELECT value FROM entities WHERE kind = 'projector' AND id = 'nudges'",
      )
      .toArray()[0];
    return row === undefined ? 0 : Number(JSON.parse(row.value));
  });

const logOf = (stub: DurableObjectStub<ChangeDO>, entity: EntityRef) =>
  runInDurableObject(stub, (instance: ChangeDO) =>
    instance["runtime"].runPromise(Effect.map(EventOutbox, (outbox) => outbox.log(entity))),
  );

const envelopeFor = (entity: EntityRef, seq: number, cause: string) =>
  Schema.encodeSync(EventEnvelope)(
    Schema.decodeUnknownSync(EventEnvelope)({
      eventId: makeId("evt", ulid()),
      type: "PrecheckStarted",
      entity,
      seq,
      at: Date.now(),
      dedupeKey: `${entity.kind}:${entity.id}/${cause}/PrecheckStarted#1`,
      affected: [],
      notified: [],
      payload: started(entity, seq).payload,
    }),
  );

describe("the event backbone across real Durable Objects", () => {
  it("[b1.alarm-quiet] delivers a committed event to its subscriber exactly once, through the real alarm and RPC, then nudges the Projector", async () => {
    const changeId = makeId("chg", ulid());
    const agentId = makeId("agt", ulid());
    const entity: EntityRef = { kind: "change", id: changeId };
    const emitter = changeStub(changeId);
    const nudged = await nudges();

    expect(await through(emitter, emit(entity, "declare", [`agent:${agentId}`]))).toEqual(
      Exit.succeed({ duplicate: false }),
    );
    // The flush is a debounce armed for now; the platform may run it before this line does.
    await runDurableObjectAlarm(emitter);
    await vi.waitFor(async () => expect(await inbox(agentId)).toHaveLength(1), WAIT);

    const [event] = await logOf(emitter, entity);
    expect((await inbox(agentId)).map((row) => row.eventId)).toEqual([event?.eventId]);
    await vi.waitFor(async () => expect(await nudges()).toBe(nudged + 1), WAIT);
    const after = await runInDurableObject(emitter, async (_instance: ChangeDO, state) => ({
      owed: tables(state).deliveries,
      alarm: await state.storage.getAlarm(),
    }));
    // Everything was delivered, so nothing is owed and no alarm is left armed.
    expect(after).toEqual({ owed: [], alarm: null });
  });

  it("[b1.redelivery] keeps an event owed to an unreachable subscriber and arms a redelivery deadline, never a loop", async () => {
    const changeId = makeId("chg", ulid());
    const entity: EntityRef = { kind: "change", id: changeId };
    // Not drained: its subscriber never answers, so it owes the event for good.
    const emitter = env.CHANGE.get(env.CHANGE.idFromName(`change:${changeId}`));
    const flushedAt = Date.now();
    await through(emitter, emit(entity, "declare", ["nowhere:1"]));
    await runDurableObjectAlarm(emitter);
    // The failed attempt is recorded before the redelivery is armed, so both are read in one turn.
    await vi.waitFor(async () => {
      const after = await runInDurableObject(emitter, (_instance: ChangeDO, state) => ({
        owed: tables(state).deliveries,
        alarms: armedAlarms(state.storage),
      }));
      expect(after.owed).toMatchObject([{ subscriber: "nowhere:1", attempts: 1 }]);
      expect(after.alarms).toHaveLength(1);
      expect(after.alarms[0]).toMatchObject({ kind: "deadline", reason: "outbox redelivery" });
      expect(after.alarms[0]?.at).toBeGreaterThanOrEqual(flushedAt + 1000);
    }, WAIT);
  });

  it("[b1.redelivery] disarms an earlier failure's redelivery once a flush leaves nothing owed", async () => {
    const changeId = makeId("chg", ulid());
    const agentId = makeId("agt", ulid());
    const entity: EntityRef = { kind: "change", id: changeId };
    const emitter = changeStub(changeId);
    agentStub(agentId);
    // What an earlier failed attempt leaves armed, a minute out.
    await runInDurableObject(emitter, (_instance: ChangeDO, state) =>
      scheduleAlarm(state.storage, {
        kind: "deadline",
        reason: OUTBOX_REDELIVERY,
        at: Date.now() + 60_000,
      }),
    );
    await through(emitter, emit(entity, "declare", [`agent:${agentId}`]));

    await vi.waitFor(async () => {
      const after = await runInDurableObject(emitter, (_instance: ChangeDO, state) => ({
        owed: tables(state).deliveries,
        alarms: armedAlarms(state.storage),
      }));
      expect(after).toEqual({ owed: [], alarms: [] });
    }, WAIT);
  });

  it("[b1.flush-first] runs a flush due with one of the object's own deadlines first, so what it committed is published before that deadline runs", async () => {
    const changeId = makeId("chg", ulid());
    const agentId = makeId("agt", ulid());
    const entity: EntityRef = { kind: "change", id: changeId };
    const emitter = changeStub(changeId);
    agentStub(agentId);
    // How many deliveries the outbox owed each time the object's own deadline ran.
    const owed: number[] = [];
    await runInDurableObject(emitter, async (instance: ChangeDO, state) => {
      Reflect.set(instance, "onDeadline", async () => {
        owed.push(tables(state).deliveries.length);
      });
      // Committed without the flush an answer arms: that is armed below, due with the deadline.
      await Reflect.get(instance, "runtime").runPromise(
        emit(entity, "declare", [`agent:${agentId}`]),
      );
      // The deadline's reason sorts before the flush's, and both are due at the same instant.
      const at = Date.now();
      await scheduleAlarm(state.storage, { kind: "deadline", reason: "a deadline", at });
      await scheduleAlarm(state.storage, { kind: "debounce", reason: OUTBOX_FLUSH, at });
    });
    await runDurableObjectAlarm(emitter);
    await vi.waitFor(() => expect(owed).toEqual([0]), WAIT);
    expect(await inbox(agentId)).toHaveLength(1);
  });

  it("[b1.duplicate-noop] treats a duplicate delivery as a no-op: the receiver's state and event log are unchanged", async () => {
    const agentId = makeId("agt", ulid());
    const receiver = agentStub(agentId);
    const envelope = envelopeFor({ kind: "change", id: makeId("chg", ulid()) }, 1, "submit");
    const receipt = async () => decodeExit(EventCodecs.receive, await receiver.receive([envelope]));

    expect(await receipt()).toEqual(Exit.succeed({ accepted: 1, duplicates: 0, ignored: 0 }));
    const before = await runInDurableObject(receiver, (_instance: AgentSessionDO, state) =>
      tables(state),
    );
    expect(await receipt()).toEqual(Exit.succeed({ accepted: 0, duplicates: 1, ignored: 0 }));
    const after = await runInDurableObject(receiver, (_instance: AgentSessionDO, state) =>
      tables(state),
    );
    expect(after).toEqual(before);
    expect(await inbox(agentId)).toHaveLength(1);
  });

  it("[b1.receive-atomic] leaves an event unreceived when its reaction fails, so the redelivery applies it", async () => {
    const agentId = makeId("agt", ulid());
    const envelope = envelopeFor({ kind: "change", id: makeId("chg", ulid()) }, 1, "submit");
    const receipts = await runInDurableObject(
      agentStub(agentId),
      async (instance: AgentSessionDO) => {
        const react = instance["react"];
        instance["react"] = () => {
          throw new Error("crashed mid-reaction");
        };
        const crashed = decodeExit(EventCodecs.receive, await instance.receive([envelope]));
        instance["react"] = react;
        const redelivered = decodeExit(EventCodecs.receive, await instance.receive([envelope]));
        return { crashed, redelivered };
      },
    );
    expect(Exit.isFailure(receipts.crashed)).toBe(true);
    expect(receipts.redelivered).toEqual(Exit.succeed({ accepted: 1, duplicates: 0, ignored: 0 }));
    expect(await inbox(agentId)).toHaveLength(1);
  });

  it("reads an envelope from another Worker version: extra fields are dropped, a missing notified[] defaults, an unknown kind is ignored", async () => {
    const receiver = agentStub(makeId("agt", ulid()));
    const {
      notified: _notified,
      affected: _affected,
      ...older
    } = envelopeFor({ kind: "change", id: makeId("chg", ulid()) }, 1, "older");
    const newer = {
      ...envelopeFor({ kind: "change", id: makeId("chg", ulid()) }, 1, "newer"),
      entity: { kind: "galaxy", id: "g1" },
      addedLater: true,
    };
    expect(decodeExit(EventCodecs.receive, await receiver.receive([older, newer]))).toEqual(
      Exit.succeed({ accepted: 1, duplicates: 0, ignored: 1 }),
    );
  });
});

describe("ten concurrent commits on one Durable Object", () => {
  it("[b1.racers] number their events 1..10 with the state the log says, and deliver exactly ten", async () => {
    const changeId = makeId("chg", ulid());
    const agentId = makeId("agt", ulid());
    const entity: EntityRef = { kind: "change", id: changeId };
    const emitter = changeStub(changeId);
    await runInDurableObject(emitter, (instance: ChangeDO) =>
      instance["runtime"].runPromise(
        Effect.map(EventOutbox, (outbox) => outbox.subscribe(`agent:${agentId}`, "*")),
      ),
    );

    await Promise.all(
      Array.from({ length: 10 }, (_, i) => through(emitter, emit(entity, `racer-${i}`))),
    );

    const events = await logOf(emitter, entity);
    const probe = await runInDurableObject(
      emitter,
      (_instance: ChangeDO, state) =>
        state.storage.sql
          .exec<{ value: string }>("SELECT value FROM entities WHERE kind = 'probe'")
          .one().value,
    );
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // Each event carries the count its transition wrote, so the state and the log agree event by event.
    expect(
      events.map((event) => Schema.decodeUnknownSync(Revision)(event.payload).revision),
    ).toEqual(events.map((event) => event.seq));
    expect(Number(probe)).toBe(10);

    await runDurableObjectAlarm(emitter);
    await vi.waitFor(
      async () =>
        expect((await inbox(agentId)).map((row) => row.seq)).toEqual([
          1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
        ]),
      WAIT,
    );
  });

  it("[b1.racers] commit one command retried ten times at once exactly once", async () => {
    const changeId = makeId("chg", ulid());
    const entity: EntityRef = { kind: "change", id: changeId };
    const emitter = changeStub(changeId);
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () => through(emitter, emit(entity, "Idempotency-Key: k1"))),
    );
    const probe = await runInDurableObject(
      emitter,
      (_instance: ChangeDO, state) =>
        state.storage.sql
          .exec<{ value: string }>("SELECT value FROM entities WHERE kind = 'probe'")
          .one().value,
    );
    expect(
      outcomes.filter((outcome) => Exit.isSuccess(outcome) && !outcome.value.duplicate),
    ).toHaveLength(1);
    expect(
      outcomes.filter((outcome) => Exit.isSuccess(outcome) && outcome.value.duplicate),
    ).toHaveLength(9);
    expect((await logOf(emitter, entity)).map((event) => event.seq)).toEqual([1]);
    expect(Number(probe)).toBe(1);
  });
});

const TEST_DEADLINE = "a test's deadline";

/**
 * Runs the object's alarm as if the test deadline's retry had come due: the
 * wait before a dead handler's request is run again is real time otherwise.
 * Only the row's time is moved. The alarm itself is whatever the object
 * armed: one that armed nothing for a dead handler's request is never run.
 */
const retried = async (stub: DurableObjectStub<ChangeDO>) => {
  await runInDurableObject(stub, (_instance: ChangeDO, state) => {
    state.storage.sql.exec(
      "UPDATE keel_alarms SET retry = ? WHERE reason = ? AND retry IS NOT NULL",
      Date.now() - 1,
      TEST_DEADLINE,
    );
  });
  await runDurableObjectAlarm(stub).catch(() => false);
};

/** Each due request's reason with the starts counted against it. */
const counts = (due: readonly RunningAlarm[]) => due.map((found) => [found.reason, found.starts]);

/** Whether the test's deadline is still armed, as the reasons that are. */
const armed = (storage: DurableObjectStorage) =>
  armedAlarms(storage)
    .map((alarm) => alarm.reason)
    .filter((reason) => reason === TEST_DEADLINE);

/**
 * Gives the object a handler for deadlines that records each start it is
 * given and dies when `dies` says so, as an invocation the platform killed.
 */
const handling = (stub: DurableObjectStub<ChangeDO>, dies: (starts: number) => boolean) => {
  const seen: number[] = [];
  return runInDurableObject(stub, (instance: ChangeDO) => {
    Reflect.set(instance, "onDeadline", (request: StartedAlarm) => {
      seen.push(request.starts);
      return dies(request.starts)
        ? Promise.reject(new Error(`killed at start ${request.starts}`))
        : Promise.resolve();
    });
    return seen;
  });
};

describe("alarms", () => {
  it("[b1.alarm-multiplex] keep several deadlines on the one platform alarm, firing only what is due", async () => {
    const result = await runInDurableObject(changeStub(), async (_instance: ChangeDO, state) => {
      const now = Date.now();
      await scheduleAlarm(state.storage, {
        kind: "deadline",
        reason: "lease lse_1 lapses",
        at: now + 15 * 60_000,
      });
      await scheduleAlarm(state.storage, {
        kind: "deadline",
        reason: "outbox redelivery",
        at: now + 1000,
      });
      const armedFirst = await state.storage.getAlarm();
      const fired = await dueAlarms(state.storage, now + 1000);
      const [found] = fired.due;
      const begun =
        found === undefined ? undefined : await startAlarm(state.storage, found, now + 1000);
      if (begun !== undefined) await finishAlarm(state.storage, begun);
      return {
        now,
        armedFirst,
        fired,
        begun,
        armedThen: await state.storage.getAlarm(),
        left: armedAlarms(state.storage),
      };
    });
    expect(result.armedFirst).toBe(result.now + 1000);
    const redelivery = { kind: "deadline", reason: "outbox redelivery", at: result.now + 1000 };
    expect(result.fired).toEqual({ due: [{ ...redelivery, starts: 0, armed: 0 }], abandoned: [] });
    expect(result.begun).toEqual({ ...redelivery, starts: 1, armed: 0 });
    expect(result.armedThen).toBe(result.now + 15 * 60_000);
    expect(result.left).toEqual([
      { kind: "deadline", reason: "lease lse_1 lapses", at: result.now + 15 * 60_000 },
    ]);
  });

  it("[b1.alarm-kept] runs a deadline again when the invocation that ran it died: the handler that throws once handles it the second time", async () => {
    const stub = changeStub();
    const seen = await handling(stub, (starts) => starts === 1);
    await runInDurableObject(stub, (_instance: ChangeDO, state) =>
      scheduleAlarm(state.storage, { kind: "deadline", reason: TEST_DEADLINE, at: Date.now() - 1 }),
    );
    // The platform may run a due alarm before the test does: each run is asked for, and its effect awaited.
    await vi.waitFor(
      async () => {
        await retried(stub);
        expect(seen.length).toBeGreaterThanOrEqual(1);
      },
      { timeout: 10_000, interval: 25 },
    );
    // The invocation died with its request still armed: the next run of the alarm handles it.
    await vi.waitFor(
      async () => {
        await retried(stub);
        expect(
          await runInDurableObject(stub, (_i: ChangeDO, state) => armed(state.storage)),
        ).toEqual([]);
      },
      { timeout: 10_000, interval: 25 },
    );
    expect(seen).toEqual([1, 2]);
  });

  it("[b1.alarm-abandoned] gives up on a deadline started five times that never finished: it is removed, never started again, and the object says so", async () => {
    const stub = changeStub();
    const seen = await handling(stub, () => true);
    const said = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await runInDurableObject(stub, (_instance: ChangeDO, state) =>
        scheduleAlarm(state.storage, {
          kind: "deadline",
          reason: TEST_DEADLINE,
          at: Date.now() - 1,
        }),
      );
      await vi.waitFor(
        async () => {
          await retried(stub);
          expect(
            await runInDurableObject(stub, (_i: ChangeDO, state) => armed(state.storage)),
          ).toEqual([]);
        },
        { timeout: 20_000, interval: 25 },
      );
      expect(seen).toEqual(Array.from({ length: ALARM_START_LIMIT }, (_, index) => index + 1));
      expect(
        said.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("gave up")),
      ).toEqual([
        expect.stringMatching(
          /^ChangeDO .* gave up on "a test's deadline": started 5 times and never finished$/,
        ),
      ]);
    } finally {
      said.mockRestore();
    }
  });

  it("[b1.alarm-rearmed] keeps a request armed again while its handler ran, even for the same time, with no run counted against it, and finishes one that was not", async () => {
    const result = await runInDurableObject(changeStub(), async (_instance: ChangeDO, state) => {
      const at = Date.now() - 1;
      const again = { kind: "debounce", reason: "armed again", at } as const;
      const once = { kind: "debounce", reason: "armed once", at } as const;
      await scheduleAlarm(state.storage, again);
      await scheduleAlarm(state.storage, once);
      const running: RunningAlarm[] = [];
      for (const found of (await dueAlarms(state.storage, at)).due) {
        const begun = await startAlarm(state.storage, found, at);
        if (begun !== undefined) running.push(begun);
      }
      // A delivery arrives while the handlers run, and asks for the same reason at the same time.
      await scheduleAlarm(state.storage, again);
      for (const begun of running) await finishAlarm(state.storage, begun);
      const next = await dueAlarms(state.storage, at);
      return { running, left: armedAlarms(state.storage), next: next.due };
    });
    expect(result.running.map((begun) => [begun.reason, begun.starts])).toEqual([
      ["armed again", 1],
      ["armed once", 1],
    ]);
    expect(result.left.map((alarm) => alarm.reason)).toEqual(["armed again"]);
    expect(result.next.map((found) => [found.reason, found.starts])).toEqual([["armed again", 0]]);
  });

  it("[b1.alarm-counted] counts a start against the request whose handler ran, not the one waiting behind it; runs it again no sooner than its retry; and keeps the count when its reason is armed again", async () => {
    const result = await runInDurableObject(changeStub(), async (_instance: ChangeDO, state) => {
      const at = Date.now() - 1;
      const dies = { kind: "deadline", reason: "a handler that dies", at } as const;
      await scheduleAlarm(state.storage, dies);
      const [first] = (await dueAlarms(state.storage, at)).due;
      if (first === undefined) throw new Error("nothing was due");
      // The invocation dies under the first handler: nothing is finished, and the second never started.
      await startAlarm(state.storage, first, at);
      const armedForRetry = await state.storage.getAlarm();
      await scheduleAlarm(state.storage, { kind: "deadline", reason: "behind it", at });
      const atOnce = (await dueAlarms(state.storage, at)).due;
      const armedFor = await state.storage.getAlarm();
      const later = (await dueAlarms(state.storage, at + ALARM_RETRY_MS)).due;
      // A delivery arms the dead handler's reason again: it is due at once, its one start still counted.
      await scheduleAlarm(state.storage, dies);
      const rearmed = (await dueAlarms(state.storage, at)).due;
      return { at, armedForRetry, atOnce, armedFor, later, rearmed };
    });
    // Starting a request arms the alarm for its retry: nothing else would run it again.
    expect(result.armedForRetry).toBe(result.at + ALARM_RETRY_MS);
    expect(counts(result.atOnce)).toEqual([["behind it", 0]]);
    // Armed for the request that is due now, not held back to the dead one's retry.
    expect(result.armedFor).toBeLessThan(result.at + ALARM_RETRY_MS);
    expect(counts(result.later)).toEqual([
      ["a handler that dies", 1],
      ["behind it", 0],
    ]);
    expect(counts(result.rearmed)).toEqual([
      ["a handler that dies", 1],
      ["behind it", 0],
    ]);
  });
});

describe("Workflow subscribers", () => {
  it("[b1.workflow-once] start one instance per event, however often the event is delivered", async () => {
    await using introspector = await introspectWorkflow(env.PRECHECK);
    const event = Schema.decodeUnknownSync(EventEnvelope)(
      envelopeFor({ kind: "change", id: makeId("chg", ulid()) }, 1, "submit"),
    );
    const fanOut = FanOutRpc(env);
    await Effect.runPromise(fanOut.deliver("workflow:Precheck", [event]));
    await Effect.runPromise(fanOut.deliver("workflow:Precheck", [event]));
    expect(await introspector.get()).toHaveLength(1);
    await expect(env.PRECHECK.get(workflowInstanceId("Precheck", event))).resolves.toBeDefined();
  });
});
