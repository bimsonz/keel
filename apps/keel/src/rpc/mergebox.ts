import { BoxCheck } from "@keeltown/core/domain/integration";
import { CommitSha } from "@keeltown/core/kernel";
import { Schema } from "effect";
import { RepoRef } from "./workspace-pool.ts";

/**
 * A compose asked of MergeBox, version 1: staging, the candidate's base, and
 * each member's workspace, base and head. A box decodes an older version it
 * knows, and answers one it does not with `unsupported`, never a crash, so a
 * Lane and a box of adjacent deploys still talk.
 */
export const BoxComposeRequest = Schema.Struct({
  v: Schema.Literal(1),
  candidateId: Schema.String,
  staging: RepoRef,
  base: CommitSha,
  members: Schema.Array(Schema.Struct({ repo: RepoRef, base: CommitSha, head: CommitSha })),
});
export type BoxComposeRequest = typeof BoxComposeRequest.Type;

/** What one compose cost in the box: what the check streamed back is its cost to keel. */
export const BoxTimings = Schema.Struct({
  /** Starting the box, trusting the egress's CA and planting the canary; 0 when it was running. */
  startMs: Schema.Number,
  composeMs: Schema.Number,
  checkMs: Schema.Number,
  checkBytes: Schema.Number,
});

/** MergeBox's answer to a compose. */
export const BoxComposeAnswer = Schema.Union([
  /** Each member's tree, the chain pushed to `scratch`, and the check that passed. */
  Schema.Struct({
    kind: Schema.Literal("composed"),
    trees: Schema.Array(Schema.String),
    scratch: Schema.String,
    tip: Schema.String,
    boxCheck: BoxCheck,
    timings: BoxTimings,
  }),
  /** git's merge-tree found a conflict: the member and its paths. */
  Schema.Struct({
    kind: Schema.Literal("refused"),
    member: Schema.Number,
    paths: Schema.Array(Schema.String),
    timings: BoxTimings,
  }),
  /** git died by a signal: asked once, never again. */
  Schema.Struct({ kind: Schema.Literal("crashed"), exitCode: Schema.Number }),
  /** The box could not fetch, push or say what it did. */
  Schema.Struct({ kind: Schema.Literal("failed"), reason: Schema.String }),
  /** The check of the box did not pass: a defect, and the candidate is refused. */
  Schema.Struct({ kind: Schema.Literal("check-failed"), reason: Schema.String }),
  /** A request of a version this box does not know. */
  Schema.Struct({ kind: Schema.Literal("unsupported"), reason: Schema.String }),
]);
export type BoxComposeAnswer = typeof BoxComposeAnswer.Type;

/** BoxGate's answer to an ask for a box: a lease until `expiresAt`, or no room until `retryAfterMs`. */
export const BoxLeaseAnswer = Schema.Union([
  Schema.Struct({
    granted: Schema.Literal(true),
    leaseId: Schema.String,
    expiresAt: Schema.Number,
  }),
  Schema.Struct({
    granted: Schema.Literal(false),
    /** Until the soonest live lease's deadline; a minute when none is live (a limit of 0). */
    retryAfterMs: Schema.Number,
    held: Schema.Number,
    limit: Schema.Number,
  }),
]);
export type BoxLeaseAnswer = typeof BoxLeaseAnswer.Type;

/** What the egress asks the box for one outbound request: a token for the repo it names, or a refusal. */
export const EgressGrant = Schema.Union([
  Schema.Struct({ token: Schema.String }),
  Schema.Struct({ refused: Schema.String }),
]);
export type EgressGrant = typeof EgressGrant.Type;
