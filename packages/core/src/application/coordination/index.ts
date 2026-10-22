import type {
  Change,
  FootprintEntry,
  Preflight,
  Proposition,
} from "../../domain/coordination/index.ts";
import type {
  ChangeId,
  CommitSha,
  DecisionId,
  LeaseId,
  WorkspaceId,
} from "../../domain/kernel/index.ts";
import type { WorkspaceEdit, WorkspaceGrant } from "../ports/index.ts";
import type { Withdrawal } from "./change.ts";

/**
 * coordination use-cases. The isolate reaches a change through the `Changes`
 * port with the inputs below; the Change DO runs the use-cases in `change.ts`.
 */

export interface DeclareInput {
  readonly goal: string;
  readonly footprint: readonly FootprintEntry[];
  readonly premises: readonly Proposition[];
  readonly declaredEffects?: readonly Proposition[];
  readonly idempotencyKey: string;
}

export interface Declared {
  readonly change: Change;
  readonly preflight: Preflight;
  readonly workspace: WorkspaceGrant;
}

/** Adopt a change whose lease lapsed. The adopter holds no lease: its token's project is the authority checked. */
export interface AdoptInput {
  readonly changeId: ChangeId;
  readonly idempotencyKey: string;
}

/** The change under the adopter's new lease, and a fresh token for the workspace it holds, when it holds one. */
export interface Adopted {
  readonly change: Change;
  readonly workspace?: WorkspaceGrant;
}

/**
 * Withdraw a change: under its lease, or as a maintainer of its project. The
 * Change DO authorises the lease and confines the maintainer to the project.
 */
export interface AbandonInput {
  readonly changeId: ChangeId;
  readonly authority: Withdrawal;
  readonly reason?: string;
  readonly idempotencyKey: string;
}

/** An abandon as a doorway hands it over: the `Keel-Lease` value when the caller sent one. */
export interface AbandonCall {
  readonly changeId: ChangeId;
  readonly lease?: LeaseId;
  readonly reason?: string;
  readonly idempotencyKey: string;
}

/** Writes made on a change: the caller holds its lease. */
export interface LeasedCall {
  readonly changeId: ChangeId;
  readonly lease: LeaseId;
  readonly idempotencyKey: string;
}

export interface ReviseInput extends LeasedCall {
  readonly ifMatchRevision: number;
  readonly goal?: string;
  readonly footprint?: readonly FootprintEntry[];
  readonly premisesAdded: readonly Proposition[];
  readonly premisesRetracted: readonly Proposition[];
  readonly declaredEffects?: readonly Proposition[];
}

/** A distinction from a precedent: the caller holds the change's lease. */
export interface DistinguishInput extends LeasedCall {
  readonly decisionId: DecisionId;
  readonly distinction: string;
}

/** Add one premise: the caller holds the lease. */
export interface RelyInput extends LeasedCall {
  readonly premise: Proposition;
}

export interface SubmitInput extends LeasedCall {
  readonly commitSha: CommitSha;
}

/** Move a change onto trunk's head, after a textual bounce: the caller holds its lease. */
export type RebaseInput = LeasedCall;

/** Commit edits in a change's workspace through Keel, with no clone: the caller holds its lease. */
export interface CommitInput extends LeasedCall {
  /** The workspace head the agent read: the compare-and-swap. */
  readonly expectedHead: CommitSha;
  /** The commit the edits apply to; absent is `expectedHead`. */
  readonly parent?: CommitSha;
  readonly edits: readonly WorkspaceEdit[];
  readonly message: string;
}

/** A fresh token for the workspace a change holds: the caller holds its lease. Nothing is stored, so no key. */
export interface RefreshInput {
  readonly changeId: ChangeId;
  readonly lease: LeaseId;
}

/** A fresh token for a workspace, as a doorway names it: the lease is on the change that holds it. */
export interface WorkspaceTokenInput {
  readonly workspaceId: WorkspaceId;
  readonly lease: LeaseId;
}

export interface Revised {
  readonly change: Change;
  readonly preflight: Preflight;
}

/** The Change DO's use-cases. */
export * from "./change.ts";
export * from "./conflict-moves.ts";
export * from "./escalations.ts";
export * from "./live-index.ts";
export * from "./party-conflicts.ts";
export * from "./preflight.ts";
export * from "./probe-ledger.ts";
export * from "./proposal-ledger.ts";
export * from "./read-scope.ts";
export * from "./subject.ts";
export * from "./subject-fallout.ts";

/** The WorkspacePool use-cases. */
export * from "./workspace-pool/index.ts";

/** The isolate's gateway to the Change and AgentSession DOs. */
export * from "./gateway.ts";
export * from "./projects.ts";
