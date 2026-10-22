import { Effect, Schema } from "effect";
import type {
  AgentPrincipal,
  QuotaExceeded,
  QuotaKind,
  UserPrincipal,
} from "../../domain/identity/index.ts";
import { NamespaceId } from "../../domain/kernel/index.ts";
import { NamespaceUsage } from "../ports/index.ts";

/** What an account opens, counted per UTC day against it. */
export type AccountRate = Extract<
  QuotaKind,
  "proposals" | "proposal-moves" | "issues" | "issue-comments"
>;

const asNamespace = Schema.decodeUnknownSync(NamespaceId);

/**
 * The account an action counts against: a person's own namespace; an agent's
 * sponsor's, so every agent one person sponsors draws on one allowance; an
 * agent nobody sponsors, its own.
 */
export const accountOf = (principal: UserPrincipal | AgentPrincipal): NamespaceId =>
  asNamespace(
    principal._tag === "User" ? principal.userId : (principal.sponsor ?? principal.agentId),
  );

/**
 * Admits one more of `kind` against the account the action counts against,
 * once per `key`: a retry under the same key counts nothing. Over the
 * account's limit for the day it is QuotaExceeded, with when it resets.
 */
export const admitAccountRate = (
  account: NamespaceId,
  kind: AccountRate,
  key: string,
): Effect.Effect<void, QuotaExceeded, NamespaceUsage> =>
  NamespaceUsage.use((usage) => usage.admit(account, kind, 1, key)).pipe(Effect.asVoid);

/** Gives back, once, what `key` admitted: the action it counted was refused for what it asked. */
export const giveBackAccountRate = (
  account: NamespaceId,
  kind: AccountRate,
  key: string,
): Effect.Effect<void, never, NamespaceUsage> =>
  NamespaceUsage.use((usage) => usage.record(account, kind, -1, `giveback:${key}`));
