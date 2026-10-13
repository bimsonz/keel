import { Context, type Effect, type Option } from "effect";
import type { Handle } from "../../domain/identity/index.ts";
import type { NamespaceId, NamespaceKind } from "../../domain/kernel/index.ts";

/**
 * A namespace as the policy reads it: its handle is the first segment of
 * `/<namespace>/<project>`, and its id is its account's.
 */
export interface NamespaceRecord {
  readonly namespace: NamespaceId;
  readonly handle: Handle;
  readonly kind: NamespaceKind;
  /** A person's ban while it holds, or an org suspended by whoever runs the instance. */
  readonly suspended: boolean;
}

/**
 * Namespaces by id or by handle. Keel owns them, in its D1 `namespaces` table,
 * where a handle is unique across people, agents and orgs and held lower-case,
 * so one is found in any case. The database writes a row in the statement that
 * gives a user its handle or makes an org. A namespace whose account is gone
 * answers none, and its handle is never issued again.
 */
export class Namespaces extends Context.Service<
  Namespaces,
  {
    readonly byId: (namespace: NamespaceId) => Effect.Effect<Option.Option<NamespaceRecord>>;
    readonly byHandle: (handle: string) => Effect.Effect<Option.Option<NamespaceRecord>>;
  }
>()("keel/Namespaces") {}
