import { describe, expect, it } from "@effect/vitest";
import { CredentialLabel } from "@keeltown/core/domain/delivery";
import { idPattern, NamespaceId, UserId } from "@keeltown/core/kernel";
import { CredentialStore } from "@keeltown/core/ports";
import { Effect, type Layer, Redacted, Schema } from "effect";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ulid = () =>
  [...crypto.getRandomValues(new Uint8Array(26))].map((b) => CROCKFORD[b % 32] ?? "0").join("");

/** An org no case has stored in: a real adapter's storage may outlive one case. */
const freshNamespace = () => Schema.decodeUnknownSync(NamespaceId)(`org_${ulid()}`);
const owner = Schema.decodeUnknownSync(UserId)(`usr_${ulid()}`);
const label = Schema.decodeUnknownSync(CredentialLabel);

/** A token no other case uses, so finding it anywhere means this case's secret leaked there. */
const freshToken = () => `cf-token-${crypto.randomUUID()}`;

/** The record's fields, and nothing beside them: no secret, sealed or not. */
const RECORD_FIELDS = ["createdAt", "createdBy", "id", "label", "namespaceId", "provider"];

export function describeCredentialStoreContract(
  adapter: string,
  make: () => Layer.Layer<CredentialStore>,
) {
  describe(`CredentialStore contract: ${adapter}`, () => {
    it.live(
      "[credstore.contract.put] stores each credential under an id of its own and lists its record (label, provider, who stored it, the namespace), never its secret",
      () =>
        Effect.gen(function* () {
          const store = yield* CredentialStore;
          const namespaceId = freshNamespace();
          const tokens = [freshToken(), freshToken()] as const;
          const first = yield* store.put(namespaceId, {
            label: label("staging account"),
            provider: "cloudflare",
            secret: Redacted.make(tokens[0]),
            by: owner,
          });
          const second = yield* store.put(namespaceId, {
            label: label("production account"),
            provider: "cloudflare",
            secret: Redacted.make(tokens[1]),
            by: owner,
          });
          expect(first.id).toMatch(idPattern("crd"));
          expect(second.id).toMatch(idPattern("crd"));
          expect(second.id).not.toBe(first.id);
          expect(first).toMatchObject({
            namespaceId,
            label: label("staging account"),
            provider: "cloudflare",
            createdBy: owner,
          });
          const listed = yield* store.list(namespaceId);
          expect(listed).toEqual([first, second]);
          for (const record of listed)
            expect(Object.keys(record).toSorted()).toEqual(RECORD_FIELDS);
          const read = JSON.stringify(listed);
          for (const token of tokens) expect(read).not.toContain(token);
          expect(yield* store.has(namespaceId, first.id)).toBe(true);
          expect(yield* store.has(namespaceId, second.id)).toBe(true);
        }).pipe(Effect.provide(make())),
    );

    it.live(
      "[credstore.contract.reveal] reveals the secret it was given, redacted, to the namespace that holds it",
      () =>
        Effect.gen(function* () {
          const store = yield* CredentialStore;
          const namespaceId = freshNamespace();
          const token = freshToken();
          const stored = yield* store.put(namespaceId, {
            label: label("deploys"),
            provider: "cloudflare",
            secret: Redacted.make(token),
            by: owner,
          });
          const revealed = yield* store.reveal(namespaceId, stored.id);
          expect(Redacted.isRedacted(revealed)).toBe(true);
          expect(Redacted.value(revealed)).toBe(token);
          expect(JSON.stringify(revealed)).not.toContain(token);
        }).pipe(Effect.provide(make())),
    );

    it.live(
      "[credstore.contract.scoped] a credential is its namespace's alone: another neither lists, holds, reveals nor removes it",
      () =>
        Effect.gen(function* () {
          const store = yield* CredentialStore;
          const namespaceId = freshNamespace();
          const other = freshNamespace();
          const stored = yield* store.put(namespaceId, {
            label: label("deploys"),
            provider: "cloudflare",
            secret: Redacted.make(freshToken()),
            by: owner,
          });
          expect(yield* store.list(other)).toEqual([]);
          expect(yield* store.has(other, stored.id)).toBe(false);
          const revealing = yield* Effect.flip(store.reveal(other, stored.id));
          expect(revealing).toMatchObject({ _tag: "CredentialMissing", id: stored.id });
          const removing = yield* Effect.flip(store.remove(other, stored.id, owner));
          expect(removing).toMatchObject({ _tag: "CredentialMissing", id: stored.id });
          // The other namespace's attempts moved nothing in the one that holds it.
          expect(yield* store.list(namespaceId)).toEqual([stored]);
          expect(yield* store.has(namespaceId, stored.id)).toBe(true);
        }).pipe(Effect.provide(make())),
    );

    it.live(
      "[credstore.contract.remove] a removed credential is no longer listed, held or revealed, and removing it again is CredentialMissing",
      () =>
        Effect.gen(function* () {
          const store = yield* CredentialStore;
          const namespaceId = freshNamespace();
          const kept = yield* store.put(namespaceId, {
            label: label("kept"),
            provider: "cloudflare",
            secret: Redacted.make(freshToken()),
            by: owner,
          });
          const removed = yield* store.put(namespaceId, {
            label: label("removed"),
            provider: "cloudflare",
            secret: Redacted.make(freshToken()),
            by: owner,
          });
          yield* store.remove(namespaceId, removed.id, owner);
          expect(yield* store.list(namespaceId)).toEqual([kept]);
          expect(yield* store.has(namespaceId, removed.id)).toBe(false);
          expect(yield* Effect.flip(store.reveal(namespaceId, removed.id))).toMatchObject({
            _tag: "CredentialMissing",
            id: removed.id,
          });
          expect(yield* Effect.flip(store.remove(namespaceId, removed.id, owner))).toMatchObject({
            _tag: "CredentialMissing",
            id: removed.id,
          });
          expect(yield* store.has(namespaceId, kept.id)).toBe(true);
        }).pipe(Effect.provide(make())),
    );
  });
}
