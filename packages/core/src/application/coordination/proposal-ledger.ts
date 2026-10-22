import { Effect, Schema } from "effect";
import { ProposalLimit } from "../../domain/coordination/index.ts";
import { IdempotencyConflict } from "../../domain/identity/index.ts";
import {
  ChangeId,
  type CommandActor,
  type EventEnvelope,
  type ProjectId,
} from "../../domain/kernel/index.ts";
import { Clock, EntityStore, Ids, type Transaction } from "../ports/index.ts";

/** How many proposals one proposer may have open on one project at once. */
export const MAX_OPEN_PROPOSALS = 5;

/**
 * How long a place reserved for a proposal is held before its proposal
 * arrives: a propose that failed after reserving gives its place back then.
 */
export const RESERVATION_TTL_MS = 15 * 60_000;

/** Where the project's object keeps each proposer's reservation, by proposer and Idempotency-Key. */
const RESERVED = "proposal-reserved";
/** Each open proposal, by proposer then change id, so a proposer's are one range. */
const OPEN = "proposal-open";
/** Whose each open proposal is, by change id: an end names only the change. */
const PROPOSER = "proposal-proposer";

const Reserved = Schema.Struct({ changeId: ChangeId, fingerprint: Schema.String });
const Open = Schema.Struct({
  /** When its place was reserved. */
  at: Schema.Number,
  /** Its ChangeProposed arrived: it holds its place until it ends. */
  proposed: Schema.Boolean,
  /** The reservation's RESERVED key, so a lapsed place takes its reservation with it; absent on older rows. */
  key: Schema.optional(Schema.String),
});
const Proposer = Schema.Struct({ proposer: Schema.String });

const decodeReserved = Schema.decodeUnknownSync(Reserved);
const decodeOpen = Schema.decodeUnknownSync(Open);
const decodeProposer = Schema.decodeUnknownSync(Proposer);
const decodeProposed = Schema.decodeUnknownSync(
  Schema.Struct({ changeId: ChangeId, proposer: Schema.String }),
);
const decodeEnded = Schema.decodeUnknownSync(Schema.Struct({ changeId: ChangeId }));

type Store = Transaction["store"];

const openKey = (proposer: string, changeId: string) => `${proposer}/${changeId}`;

/**
 * Takes away the proposer's reservations whose place lapsed before their
 * proposal arrived: the place, whose proposer it is, and the key's
 * reservation, so its retry is a new reservation, under the cap. A proposal
 * that arrives after all holds its place again (`hearProposal`).
 */
const pruneLapsed = (store: Store, proposer: string, now: number): void => {
  for (const { id, value } of store.list(OPEN, `${proposer}/`)) {
    const open = decodeOpen(value);
    if (open.proposed || now - open.at <= RESERVATION_TTL_MS) continue;
    const changeId = id.slice(proposer.length + 1);
    store.remove(OPEN, id);
    store.remove(PROPOSER, changeId);
    if (open.key !== undefined) store.remove(RESERVED, open.key);
    // A place written before it kept its key: its reservation is found among the proposer's.
    else
      for (const reserved of store.list(RESERVED, `${proposer}/`))
        if (decodeReserved(reserved.value).changeId === changeId)
          store.remove(RESERVED, reserved.id);
  }
};

/** A proposer's proposals that hold a place now: each that arrived, and each reserved within the TTL. */
const holding = (store: Store, proposer: string, now: number): number =>
  store.list(OPEN, `${proposer}/`).filter(({ value }) => {
    const open = decodeOpen(value);
    return open.proposed || now - open.at <= RESERVATION_TTL_MS;
  }).length;

/** A reservation, as the project's object is asked for it by the doorway proposing from a fork. */
export interface ProposalReservation {
  readonly proposer: CommandActor;
  readonly idempotencyKey: string;
  /** A hash of the request body, so a reused key is told apart from a retry. */
  readonly fingerprint: string;
}

