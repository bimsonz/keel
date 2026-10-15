import { CredentialLabel, CredentialMeta, CredentialMissing } from "@keeltown/core/domain/delivery";
import { CredentialId, NamespaceId, UserId } from "@keeltown/core/kernel";
import { CredentialStore } from "@keeltown/core/ports";
import { Effect, Exit, Layer, ManagedRuntime, Redacted, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  CredentialStoreSealed,
  type CredentialsStub,
} from "../../src/adapters/driven/credentials/credential-store.ts";
import { IdsLive } from "../../src/adapters/driven/system.ts";
import { encodeExit, NamespaceCodecs, SealedCredential } from "../../src/rpc/index.ts";

const ORG = Schema.decodeUnknownSync(NamespaceId)("org_01K9ZZB6P2WQ0H4M7T3V5R8X1C");
const BY = Schema.decodeUnknownSync(UserId)("usr_01K9ZZB6P2WQ0H4M7T3V5R8X1D");
const SECRET = "cf-token-not-a-real-one";

/** A KEK's text, as Secrets Store holds it: base64 of 32 random bytes. */
const kekText = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

/** A namespace object that keeps each seal it is sent and answers it back, as the real one's RPC does. */
function namespaceHolding(): (address: string) => CredentialsStub {
  const held = new Map<string, typeof SealedCredential.Type>();
  const stub: CredentialsStub = {
    putCredential: async (command) => {
      const meta = Schema.decodeUnknownSync(CredentialMeta)({
        id: command.id,
        namespaceId: ORG,
        label: command.label,
        provider: command.provider,
        createdAt: 0,
        createdBy: command.by,
      });
      held.set(
        command.id,
        Schema.decodeUnknownSync(SealedCredential)({
          meta: Schema.encodeSync(CredentialMeta)(meta),
          sealed: command.sealed,
        }),
      );
      return encodeExit(NamespaceCodecs.putCredential, Exit.succeed(meta));
    },
    listCredentials: async () => {
      throw new Error("not asked here");
    },
    getCredential: async (credentialId) => {
      const found = held.get(credentialId);
      return encodeExit(
        NamespaceCodecs.getCredential,
        found === undefined
          ? Exit.fail(
              new CredentialMissing({
                id: Schema.decodeUnknownSync(CredentialId)(credentialId),
              }),
            )
          : Exit.succeed(found),
      );
    },
    removeCredential: async () => {
      throw new Error("not asked here");
    },
  };
  return () => stub;
}

/** One store, built once, over a KEK whose reads `read` answers and the namespace above. */
const storeOver = (read: () => Promise<string>) =>
  ManagedRuntime.make(
    CredentialStoreSealed({ id: "k1", read }, namespaceHolding()).pipe(Layer.provide(IdsLive)),
  );

/** Seals SECRET, then opens what was sealed, through one store. */
const putThenReveal = (store: ManagedRuntime.ManagedRuntime<CredentialStore, never>) =>
  store.runPromise(
    Effect.gen(function* () {
      const credentials = yield* CredentialStore;
      const meta = yield* credentials.put(ORG, {
        label: Schema.decodeUnknownSync(CredentialLabel)("prod"),
        provider: "cloudflare",
        secret: Redacted.make(SECRET),
        by: BY,
      });
      return Redacted.value(yield* credentials.reveal(ORG, meta.id));
    }),
  );

/** A promise that answers `"held"` after `ms` on the real clock. */
const heldAfter = (ms: number) =>
  new Promise<"held">((resolve) => {
    setTimeout(() => resolve("held"), ms);
  });

describe("the credential store's KEK", () => {
  it("[kek.no-shared-read] a call is never held by a KEK read another call started that never settles", async () => {
    const text = kekText();
    let reads = 0;
    // The first read never settles, as one does when Workers drops the request that started it.
    const store = storeOver(() => {
      reads += 1;
      return reads === 1 ? new Promise<string>(() => {}) : Promise.resolve(text);
    });
    void putThenReveal(store);
    await expect(Promise.race([putThenReveal(store), heldAfter(2_000)])).resolves.toBe(SECRET);
    expect(reads).toBe(2);
  });

  it("[kek.read-once] once a read has settled, the KEK is not read again", async () => {
    const text = kekText();
    let reads = 0;
    const store = storeOver(async () => {
      reads += 1;
      return text;
    });
    await expect(putThenReveal(store)).resolves.toBe(SECRET);
    await expect(putThenReveal(store)).resolves.toBe(SECRET);
    expect(reads).toBe(1);
  });

  it("[kek.failed-read-retried] a read that fails keeps nothing: the next call reads the KEK again", async () => {
    const text = kekText();
    let reads = 0;
    const store = storeOver(async () => {
      reads += 1;
      if (reads === 1) throw new Error("Secrets Store did not answer");
      return text;
    });
    await expect(putThenReveal(store)).rejects.toThrow("Secrets Store did not answer");
    await expect(putThenReveal(store)).resolves.toBe(SECRET);
    expect(reads).toBe(2);
  });
});
