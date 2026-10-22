// The proposal ledger a project's object keeps: a proposal's change id per
// proposer and Idempotency-Key, and at most MAX_OPEN_PROPOSALS open at once
// per proposer, counted as the proposals' own events arrive.
import { describe, expect, it } from "@effect/vitest";
import {
  hearProposal,
  MAX_OPEN_PROPOSALS,
  RESERVATION_TTL_MS,
  releaseProposal,
  reserveProposal,
} from "@keeltown/core/application/coordination";
import {
  type ChangeId,
  EventEnvelope,
  makeId,
  type ProjectId,
  userActor,
} from "@keeltown/core/kernel";
import { EntityStore } from "@keeltown/core/ports";
import { makeEventOutboxMemory, makeIdsMemory, makeManualClock } from "@keeltown/testing";
import { Effect, Layer, Schema } from "effect";
import { ulid } from "ulid";

const PROJECT: ProjectId = makeId("prj", ulid());
const FORK: ProjectId = makeId("prj", ulid());
const ANN = userActor(makeId("usr", ulid()));
const BOB = userActor(makeId("usr", ulid()));

const ledger = () => {
  const clock = makeManualClock();
  return {
    clock,
    layer: Layer.mergeAll(makeEventOutboxMemory().layer, makeIdsMemory().layer, clock.layer),
  };
};

const reserving = (proposer: typeof ANN, key: string, fingerprint = `body-${key}`) =>
  reserveProposal(PROJECT, { proposer, idempotencyKey: key, fingerprint });

/** One of the proposal's events, as its change delivers it to the project. */
const heard = (type: string, payload: Record<string, unknown>) =>
  Effect.flatMap(EntityStore, (store) =>
    Effect.sync(() =>
      store.transaction(() =>
        hearProposal(
          store,
          Schema.decodeUnknownSync(EventEnvelope)({
            eventId: `evt_${ulid()}`,
            type,
            entity: { kind: "change", id: payload["changeId"] },
            seq: 1,
            at: 0,
            dedupeKey: `${String(payload["changeId"])}/${type}`,
            affected: [],
            notified: [`project:${PROJECT}`],
            payload: { _tag: type, ...payload },
          }),
        ),
      ),
    ),
  );
const proposed = (changeId: ChangeId, proposer = ANN) =>
  heard("ChangeProposed", { changeId, fork: FORK, commit: "c".repeat(40), proposer });

