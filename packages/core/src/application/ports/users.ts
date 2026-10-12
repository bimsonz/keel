import { Context, type Effect, type Option } from "effect";
import type { UserPrincipal } from "../../domain/identity/index.ts";
import type { UserId } from "../../domain/kernel/index.ts";

/**
 * A signed-in user as the gate builds its principal. Better Auth owns users
 * and memberships, in its `user` and `member` rows in D1: the handle is the
 * username once chosen, a banned user is suspended, and each membership takes the strongest
 * role its row names (one naming none is no membership), in org id order.
 */
export class Users extends Context.Service<
  Users,
  {
    readonly principal: (userId: UserId) => Effect.Effect<Option.Option<UserPrincipal>>;
  }
>()("keel/Users") {}
