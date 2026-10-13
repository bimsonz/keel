import { Context, type Effect } from "effect";
import type { MemberStanding } from "../../domain/identity/index.ts";
import type { NamespaceId, UserId } from "../../domain/kernel/index.ts";

/**
 * An agent's sponsor as the gate reads it on every request: the user's role in
 * the agent's namespace, and whether it is suspended (banned). In the namespace
 * whose id is the user's own the role is `owner`, by identity; in an org it is
 * the strongest its member rows name, absent once it is no member; anywhere
 * else there is none. Better Auth owns the ban and the member rows, in D1. A
 * user it does not know stands unsuspended with no role, in its own namespace
 * too.
 */
export class Memberships extends Context.Service<
  Memberships,
  {
    readonly standing: (userId: UserId, namespace: NamespaceId) => Effect.Effect<MemberStanding>;
  }
>()("keel/Memberships") {}
