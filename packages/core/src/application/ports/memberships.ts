import { Context, type Effect } from "effect";
import type { SponsorStanding } from "../../domain/identity/index.ts";
import type { OrgId, UserId } from "../../domain/kernel/index.ts";

/**
 * An agent's sponsor as the gate reads it on every request: the user's
 * strongest role in the agent's org, absent once it is no member, and whether
 * it is suspended (banned). Better Auth owns both, in its `user` and `member`
 * rows in D1. A user it does not know stands unsuspended with no role.
 */
export class Memberships extends Context.Service<
  Memberships,
  {
    readonly standing: (userId: UserId, org: OrgId) => Effect.Effect<SponsorStanding>;
  }
>()("keel/Memberships") {}
