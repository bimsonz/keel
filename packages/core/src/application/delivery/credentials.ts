import { Effect, Option, Result, Schema } from "effect";
import {
  type CredentialLabel,
  CredentialMeta,
  CredentialMissing,
  CredentialRemoved,
  CredentialStored,
  type DeployProvider,
} from "../../domain/delivery/index.ts";
import {
  type CredentialId,
  IllegalTransition,
  type NamespaceId,
  userActor,
  type UserId,
} from "../../domain/kernel/index.ts";
import { namespaceRef } from "../identity/index.ts";
import {
  commit,
  EntityStore,
  type EventDraft,
  type Stored,
  type Transition,
} from "../ports/index.ts";

/** The store kind of a namespace's credentials: one row a credential, in the namespace's own object. */
export const CREDENTIAL = "credential";

/**
 * A credential as its namespace's object keeps it: the record anyone may
 * read, and the secret, sealed before it reached the object. The object
 * stores the seal and hands it back; it never opens it.
 */
export interface HeldCredential {
  readonly meta: CredentialMeta;
  readonly sealed: Stored;
}

/** A credential to keep, as the Worker that sealed it sends it: the id it minted and sealed the secret under. */
export interface HoldCredential {
  readonly id: CredentialId;
  readonly label: CredentialLabel;
  readonly provider: DeployProvider;
  readonly by: UserId;
  readonly sealed: Stored;
}

const Row = Schema.Struct({ meta: CredentialMeta, sealed: Schema.Json });
const decodeRow = Schema.decodeUnknownSync(Row);
const encodeMeta = Schema.encodeSync(CredentialMeta);
const encodeStored = Schema.encodeSync(CredentialStored);
const encodeRemoved = Schema.encodeSync(CredentialRemoved);
const decodeStored = Schema.decodeUnknownOption(CredentialStored);
const asStored = (encoded: unknown): Stored => JSON.parse(JSON.stringify(encoded));
const draftOf = (encoded: unknown): EventDraft => ({
  payload: JSON.parse(JSON.stringify(encoded)),
});

type Store = (typeof EntityStore)["Service"];

const heldIn = (store: Store, id: CredentialId): HeldCredential | undefined => {
  const row = store.get(CREDENTIAL, id);
  return row === undefined ? undefined : decodeRow(row);
};

/**
 * Keeps a sealed credential in the namespace's object and commits
 * `CredentialStored` with it, on the namespace's own entity: the record, never
 * the seal. The id is the cause, so the same call again keeps nothing more
 * and answers the record as first stored.
 */
export const holdCredential = Effect.fn("delivery/holdCredential")(function* (
  namespace: NamespaceId,
  command: HoldCredential,
) {
  const { id, label, provider, by, sealed } = command;
  const committed = yield* commit(
    { entity: namespaceRef(namespace), cause: `credential-stored:${id}`, actor: userActor(by) },
    (tx) => {
      const meta: CredentialMeta = {
        id,
        namespaceId: namespace,
        label,
        provider,
        createdAt: tx.at,
        createdBy: by,
      };
      tx.store.put(CREDENTIAL, id, { meta: asStored(encodeMeta(meta)), sealed });
      const stored = CredentialStored.make({ namespaceId: namespace, credential: meta, by });
      return Result.succeed({ value: meta, drafts: [draftOf(encodeStored(stored))] });
    },
  );
  if (!committed.duplicate) return committed.value;
  const first = committed.events.map((event) => decodeStored(event.payload)).find(Option.isSome);
  if (first === undefined)
    throw new IllegalTransition(`credential-stored:${id} committed no CredentialStored`);
  return first.value.credential;
});

/** The namespace's credentials, oldest first: their records alone, never a seal. */
export const credentialRecords = EntityStore.use((store) =>
  Effect.sync(() =>
    store
      .list(CREDENTIAL)
      .map((row) => decodeRow(row.value).meta)
      .toSorted((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  ),
);

/** One credential with its seal, for the Worker that opens it; one the namespace does not hold is CredentialMissing. */
export const heldCredential = Effect.fn("delivery/heldCredential")(function* (id: CredentialId) {
  const held = heldIn(yield* EntityStore, id);
  if (held === undefined) return yield* new CredentialMissing({ id });
  return held;
});

/**
 * Removes a credential, seal and all, and commits `CredentialRemoved`. One the
 * namespace does not hold is CredentialMissing, and so is a second removal:
 * the first took it.
 */
export const dropCredential = Effect.fn("delivery/dropCredential")(function* (
  namespace: NamespaceId,
  command: { readonly id: CredentialId; readonly by: UserId },
) {
  const { id, by } = command;
  const committed = yield* commit(
    { entity: namespaceRef(namespace), cause: `credential-removed:${id}`, actor: userActor(by) },
    (tx): Result.Result<Transition<void>, CredentialMissing> => {
      if (heldIn(tx.store, id) === undefined) return Result.fail(new CredentialMissing({ id }));
      tx.store.remove(CREDENTIAL, id);
      const removed = CredentialRemoved.make({ namespaceId: namespace, credentialId: id, by });
      return Result.succeed({ value: undefined, drafts: [draftOf(encodeRemoved(removed))] });
    },
  );
  // The cause already committed: the first removal took it.
  if (committed.duplicate) yield* new CredentialMissing({ id });
});
