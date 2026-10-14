import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { namespaceAddress } from "@keeltown/core/application/coordination";
import { CREDENTIAL } from "@keeltown/core/application/delivery";
import { namespaceRef } from "@keeltown/core/application/identity";
import { CredentialLabel } from "@keeltown/core/domain/delivery";
import { makeId, NamespaceId, UserId, userActor } from "@keeltown/core/kernel";
import { CredentialStore, EventOutbox } from "@keeltown/core/ports";
import { PORTS } from "@keeltown/testing";
import { Effect, Redacted, Schema } from "effect";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import type { NamespaceDO } from "../../src/adapters/driving/do/namespace.ts";
import { credentialStoreLayer } from "../../src/composition/credentials.ts";
import { drainAfter } from "./helpers.ts";

/** A namespace's object, drained after each case: a credential's put and removal commit events. */
const namespaceObject = (address: string) =>
  drainAfter(env.NAMESPACE.get(env.NAMESPACE.idFromName(address)));

/** The store as the Worker composes it: the real KEK binding, sealing here, the real namespace object. */
const store = () => credentialStoreLayer(env, namespaceObject);

// The real store passes the same contract as the in-memory one, inside workerd.
PORTS.CredentialStore.contract("namespace object over RPC, sealed in the Worker", store);

const run = <A, E>(program: Effect.Effect<A, E, CredentialStore>) =>
  Effect.runPromise(program.pipe(Effect.provide(store())));

const freshNamespace = () => Schema.decodeSync(NamespaceId)(`org_${ulid()}`);
const OWNER = Schema.decodeSync(UserId)(`usr_${ulid()}`);
const label = Schema.decodeSync(CredentialLabel);
const freshToken = () => `cf-token-${crypto.randomUUID()}`;

/** Everything the namespace's object keeps, raw: every SQL table's rows and every key of its KV, as text. */
const storedRaw = (namespaceId: NamespaceId) =>
  runInDurableObject(namespaceObject(namespaceAddress(namespaceId)), async (_instance, state) => {
    const sql = state.storage.sql;
    const tables = sql
      .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .toArray()
      .map((row) => row.name)
      .filter((name) => !name.startsWith("_cf_") && !name.startsWith("sqlite_"));
    const rows = Object.fromEntries(
      tables.map((table) => [table, sql.exec(`SELECT * FROM "${table}"`).toArray()]),
    );
    const kv = Object.fromEntries(await state.storage.list());
    // A blob is read as its bytes, one character each, so a secret's bytes are found in it as text.
    return JSON.stringify({ rows, kv }, (_key, value: unknown) =>
      value instanceof ArrayBuffer ? String.fromCharCode(...new Uint8Array(value)) : value,
    );
  });

/** The row the object keeps for one credential, decoded from its entity store as it lies there. */
const storedRow = (namespaceId: NamespaceId, id: string) =>
  runInDurableObject(namespaceObject(namespaceAddress(namespaceId)), (_instance, state) =>
    state.storage.sql
      .exec<{ value: string }>(
        "SELECT value FROM entities WHERE kind = ? AND id = ?",
        CREDENTIAL,
        id,
      )
      .toArray()
      .map((row): unknown => JSON.parse(row.value)),
  );

/** The object's committed events on the namespace's own entity, read from its outbox. */
const eventsOf = (namespaceId: NamespaceId) =>
  runInDurableObject(namespaceObject(namespaceAddress(namespaceId)), (instance: NamespaceDO) =>
    instance["runtime"].runPromise(
      Effect.map(EventOutbox, (outbox) =>
        outbox
          .log(namespaceRef(namespaceId))
          .map((event) => ({ type: event.type, actor: event.actor, payload: event.payload })),
      ),
    ),
  );

