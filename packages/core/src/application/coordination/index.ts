import type { Effect } from "effect";
import type {
  Change,
  ChangeNotFound,
  ChangeStateRefused,
  FootprintEntry,
  LeaseStale,
  PoolExhausted,
  Preflight,
  Proposition,
} from "../../domain/coordination/index.ts";
import type { Principal } from "../../domain/identity/index.ts";
import type { ChangeId, CommitSha, Instant, LeaseId, SketchId } from "../../domain/kernel/index.ts";
import { stub } from "../not-implemented.ts";
import type {
  Clock,
  EntityStore,
  EventOutbox,
  Ids,
  SubjectRegistry,
  WorkspacePool,
  WorkspaceGrant,
} from "../ports/index.ts";

/**
 * coordination use-cases. The isolate reaches a change through the `Changes`
 * port with the inputs below; the Change DO runs the use-cases in `change.ts`.
 */

export interface DeclareInput {
  readonly goal: string;
  readonly footprint: readonly FootprintEntry[];
  readonly premises: readonly Proposition[];
  readonly declaredEffects?: readonly Proposition[];
  readonly fromSketch?: SketchId;
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

export interface SubmitInput extends LeasedCall {
  readonly commitSha: CommitSha;
}

export interface Revised {
  readonly change: Change;
  readonly preflight: Preflight;
}

export interface SketchOpened {
  readonly sketchId: SketchId;
  readonly workspace: WorkspaceGrant;
  readonly expiresAt: Instant;
}

type ChangePorts = Clock | EntityStore | EventOutbox;

export const rely: (
  principal: Principal,
  input: LeasedCall & { readonly premise: Proposition },
) => Effect.Effect<
  Revised,
  ChangeNotFound | LeaseStale | ChangeStateRefused,
  ChangePorts | SubjectRegistry
> = stub("coordination/rely");

export const nearby: (
  principal: Principal,
  changeId: ChangeId,
) => Effect.Effect<Preflight, ChangeNotFound, EntityStore | SubjectRegistry> =
  stub("coordination/nearby");

export const openSketch: (
  principal: Principal,
  purpose: string | undefined,
) => Effect.Effect<SketchOpened, PoolExhausted, Clock | Ids | WorkspacePool> =
  stub("coordination/openSketch");

/** The Change DO's use-cases. */
export * from "./change.ts";

/** The WorkspacePool use-cases. */
export * from "./workspace-pool/index.ts";

/** The isolate's gateway to the Change and AgentSession DOs. */
export * from "./gateway.ts";
export * from "./projects.ts";
