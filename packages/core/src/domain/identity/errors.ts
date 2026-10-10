import { Schema } from "effect";
import { AgentId } from "../kernel/index.ts";

/** No agent has this id. */
export class AgentNotKnown extends Schema.TaggedError<AgentNotKnown>()("AgentNotKnown", { agentId: AgentId }) {}

/** The agent exists but may not act: suspended, revoked, or the token's epoch is stale. */
export class AgentNotAdmitted extends Schema.TaggedError<AgentNotAdmitted>()("AgentNotAdmitted", {
  agentId: AgentId,
  reason: Schema.Literals(["suspended", "revoked", "stale-epoch"]),
}) {}

/** The client id is unknown or the secret does not match. Deliberately says no more than that. */
export class CredentialRejected extends Schema.TaggedError<CredentialRejected>()("CredentialRejected", {}) {}

/** A bearer token failed verification: malformed, badly signed, expired, or for another audience. */
export class TokenRejected extends Schema.TaggedError<TokenRejected>()("TokenRejected", {
  reason: Schema.Literals(["malformed", "signature", "expired", "claims"]),
}) {}

/** The client asked for a scope it does not hold. */
export class ScopeNotGranted extends Schema.TaggedError<ScopeNotGranted>()("ScopeNotGranted", {
  requested: Schema.Array(Schema.String),
}) {}
