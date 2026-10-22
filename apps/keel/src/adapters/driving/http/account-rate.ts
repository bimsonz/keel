import { accountOf, type AccountRate } from "@keeltown/core/application/identity";
import type { QuotaExceeded } from "@keeltown/core/domain/identity";
import type { NamespaceId } from "@keeltown/core/kernel";
import type { Caller } from "./caller.ts";
import { problem } from "./problems.ts";

/** What the account did as many times as its daily limit, as a refusal says it. */
const DONE: Readonly<Record<AccountRate, (limit: number) => string>> = {
  proposals: (limit) => `opened ${limit} proposals`,
  "proposal-moves": (limit) => `moved its proposals to another commit ${limit} times`,
  issues: (limit) => `opened ${limit} issues`,
  "issue-comments": (limit) => `written ${limit} issue comments`,
};

/** The account the caller's action counts against, as the policy let it through. */
export const accountOfCaller = (caller: Caller): NamespaceId => {
  const { principal } = caller;
  if (principal._tag === "Anonymous")
    throw new Error("an account's daily action ran for a caller the policy refuses");
  return accountOf(principal);
};

/**
 * A daily limit the caller's account reached: 429 `rate.limited` until the
 * count starts again at the next UTC midnight. An agent's actions count
 * against the person who sponsors it.
 */
export const rateLimited = (
  caller: Caller,
  error: QuotaExceeded & { readonly kind: AccountRate },
  now: number,
) => {
  const retryAfterMs = Math.max(1_000, (error.retryAt ?? now + 86_400_000) - now);
  return {
    status: 429 as const,
    body: problem(429, "rate.limited", caller.requestId, {
      detail: `Your account has ${DONE[error.kind](error.limit)} today, its daily limit; the count starts again at the next UTC midnight. An agent's count is its sponsor's.`,
      retryAfterMs,
      nextActions: [{ kind: "wait" as const, title: "Send it again after the count starts again" }],
    }),
    headers: { "retry-after": Math.ceil(retryAfterMs / 1000) },
  };
};

/** Whether a refusal is a daily limit the caller's account reached, not another quota. */
export const isAccountRate = (
  error: QuotaExceeded,
): error is QuotaExceeded & { readonly kind: AccountRate } =>
  error.kind === "proposals" ||
  error.kind === "proposal-moves" ||
  error.kind === "issues" ||
  error.kind === "issue-comments";
