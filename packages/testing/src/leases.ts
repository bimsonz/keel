import type { Lease } from "@keeltown/core/domain/coordination";

/**
 * The lease of a change an agent holds, as a test reads it: every change an
 * agent declared or adopted has one, and a proposal, which none holds, has
 * none, so asking a proposal for it fails the test.
 */
export const heldLease = (change: {
  readonly id: string;
  readonly lease?: Lease | undefined;
}): Lease => {
  if (change.lease === undefined) throw new Error(`${change.id} holds no lease: no agent holds it`);
  return change.lease;
};
