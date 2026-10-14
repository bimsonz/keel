import { Layer } from "effect";
import {
  CredentialStoreSealed,
  type CredentialsStub,
} from "../adapters/driven/credentials/credential-store.ts";
import { IdsLive } from "../adapters/driven/system.ts";

/**
 * An org's credentials: sealed and opened here, in the Worker,
 * under the KEK Secrets Store holds (`CREDENTIAL_KEK`, known to every seal as
 * `k1`), and kept sealed in the namespace's own object. Pool tests pass the
 * objects they drain. Its own module, so the Workflows that open a deploy
 * token do not load the HTTP side's composition at startup.
 */
export function credentialStoreLayer(
  env: Env,
  namespace: (address: string) => CredentialsStub = (address) =>
    env.NAMESPACE.get(env.NAMESPACE.idFromName(address)),
) {
  return CredentialStoreSealed({ id: "k1", read: () => env.CREDENTIAL_KEK.get() }, namespace).pipe(
    Layer.provide(IdsLive),
  );
}
