import { namespaceAddress } from "@keeltown/core/application/coordination";
import type { CredentialId, NamespaceId } from "@keeltown/core/kernel";
import { CredentialStore, Ids } from "@keeltown/core/ports";
import { Effect, Layer, Redacted, Schema } from "effect";
import {
  NamespaceCodecs,
  PutCredentialCommand,
  RemoveCredentialCommand,
} from "../../../rpc/index.ts";
import { callObject } from "../do-rpc/answer.ts";
import { credentialAad, importKek, open, seal } from "./envelope.ts";

/** The namespace object's methods the store calls (`ns:<id>`), answering Exit envelopes. */
export interface CredentialsStub {
  putCredential(command: typeof PutCredentialCommand.Encoded): Promise<unknown>;
  listCredentials(): Promise<unknown>;
  getCredential(credentialId: string): Promise<unknown>;
  removeCredential(command: typeof RemoveCredentialCommand.Encoded): Promise<unknown>;
}

/** The key that wraps every credential's data key: the id each seal names it by, and where its bytes are read. */
export interface CredentialKek {
  readonly id: string;
  /** The KEK as base64 of 32 bytes: Secrets Store's binding, read when the key is first needed. */
  readonly read: () => Promise<string>;
}

const encodePut = Schema.encodeSync(PutCredentialCommand);
const encodeRemove = Schema.encodeSync(RemoveCredentialCommand);

/**
 * `CredentialStore` with the sealing in the Worker: `put` mints
 * the id, seals the secret under a data key of its own bound to the namespace
 * and that id, and sends only the seal to the namespace's object, which keeps
 * it and commits `CredentialStored`. `reveal` takes the seal back and opens it
 * here. The object never holds the KEK, and nothing it stores, answers or
 * commits holds the secret. The KEK is kept for the life of the layer (the
 * isolate's runtime) once a read of it has been imported; until then each call
 * reads it for itself, so no request ever waits on a read another request
 * started, which Workers drops with that request. A failed read keeps nothing.
 */
export function CredentialStoreSealed(
  kek: CredentialKek,
  namespace: (address: string) => CredentialsStub,
): Layer.Layer<CredentialStore, never, Ids> {
  const objectOf = (namespaceId: NamespaceId) => namespace(namespaceAddress(namespaceId));
  const held = (namespaceId: NamespaceId, id: CredentialId) =>
    callObject(NamespaceCodecs.getCredential, () => objectOf(namespaceId).getCredential(id));
  return Layer.effect(
    CredentialStore,
    Effect.gen(function* () {
      const ids = yield* Ids;
      let imported: CryptoKey | undefined;
      const key = async (): Promise<CryptoKey> => {
        if (imported !== undefined) return imported;
        const read = await importKek(await kek.read());
        imported ??= read;
        return imported;
      };
      return CredentialStore.of({
        put: (namespaceId, { label, provider, secret, by }) =>
          Effect.gen(function* () {
            const id = yield* ids.next("crd");
            const sealed = yield* Effect.promise(async () =>
              seal(await key(), kek.id, credentialAad(namespaceId, id), Redacted.value(secret)),
            );
            return yield* callObject(NamespaceCodecs.putCredential, () =>
              objectOf(namespaceId).putCredential(encodePut({ id, label, provider, by, sealed })),
            );
          }),
        list: (namespaceId) =>
          callObject(NamespaceCodecs.listCredentials, () =>
            objectOf(namespaceId).listCredentials(),
          ),
        has: (namespaceId, id) =>
          held(namespaceId, id).pipe(
            Effect.as(true),
            Effect.catchTag("CredentialMissing", () => Effect.succeed(false)),
          ),
        reveal: (namespaceId, id) =>
          Effect.flatMap(held(namespaceId, id), ({ sealed }) =>
            Effect.promise(async () => {
              if (sealed.kek !== kek.id)
                throw new Error(`${id} is sealed under KEK ${sealed.kek}, not ${kek.id}`);
              return Redacted.make(await open(await key(), credentialAad(namespaceId, id), sealed));
            }),
          ),
        remove: (namespaceId, id, by) =>
          callObject(NamespaceCodecs.removeCredential, () =>
            objectOf(namespaceId).removeCredential(encodeRemove({ id, by })),
          ),
      });
    }),
  );
}
