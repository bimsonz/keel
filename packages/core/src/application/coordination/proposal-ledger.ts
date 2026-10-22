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
 * second place, unless its place lapsed before its proposal arrived, when it
 * takes one again under the cap; the key with another body is
 * IdempotencyConflict. A
 * proposer with MAX_OPEN_PROPOSALS holding places is ProposalLimit. Read,
 * counted and written in one transaction, so two at once never both pass.
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
    const held = store.get(RESERVED, key);
    if (held !== undefined) {
      const reserved = decodeReserved(held);
      if (reserved.fingerprint !== reservation.fingerprint)
        return new IdempotencyConflict({ idempotencyKey: reservation.idempotencyKey });
      // A place that lapsed before its proposal arrived is taken again, under the cap, or the retry would open one past it.
      const place = openKey(reservation.proposer, reserved.changeId);
      const open = store.get(OPEN, place);
      const lapsed =
        open !== undefined &&
        !decodeOpen(open).proposed &&
        now - decodeOpen(open).at > RESERVATION_TTL_MS;
      if (!lapsed) return reserved.changeId;
      if (holding(store, reservation.proposer, now) >= MAX_OPEN_PROPOSALS)
        return new ProposalLimit({ projectId, limit: MAX_OPEN_PROPOSALS });
      store.put(OPEN, place, { at: now, proposed: false });
      return reserved.changeId;
    }
    if (holding(store, reservation.proposer, now) >= MAX_OPEN_PROPOSALS)
      return new ProposalLimit({ projectId, limit: MAX_OPEN_PROPOSALS });
    store.put(RESERVED, key, { changeId: minted, fingerprint: reservation.fingerprint });
    store.put(OPEN, openKey(reservation.proposer, minted), { at: now, proposed: false });
    store.put(PROPOSER, minted, { proposer: reservation.proposer });
    return minted;
  });
  return typeof answer === "string" ? answer : yield* answer;
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
      store.put(OPEN, key, {
        at: held === undefined ? event.at : decodeOpen(held).at,
        proposed: true,
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
