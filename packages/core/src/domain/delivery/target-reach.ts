import { Schema } from "effect";

/**
 * A deploy target's credential that does not reach its account's Workers: the
 * provider refused the token, the token does not reach that account, or the
 * account has no workers.dev subdomain to serve a preview from. Keel never
 * creates one: it names the account publicly, so it is the owner's to set.
 */
export class DeployTargetUnreachable extends Schema.TaggedError<DeployTargetUnreachable>()(
  "DeployTargetUnreachable",
  {
    reason: Schema.Literals(["token-invalid", "account-unreachable", "no-workers-dev"]),
    /** The provider's own error code, when it gave one. */
    code: Schema.optional(Schema.Number),
  },
) {}
