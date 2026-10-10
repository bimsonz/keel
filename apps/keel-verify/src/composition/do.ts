import { Layer, ManagedRuntime } from "effect";

/**
 * The VerifierDO's composition root: one runtime per instance, built in the
 * constructor. keel-verify holds no credentials, so its Layers are bound to
 * nothing worth stealing; they grow as the Tier 1 runner is added.
 */
export function verifierRuntime(_env: Env) {
  return ManagedRuntime.make(Layer.empty);
}
