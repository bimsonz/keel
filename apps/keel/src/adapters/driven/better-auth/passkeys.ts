/**
 * When each of a person's passkeys last signed in. Better Auth's row for a
 * passkey holds its name and when it was added; a sign-in writes the row's
 * counter and no time. So Keel keeps the time in a column of its own
 * (migration 0015). Better Auth's list of a person's passkeys answers the
 * row's fields, so the time reaches whoever holds the key by the list they
 * already read.
 */
import type { BetterAuthPlugin, GenericEndpointContext } from "better-auth";

/** Declares the column, so the adapter reads and writes it. No request sets it. */
export const keyUse = () =>
  ({
    id: "key-use",
    schema: {
      passkey: {
        fields: { lastUsedAt: { type: "date", required: false, input: false } },
      },
    },
  }) satisfies BetterAuthPlugin;

/** Marks the passkey with this credential id as used now: the one that has just signed in. */
export async function usedNow(ctx: GenericEndpointContext, credentialId: string): Promise<void> {
  await ctx.context.adapter.update({
    model: "passkey",
    where: [{ field: "credentialID", value: credentialId }],
    update: { lastUsedAt: new Date() },
  });
}
