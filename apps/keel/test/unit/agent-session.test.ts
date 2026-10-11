import { describe, expect, it } from "@effect/vitest";
import {
  enrol,
  readInbox,
  recordDelivery,
  RESERVATION_TTL_MS,
  reserveChange,
} from "@keeltown/core/application/identity";
import { BOOTSTRAP_AGENT_ID, BOOTSTRAP_CLIENT_ID } from "@keeltown/core/domain/identity";
import { AgentId, EventEnvelope } from "@keeltown/core/kernel";
import { EntityStore, EventOutbox } from "@keeltown/core/ports";
import {
  makeAgentDirectoryMemory,
  makeEventOutboxMemory,
  makeIdsMemory,
  makeManualClock,
  sampleProjectId,
} from "@keeltown/testing";
import { Cause, Effect, Exit, Layer, Schema } from "effect";

const agentId = Schema.decodeUnknownSync(AgentId)("agt_01JZ8PT2C4E6G8J0M2N4Q6S8V0");

/** One agent's AgentSession state, in memory, on a clock the test moves. */
function session() {
  const clock = makeManualClock();
  const layer = Layer.mergeAll(makeEventOutboxMemory().layer, makeIdsMemory().layer, clock.layer);
  return { clock, layer };
}

describe("reserveChange", () => {
  it.effect(
    "[b11.reserve] keeps a key's change id for 24 h, refuses it for another body, and mints anew after",
    () => {
      const { clock, layer } = session();
      return Effect.gen(function* () {
        const first = yield* reserveChange(agentId, { idempotencyKey: "k1", fingerprint: "f1" });
        const retried = yield* reserveChange(agentId, { idempotencyKey: "k1", fingerprint: "f1" });
        const other = yield* reserveChange(agentId, { idempotencyKey: "k2", fingerprint: "f1" });
        const conflict = yield* Effect.exit(
          reserveChange(agentId, { idempotencyKey: "k1", fingerprint: "f2" }),
        );
        clock.advance(RESERVATION_TTL_MS - 1);
        const stillHeld = yield* reserveChange(agentId, {
          idempotencyKey: "k1",
          fingerprint: "f1",
        });
        clock.advance(1);
        const expired = yield* reserveChange(agentId, { idempotencyKey: "k1", fingerprint: "f2" });
        const renewed = yield* reserveChange(agentId, { idempotencyKey: "k1", fingerprint: "f2" });

        expect(retried).toBe(first);
        expect(other).not.toBe(first);
        expect(Exit.isFailure(conflict) && JSON.stringify(conflict.cause)).toContain(
          "IdempotencyConflict",
        );
        expect(stillHeld).toBe(first);
        expect(expired).not.toBe(first);
        expect(renewed).toBe(expired);
      }).pipe(Effect.provide(layer));
    },
  );
});

const delivered = (n: number) =>
  Schema.decodeUnknownSync(EventEnvelope)({
    eventId: `evt_01JZ8PT2C4E6G8J0M2N4Q6S8${String(n).padStart(2, "0")}`,
    type: "ChangeBounced",
    entity: { kind: "change", id: "chg_01JZ8PT2C4E6G8J0M2N4Q6S8V0" },
    seq: n,
    at: 1_700_000_000_000 + n,
    dedupeKey: `change:chg_01JZ8PT2C4E6G8J0M2N4Q6S8V0/c${n}/ChangeBounced#1`,
    affected: [],
    notified: [`agent:${agentId}`],
    payload: { _tag: "ChangeBounced" },
  });

describe("readInbox", () => {
  it.effect("pages the inbox oldest first after a cursor, and an empty page keeps the cursor", () =>
    Effect.gen(function* () {
      const store = yield* EntityStore;
      const empty = yield* readInbox(undefined);
      for (const n of [1, 2, 3]) recordDelivery(store, delivered(n));
      const all = yield* readInbox(empty.cursor);
      const later = yield* readInbox(all.cursor);
      recordDelivery(store, delivered(4));
      const fourth = yield* readInbox(all.cursor);

      expect(empty.notices).toEqual([]);
      expect(all.notices.map((notice) => notice.id)).toEqual(
        [1, 2, 3].map((n) => delivered(n).eventId),
      );
      expect(all.notices[0]).toMatchObject({
        kind: "ChangeBounced",
        title: "Change bounced: chg_01JZ8PT2C4E6G8J0M2N4Q6S8V0",
        ref: "change:chg_01JZ8PT2C4E6G8J0M2N4Q6S8V0",
      });
      expect(later).toEqual({ notices: [], cursor: all.cursor });
      expect(fourth.notices.map((notice) => notice.id)).toEqual([delivered(4).eventId]);
    }).pipe(Effect.provide(makeEventOutboxMemory().layer)),
  );
});