describe("a project's proposal ledger", () => {
  it.effect(
    "[proposals.limit] a proposer holds at most five open proposals on a project: a sixth is refused, a retry of an open one's key is answered as before and counted once, another body under that key conflicts, and a closed or landed one frees a place",
    () => {
      const l = ledger();
      return Effect.gen(function* () {
        const ids: ChangeId[] = [];
        for (const n of [1, 2, 3, 4, 5]) ids.push(yield* reserving(ANN, `k${n}`));
        for (const id of ids) yield* proposed(id);
        expect(new Set(ids).size).toBe(MAX_OPEN_PROPOSALS);
        expect(yield* Effect.flip(reserving(ANN, "k6"))).toMatchObject({
          _tag: "ProposalLimit",
          projectId: PROJECT,
          limit: MAX_OPEN_PROPOSALS,
        });
        expect(yield* reserving(ANN, "k3")).toBe(ids[2]);
        expect(yield* Effect.flip(reserving(ANN, "k3", "another body"))).toMatchObject({
          _tag: "IdempotencyConflict",
        });
        // Another proposer's places are their own.
        yield* reserving(BOB, "k1");
        yield* heard("ChangeWithdrawn", { changeId: ids[0], by: "usr_x" });
        const sixth = yield* reserving(ANN, "k6");
        expect(ids).not.toContain(sixth);
        yield* proposed(sixth);
        expect(yield* Effect.flip(reserving(ANN, "k7"))).toMatchObject({ _tag: "ProposalLimit" });
        yield* heard("ChangeLanded", {
          changeId: ids[1],
          batchId: makeId("bat", ulid()),
          commitSha: "d".repeat(40),
        });
        yield* reserving(ANN, "k7");
      }).pipe(Effect.provide(l.layer));
    },
  );

  it.effect(
    "[proposals.reservation-lapses] a place reserved for a proposal that never arrives is held for a while, then freed",
    () => {
      const l = ledger();
      return Effect.gen(function* () {
        for (const n of [1, 2, 3, 4, 5]) yield* reserving(ANN, `k${n}`);
        expect(yield* Effect.flip(reserving(ANN, "k6"))).toMatchObject({ _tag: "ProposalLimit" });
        l.clock.advance(RESERVATION_TTL_MS + 1);
        yield* reserving(ANN, "k6");
      }).pipe(Effect.provide(l.layer));
    },
  );

  it.effect(
    "[proposals.lapsed-retry-counted] a retry of a reservation whose place lapsed before its proposal arrived takes a place again, under the cap: lapsed reservations never open more than five",
    () => {
      const l = ledger();
      return Effect.gen(function* () {
        const lapsed: ChangeId[] = [];
        for (const n of [1, 2, 3, 4, 5]) lapsed.push(yield* reserving(ANN, `old${n}`));
        l.clock.advance(RESERVATION_TTL_MS + 1);
        for (const n of [1, 2, 3, 4, 5]) yield* reserving(ANN, `new${n}`);
        expect(yield* Effect.flip(reserving(ANN, "old1"))).toMatchObject({ _tag: "ProposalLimit" });
        l.clock.advance(RESERVATION_TTL_MS + 1);
        // Once a place is free again the retry takes it: as a new reservation, the lapsed one forgotten.
        const retried = yield* reserving(ANN, "old1");
        expect(lapsed).not.toContain(retried);
        expect(yield* reserving(ANN, "old1")).toBe(retried);
      }).pipe(Effect.provide(l.layer));
    },
  );
  it.effect(
    "[proposal-ledger.pruned] a reservation whose proposal never arrived is forgotten once its place lapses: the proposer's next reservation takes its rows away, another proposer's stay, and a retry of its key is a new reservation, under the cap",
    () => {
      const l = ledger();
      return Effect.gen(function* () {
        const lapsed = yield* reserving(ANN, "k1");
        const bobs = yield* reserving(BOB, "k1");
        l.clock.advance(RESERVATION_TTL_MS + 1);
        yield* reserving(ANN, "k2");
        const store = yield* EntityStore;
        const ids = (table: string) => store.list(table).map((row) => row.id);

        expect(ids("proposal-open").filter((id) => id.endsWith(lapsed))).toEqual([]);
        expect(ids("proposal-proposer")).not.toContain(lapsed);
        expect(ids("proposal-reserved")).not.toContain(`${ANN}/k1`);
        expect(ids("proposal-proposer")).toContain(bobs);
        expect(ids("proposal-reserved")).toContain(`${BOB}/k1`);
        expect(yield* reserving(ANN, "k1")).not.toBe(lapsed);
      }).pipe(Effect.provide(l.layer));
    },
  );
  it.effect(
    "[proposal-ledger.pruned-legacy] a lapsed reservation made before its place kept its key is forgotten whole too: its retry, with five places held, is refused at the cap",
    () => {
      const l = ledger();
      return Effect.gen(function* () {
        const old = yield* reserving(ANN, "old");
        // As the ledger wrote a place before it kept the reservation's key on it.
        const store = yield* EntityStore;
        const place = `${ANN}/${old}`;
        const { key: _key, ...unkeyed } = Object(store.get("proposal-open", place));
        store.put("proposal-open", place, unkeyed);
        l.clock.advance(RESERVATION_TTL_MS + 1);
        for (const n of [1, 2, 3, 4, 5]) yield* reserving(ANN, `new${n}`);

        expect(store.list("proposal-reserved").map((row) => row.id)).not.toContain(`${ANN}/old`);
        expect(yield* Effect.flip(reserving(ANN, "old"))).toMatchObject({ _tag: "ProposalLimit" });
      }).pipe(Effect.provide(l.layer));
    },
  );

  it.effect(
    "[proposal-ledger.release] a place given back is free at once and its key reserves anew; a proposal that arrived keeps its place, and a key that reserved nothing gives back nothing",
    () => {
      const l = ledger();
      return Effect.gen(function* () {
        const ids: ChangeId[] = [];
        for (const n of [1, 2, 3, 4, 5]) ids.push(yield* reserving(ANN, `k${n}`));
        const [arrived] = ids;
        if (arrived === undefined) throw new Error("no first place");
        yield* proposed(arrived);
        yield* releaseProposal({ proposer: ANN, idempotencyKey: "k1" });
        yield* releaseProposal({ proposer: ANN, idempotencyKey: "never" });
        yield* releaseProposal({ proposer: BOB, idempotencyKey: "k2" });
        expect(yield* Effect.flip(reserving(ANN, "k6"))).toMatchObject({ _tag: "ProposalLimit" });
        expect(yield* reserving(ANN, "k1")).toBe(arrived);

        yield* releaseProposal({ proposer: ANN, idempotencyKey: "k2" });
        const sixth = yield* reserving(ANN, "k6");
        expect(ids).not.toContain(sixth);
        expect(yield* Effect.flip(reserving(ANN, "k2"))).toMatchObject({ _tag: "ProposalLimit" });
      }).pipe(Effect.provide(l.layer));
    },
  );
});
