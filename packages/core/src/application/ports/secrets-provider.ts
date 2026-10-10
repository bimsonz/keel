import { Context, type Effect } from "effect";
import type { SecretMissing } from "../../domain/delivery/index.ts";

/** Named secrets. Values reach only the egress gateway, never a use-case's output. */
export class SecretsProvider extends Context.Service<
  SecretsProvider,
  {
    readonly get: (name: string) => Effect.Effect<string, SecretMissing>;
  }
>()("keel/SecretsProvider") {}