/** An operator's enrolment, as the isolate sends it: the secret travels only as its hash. */
const enrolling = (idempotencyKey: string, fingerprint: string, secretHash: string) => ({
  projectId: sampleProjectId,
  name: "pool-agent",
  kind: "interactive" as const,
  scopes: ["agent:read" as const, "agent:work" as const],
  clientId: `client-${agentId.toLowerCase()}`,
  secretHash,
  idempotencyKey,
  fingerprint,
});

describe("enrol", () => {
  it.effect(
    "[b11.enrol-inline] commits AgentEnrolled and writes the directory row before answering",
    () => {
      const directory = makeAgentDirectoryMemory();
      const layer = Layer.mergeAll(
        makeEventOutboxMemory().layer,
        makeManualClock().layer,
        directory.layer,
      );
      return Effect.gen(function* () {
        const agent = yield* enrol(agentId, enrolling("enrol-1", "body-1", "sha256:aa"));
        const log = (yield* EventOutbox).log({ kind: "agent", id: agentId });

        expect(agent).toMatchObject({
          id: agentId,
          projectId: sampleProjectId,
          state: "active",
          revocationEpoch: 0,
        });
        expect(log.map((event) => event.type)).toEqual(["AgentEnrolled"]);
        expect(directory.agents.get(agentId)).toEqual(agent);
        expect(directory.credentials.get(`client-${agentId.toLowerCase()}`)).toEqual({
          clientId: `client-${agentId.toLowerCase()}`,
          agentId,
          secretHash: "sha256:aa",
        });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "[b11.enrol-replay] replaces the secret hash on a replay of the key, and refuses the key for another body",
    () => {
      const directory = makeAgentDirectoryMemory();
      const layer = Layer.mergeAll(
        makeEventOutboxMemory().layer,
        makeManualClock().layer,
        directory.layer,
      );
      return Effect.gen(function* () {
        const first = yield* enrol(agentId, enrolling("enrol-1", "body-1", "sha256:aa"));
        const replayed = yield* enrol(agentId, enrolling("enrol-1", "body-1", "sha256:bb"));
        const conflict = yield* Effect.exit(
          enrol(agentId, enrolling("enrol-1", "body-2", "sha256:cc")),
        );

        expect(replayed).toEqual(first);
        expect(directory.credentials.get(`client-${agentId.toLowerCase()}`)?.secretHash).toBe(
          "sha256:bb",
        );
        expect((yield* EventOutbox).log({ kind: "agent", id: agentId })).toHaveLength(1);
        expect(Exit.isFailure(conflict) && JSON.stringify(conflict.cause)).toContain(
          "IdempotencyConflict",
        );
      }).pipe(Effect.provide(layer));
    },
  );

  describe("[b11.enrol-bootstrap] never enrols the bootstrap identity", () => {
    const ordinary = enrolling("enrol-1", "body-1", "sha256:aa");
    const cases = [
      { name: "its agent id", enrolled: BOOTSTRAP_AGENT_ID, command: ordinary },
      {
        name: "its client id",
        enrolled: agentId,
        command: { ...ordinary, clientId: BOOTSTRAP_CLIENT_ID },
      },
    ];

    for (const { name, enrolled, command } of cases)
      it.effect(
        `refuses ${name} as a defect before committing or writing the directory, on a replay too`,
        () => {
          const directory = makeAgentDirectoryMemory();
          const layer = Layer.mergeAll(
            makeEventOutboxMemory().layer,
            makeManualClock().layer,
            directory.layer,
          );
          return Effect.gen(function* () {
            const first = yield* Effect.exit(enrol(enrolled, command));
            const replayed = yield* Effect.exit(enrol(enrolled, command));

            for (const exit of [first, replayed]) {
              expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
              expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain(
                "the bootstrap identity is never enrolled",
              );
            }
            expect((yield* EventOutbox).log({ kind: "agent", id: enrolled })).toEqual([]);
            expect((yield* EntityStore).get("agent", enrolled)).toBeUndefined();
            expect([...directory.agents.keys(), ...directory.credentials.keys()]).toEqual([]);
          }).pipe(Effect.provide(layer));
        },
      );

    it.effect("enrols the same command under an ordinary id and client", () => {
      const directory = makeAgentDirectoryMemory();
      const layer = Layer.mergeAll(
        makeEventOutboxMemory().layer,
        makeManualClock().layer,
        directory.layer,
      );
      return Effect.gen(function* () {
        const agent = yield* enrol(agentId, ordinary);

        expect(agent.id).toBe(agentId);
        expect(directory.agents.get(agentId)).toEqual(agent);
      }).pipe(Effect.provide(layer));
    });
  });
});