/**
 * Reserves the change id of a proposal to the project, by its proposer's
 * Idempotency-Key: a retry is answered the id it was given, and holds no
 * second place, unless its place lapsed before its proposal arrived. The
 * proposer's lapsed reservations are taken away first (`pruneLapsed`), so
 * such a retry is a new reservation, under the cap. The key with another body
 * is IdempotencyConflict. A proposer with MAX_OPEN_PROPOSALS holding places is
 * ProposalLimit. Read, pruned, counted and written in one transaction, so two
 * at once never both pass.
 */
export const reserveProposal = Effect.fn("coordination/reserveProposal")(function* (
  projectId: ProjectId,
  reservation: ProposalReservation,
) {
  const store = yield* EntityStore;
  const now = yield* (yield* Clock).now;
  const minted = yield* (yield* Ids).next("chg");
  const key = `${reservation.proposer}/${reservation.idempotencyKey}`;
  const answer = store.transaction((): ChangeId | ProposalLimit | IdempotencyConflict => {
    pruneLapsed(store, reservation.proposer, now);
    const held = store.get(RESERVED, key);
    if (held !== undefined) {
      const reserved = decodeReserved(held);
      if (reserved.fingerprint !== reservation.fingerprint)
        return new IdempotencyConflict({ idempotencyKey: reservation.idempotencyKey });
      // Its place holds: a lapsed one went with its reservation, so this key is no retry of it.
      return reserved.changeId;
    }
    if (holding(store, reservation.proposer, now) >= MAX_OPEN_PROPOSALS)
      return new ProposalLimit({ projectId, limit: MAX_OPEN_PROPOSALS });
    store.put(RESERVED, key, { changeId: minted, fingerprint: reservation.fingerprint });
    store.put(OPEN, openKey(reservation.proposer, minted), { at: now, proposed: false, key });
    store.put(PROPOSER, minted, { proposer: reservation.proposer });
    return minted;
  });
  return typeof answer === "string" ? answer : yield* answer;
});

/** The reservation a refused proposal gives back, by its proposer and Idempotency-Key. */
export interface ProposalRelease {
  readonly proposer: CommandActor;
  readonly idempotencyKey: string;
}

/**
 * Gives back the place `release`'s key reserved while its proposal has not
 * arrived (a proposal refused before it was made, its account's day used
 * up): the place, whose proposer it is, and the key's reservation, so a
 * retry of the key is a new reservation. An arrived proposal keeps its
 * place, and a key that reserved nothing gives back nothing.
 */
export const releaseProposal = Effect.fn("coordination/releaseProposal")(function* (
  release: ProposalRelease,
) {
  const store = yield* EntityStore;
  const key = `${release.proposer}/${release.idempotencyKey}`;
  store.transaction(() => {
    const held = store.get(RESERVED, key);
    if (held === undefined) return;
    const { changeId } = decodeReserved(held);
    const place = store.get(OPEN, openKey(release.proposer, changeId));
    if (place !== undefined && decodeOpen(place).proposed) return;
    store.remove(OPEN, openKey(release.proposer, changeId));
    store.remove(PROPOSER, changeId);
    store.remove(RESERVED, key);
  });
});

/**
 * What the ledger hears of a proposal, in the transaction that receives it:
 * ChangeProposed holds its place until it ends, and its landing, withdrawal
 * or supersession frees it. Anything else is not the ledger's.
 */
export const hearProposal = (store: Store, event: EventEnvelope): void => {
  switch (event.type) {
    case "ChangeProposed": {
      const { changeId, proposer } = decodeProposed(event.payload);
      const key = openKey(proposer, changeId);
      const held = store.get(OPEN, key);
      const before = held === undefined ? undefined : decodeOpen(held);
      store.put(OPEN, key, {
        at: before?.at ?? event.at,
        proposed: true,
        ...(before?.key === undefined ? {} : { key: before.key }),
      });
      store.put(PROPOSER, changeId, { proposer });
      return;
    }
    case "ChangeLanded":
    case "ChangeWithdrawn":
    case "ChangeSuperseded": {
      const { changeId } = decodeEnded(event.payload);
      const whose = store.get(PROPOSER, changeId);
      if (whose === undefined) return;
      store.remove(OPEN, openKey(decodeProposer(whose).proposer, changeId));
      store.remove(PROPOSER, changeId);
      return;
    }
    default:
      return;
  }
};