describe("an org's credential store, through the namespace's object", () => {
  it("[cred.sealed-at-rest] keeps a stored secret sealed: neither its bytes nor its base64 are anywhere in the object's storage", async () => {
    const namespaceId = freshNamespace();
    const token = freshToken();
    const stored = await run(
      CredentialStore.use((credentials) =>
        credentials.put(namespaceId, {
          label: label("staging deploys"),
          provider: "cloudflare",
          secret: Redacted.make(token),
          by: OWNER,
        }),
      ),
    );
    // The check reads what was kept: the row is there, sealed under the KEK `k1`, with its record beside it.
    expect(await storedRow(namespaceId, stored.id)).toEqual([
      {
        meta: { ...stored },
        sealed: {
          v: 1,
          kek: "k1",
          wrapped: expect.any(String),
          iv: expect.any(String),
          ct: expect.any(String),
        },
      },
    ]);
    const raw = await storedRaw(namespaceId);
    expect(raw).toContain(stored.id);
    expect(raw).toContain("staging deploys");
    expect(raw).toContain("CredentialStored");
    expect(raw).not.toContain(token);
    expect(raw).not.toContain(btoa(token));
    // And the secret still opens, for the one caller that may open it.
    const revealed = await run(
      CredentialStore.use((credentials) => credentials.reveal(namespaceId, stored.id)),
    );
    expect(Redacted.value(revealed)).toBe(token);
  });

  it("[cred.list-no-secret] lists the record alone, holds what it stored and nothing else, and reveals the secret it was given", async () => {
    const namespaceId = freshNamespace();
    const token = freshToken();
    const { stored, listed, held, unknown, revealed } = await run(
      Effect.gen(function* () {
        const credentials = yield* CredentialStore;
        const put = yield* credentials.put(namespaceId, {
          label: label("deploys"),
          provider: "cloudflare",
          secret: Redacted.make(token),
          by: OWNER,
        });
        return {
          stored: put,
          listed: yield* credentials.list(namespaceId),
          held: yield* credentials.has(namespaceId, put.id),
          unknown: yield* credentials.has(namespaceId, makeId("crd", ulid())),
          revealed: yield* credentials.reveal(namespaceId, put.id),
        };
      }),
    );
    expect(listed).toEqual([stored]);
    expect(stored).toMatchObject({ namespaceId, label: "deploys", createdBy: OWNER });
    expect(held).toBe(true);
    expect(unknown).toBe(false);
    expect(Redacted.value(revealed)).toBe(token);
    // What the object answers a list with carries no seal, and no byte of the secret.
    const [row] = await storedRow(namespaceId, stored.id);
    const answer = JSON.stringify(
      await namespaceObject(namespaceAddress(namespaceId)).listCredentials(),
    );
    expect(answer).toContain(stored.id);
    expect(answer).not.toContain("sealed");
    expect(answer).not.toContain(Reflect.get(Object(Reflect.get(Object(row), "sealed")), "ct"));
    expect(answer).not.toContain(token);
    expect(JSON.stringify(listed)).not.toContain(btoa(token));
  });

  it("[cred.remove] removes a credential, seal and all, and commits who removed it: it is no longer listed, held or revealed", async () => {
    const namespaceId = freshNamespace();
    const { kept, removed } = await run(
      Effect.gen(function* () {
        const credentials = yield* CredentialStore;
        const first = yield* credentials.put(namespaceId, {
          label: label("kept"),
          provider: "cloudflare",
          secret: Redacted.make(freshToken()),
          by: OWNER,
        });
        const second = yield* credentials.put(namespaceId, {
          label: label("removed"),
          provider: "cloudflare",
          secret: Redacted.make(freshToken()),
          by: OWNER,
        });
        yield* credentials.remove(namespaceId, second.id, OWNER);
        return { kept: first, removed: second };
      }),
    );
    const after = await run(
      Effect.gen(function* () {
        const credentials = yield* CredentialStore;
        return {
          listed: yield* credentials.list(namespaceId),
          held: yield* credentials.has(namespaceId, removed.id),
          revealing: yield* Effect.flip(credentials.reveal(namespaceId, removed.id)),
          again: yield* Effect.flip(credentials.remove(namespaceId, removed.id, OWNER)),
        };
      }),
    );
    expect(after.listed).toEqual([kept]);
    expect(after.held).toBe(false);
    expect(after.revealing).toMatchObject({ _tag: "CredentialMissing", id: removed.id });
    expect(after.again).toMatchObject({ _tag: "CredentialMissing", id: removed.id });
    expect(await storedRow(namespaceId, removed.id)).toEqual([]);
    expect(await storedRow(namespaceId, kept.id)).toHaveLength(1);
    expect(await eventsOf(namespaceId)).toEqual([
      {
        type: "CredentialStored",
        actor: userActor(OWNER),
        payload: expect.objectContaining({ credential: kept }),
      },
      {
        type: "CredentialStored",
        actor: userActor(OWNER),
        payload: expect.objectContaining({ credential: removed }),
      },
      {
        type: "CredentialRemoved",
        actor: userActor(OWNER),
        payload: {
          _tag: "CredentialRemoved",
          namespaceId,
          credentialId: removed.id,
          by: OWNER,
        },
      },
    ]);
  });
});
