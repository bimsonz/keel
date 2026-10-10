import type { Effect } from "effect";
import type {
  Change,
  ChangeNotFound,
  ChangeStateRefused,
  CommitNotInWorkspace,
  FootprintEntry,
  LeaseStale,
  PoolExhausted,
  Preflight,
  Proposition,
  RevisionMismatch,
  SketchNotFound,
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

/** coordination use-cases. Signatures are fixed here. */

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

type DeclarePorts = Clock | Ids | EntityStore | EventOutbox | SubjectRegistry | WorkspacePool;
type ChangePorts = Clock | EntityStore | EventOutbox;

export const declare: (
  principal: Principal,
  input: DeclareInput,
) => Effect.Effect<Declared, PoolExhausted | SketchNotFound, DeclarePorts> =
  stub("coordination/declare");

export const revise: (
  principal: Principal,
  input: ReviseInput,
) => Effect.Effect<
  Revised,
  ChangeNotFound | LeaseStale | RevisionMismatch | ChangeStateRefused,
  ChangePorts | SubjectRegistry
> = stub("coordination/revise");

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

export const abandon: (
  principal: Principal,
  input: LeasedCall & { readonly reason?: string },
) => Effect.Effect<Change, ChangeNotFound | LeaseStale | ChangeStateRefused, ChangePorts> =
  stub("coordination/abandon");

export const adopt: (
  principal: Principal,
  changeId: ChangeId,
) => Effect.Effect<Change, ChangeNotFound | ChangeStateRefused, ChangePorts | Ids> =
  stub("coordination/adopt");

export const submit: (
  principal: Principal,
  input: SubmitInput,
) => Effect.Effect<
  Change,
  ChangeNotFound | LeaseStale | ChangeStateRefused | CommitNotInWorkspace,
  ChangePorts
> = stub("coordination/submit");

export const getChange: (
  principal: Principal,
  changeId: ChangeId,
) => Effect.Effect<Change, ChangeNotFound, EntityStore> = stub("coordination/getChange");

export const openSketch: (
  principal: Principal,
  purpose: string | undefined,
) => Effect.Effect<SketchOpened, PoolExhausted, Clock | Ids | WorkspacePool> =
  stub("coordination/openSketch");

/** The WorkspacePool use-cases. */
export * from "./workspace-pool/index.ts";
