import { Effect, Result, Schema } from "effect";
import { IdempotencyConflict } from "../../domain/identity/index.ts";
import { ProjectCreated } from "../../domain/integration/index.ts";
import {
  type AgentId,
  type EntityRef,
  InstantSchema,
  ProjectId,
} from "../../domain/kernel/index.ts";
import {
  type Clock,
  CodeHost,
  commit,
  type Committed,
  EntityStore,
  type EventDraft,
  EventOutbox,
  type RepoNotFound,
  type RepoRef,
  type Stored,
  Trunks,
  WorkspacePool,
} from "../ports/index.ts";
import { projectRepos } from "./project-repos.ts";

/** Where the Project DO keeps its project, keyed by the project id. */
export const PROJECT = "project";

export const ProjectRecord = Schema.Struct({
  id: ProjectId,
  name: Schema.NonEmptyString,
  createdAt: InstantSchema,
});
export type ProjectRecord = typeof ProjectRecord.Type;

/** An operator's new project: trunk is forked from `source`, a repo in the core namespace. */
export interface CreateProject {
  readonly projectId: ProjectId;
  readonly name: string;
  readonly source: string;
  readonly by: AgentId;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
}

const decodeRecord = Schema.decodeUnknownSync(ProjectRecord);
const encodeRecord = Schema.encodeSync(ProjectRecord);
const encodeCreated = Schema.encodeSync(ProjectCreated);
const asStored = (encoded: unknown): Stored => JSON.parse(JSON.stringify(encoded));
const payloadOf = (encoded: unknown): EventDraft["payload"] => JSON.parse(JSON.stringify(encoded));

/** Whether a repo exists: a step whose target already does is done, so a retry skips it. */
const exists = (repo: RepoRef) =>
  Effect.flatMap(CodeHost, (host) =>
    host.info(repo).pipe(
      Effect.as(true),
      Effect.catchTag("RepoNotFound", () => Effect.succeed(false)),
    ),
  );

/** A replay of the key: the project its bootstrap committed, or IdempotencyConflict for another body. */
const replayed = (
  projectId: ProjectId,
  idempotencyKey: string,
  sameCommand: boolean,
): Effect.Effect<ProjectRecord, IdempotencyConflict, EntityStore> =>
  sameCommand
    ? Effect.map(EntityStore, (store) => decodeRecord(store.get(PROJECT, projectId)))
    : Effect.fail(new IdempotencyConflict({ idempotencyKey }));

/**
 * Bootstraps a project, each step idempotent, so a retry after a crash
 * finishes the job:
 * 1. trunk is forked from the source, then staging from trunk (keel-core);
 * 2. the mirror is created empty in the workspaces namespace (a fork cannot
 *    cross namespaces);
 * 3. trunk is initialized at its head, then synced, which brings staging and
 *    the mirror to that head;
 * 4. the pool is configured last, so it never forks an empty mirror;
 * 5. ProjectCreated commits, keyed by the operator's Idempotency-Key.
 * A replay of a finished bootstrap answers from what it committed. A missing
 * source is the code host's RepoNotFound, as it is.
 */
export const createProject: (
  command: CreateProject,
  poolTarget: number,
) => Effect.Effect<
  ProjectRecord,
  IdempotencyConflict | RepoNotFound,
  Clock | EntityStore | EventOutbox | CodeHost | Trunks | WorkspacePool
> = Effect.fn("integration/createProject")(function* (command: CreateProject, poolTarget: number) {
  const { projectId } = command;
  const entity: EntityRef = { kind: "project", id: projectId };
  const prior = (yield* EventOutbox).committed(entity, command.idempotencyKey);
  if (prior !== undefined)
    return yield* replayed(
      projectId,
      command.idempotencyKey,
      prior.fingerprint === command.fingerprint,
    );

  const repos = projectRepos(projectId);
  const host = yield* CodeHost;
  // A repo made by a concurrent bootstrap between the check and the call is already done.
  const alreadyMade = () => Effect.void;
  if (!(yield* exists(repos.trunk)))
    yield* host
      .fork({ namespace: repos.trunk.namespace, name: command.source }, repos.trunk)
      .pipe(Effect.catchTag("RepoAlreadyExists", alreadyMade));
  if (!(yield* exists(repos.staging)))
    yield* host
      .fork(repos.trunk, repos.staging)
      .pipe(Effect.catchTag("RepoAlreadyExists", alreadyMade), Effect.orDie);
  if (!(yield* exists(repos.mirror)))
    yield* host.create(repos.mirror).pipe(Effect.catchTag("RepoAlreadyExists", alreadyMade));

  const { defaultBranch } = yield* Effect.orDie(host.info(repos.trunk));
  const head = yield* Effect.orDie(host.head(repos.trunk, `refs/heads/${defaultBranch}`));
  const trunks = yield* Trunks;
  // A retry names the same head (trunk was forked once), so only a trunk moved by someone else refuses.
  yield* Effect.orDie(trunks.initialize(projectId, head, command.by));
  yield* trunks.sync(projectId);
  yield* (yield* WorkspacePool).configure(projectId, { source: repos.mirror, target: poolTarget });

  const committed: Committed<ProjectRecord> = yield* commit(
    { entity, cause: command.idempotencyKey, fingerprint: command.fingerprint },
    (tx) => {
      const record: ProjectRecord = { id: projectId, name: command.name, createdAt: tx.at };
      tx.store.put(PROJECT, projectId, asStored(encodeRecord(record)));
      const created = ProjectCreated.make({ projectId, name: command.name, by: command.by });
      return Result.succeed({
        value: record,
        drafts: [{ payload: payloadOf(encodeCreated(created)) }],
      });
    },
  );
  return committed.duplicate
    ? yield* replayed(projectId, command.idempotencyKey, committed.sameCommand)
    : committed.value;
});
