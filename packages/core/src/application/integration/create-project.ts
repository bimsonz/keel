import { Effect, Result, Schema } from "effect";
import { IdempotencyConflict } from "../../domain/identity/index.ts";
import { ProjectCreated, type TrunkOrigin } from "../../domain/integration/index.ts";
import {
  type EntityRef,
  InstantSchema,
  ProjectId,
  userActor,
  type UserId,
} from "../../domain/kernel/index.ts";
import {
  type Clock,
  CodeHost,
  commit,
  type Committed,
  EntityStore,
  type EventDraft,
  EventOutbox,
  type Imported,
  type ProjectSource,
  type ProjectStartRefused,
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

/** A new project, and where its trunk starts. */
export interface CreateProject {
  readonly projectId: ProjectId;
  readonly name: string;
  readonly source: ProjectSource;
  /** The person who creates it: the events' `by`, and the commit's actor `user:<by>`. */
  readonly by: UserId;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
}

/** Where the Project DO keeps the time its bootstrap first began, keyed by the project id. */
const PROJECT_START = "project-start";
const ProjectStart = Schema.Struct({ at: InstantSchema });
const decodeStart = Schema.decodeUnknownSync(ProjectStart);
const MAIN = "refs/heads/main";

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

/** A repo made by a concurrent bootstrap between the existence check and the call is already done. */
const alreadyMade = () => Effect.void;

/**
 * The time the project's bootstrap first began, recorded before anything is
 * made and answered the same from then on: an empty project's first commit
 * is made of it, so every retry writes the same commit. The write carries no
 * event, so it is told from a retry by what it finds.
 */
const startedAt = (projectId: ProjectId, entity: EntityRef) =>
  commit({ entity, cause: `start:${projectId}`, project: projectId }, (tx) => {
    if (tx.store.get(PROJECT_START, projectId) === undefined)
      tx.store.put(PROJECT_START, projectId, { at: tx.at });
    return Result.succeed({ value: undefined, drafts: [] });
  }).pipe(
    Effect.andThen(EntityStore),
    Effect.map((store) => decodeStart(store.get(PROJECT_START, projectId)).at),
  );

/** The branch a repo holds under `ref`, as the repo itself advertises it. */
const branchOf = (branches: readonly Imported[], ref: string) =>
  branches.find((branch) => branch.ref === ref);

/**
 * Makes trunk by the project's start, and answers its first head with where
 * it came from. Every start is idempotent: a trunk that exists is not made
 * again, and what it holds says whether its first write is still due.
 * - A template and a fork are forked, as they are.
 * - An empty project's repo is created, and the trunk's one writer seeds
 *   Keel's first commit, unless main is already there.
 * - An import takes the upstream's one branch under its own name. When that
 *   is not main the trunk's writer makes main at its head, unless main is
 *   already there. On a retry the repo says which branch came: the one that
 *   is not main, or main alone.
 */
const startTrunk = Effect.fn("integration/startTrunk")(function* (
  command: CreateProject,
  entity: EntityRef,
) {
  const { projectId, source } = command;
  const repos = projectRepos(projectId);
  const host = yield* CodeHost;
  const made = yield* exists(repos.trunk);
  if (source._tag === "Template" || source._tag === "Project") {
    const from =
      source._tag === "Template"
        ? { namespace: repos.trunk.namespace, name: source.repo }
        : projectRepos(source.projectId).trunk;
    if (!made)
      yield* host.fork(from, repos.trunk).pipe(Effect.catchTag("RepoAlreadyExists", alreadyMade));
    const head = yield* Effect.orDie(host.head(repos.trunk, MAIN));
    const forked: TrunkOrigin =
      source._tag === "Template"
        ? { kind: "template", name: source.repo, commit: head }
        : { kind: "forked", project: source.projectId, commit: head };
    return { head, origin: forked };
  }
  if (source._tag === "Empty") {
    if (!made)
      yield* host.create(repos.trunk).pipe(Effect.catchTag("RepoAlreadyExists", alreadyMade));
    const main = branchOf(yield* Effect.orDie(host.branches(repos.trunk)), MAIN);
    const head =
      main?.commit ??
      (yield* (yield* Trunks).seed(projectId, command.name, yield* startedAt(projectId, entity)));
    const empty: TrunkOrigin = { kind: "empty" };
    return { head, origin: empty };
  }
  if (!made)
    yield* host
      .import({ url: source.url, ref: source.ref }, repos.trunk)
      .pipe(Effect.catchTag("RepoAlreadyExists", alreadyMade));
  const branches = yield* Effect.orDie(host.branches(repos.trunk));
  const main = branchOf(branches, MAIN);
  // The branch that came: the one that is not main, or main alone.
  const came = branches.find((branch) => branch.ref !== MAIN) ?? main;
  if (came === undefined)
    return yield* Effect.die(new Error(`project ${projectId}: its imported trunk holds no branch`));
  if (main === undefined) yield* (yield* Trunks).adopt(projectId, came.commit);
  const imported: TrunkOrigin = {
    kind: "imported",
    url: source.url,
    ref: came.ref,
    commit: came.commit,
  };
  return { head: came.commit, origin: imported };
});

/**
 * Bootstraps a project, each step idempotent, so a retry after a crash
 * finishes the job:
 * 1. trunk is made by the project's start (`startTrunk`) in keel-core;
 * 2. trunk is initialized at its first head, with where it came from. An
 *    imported history is admitted there: over what its namespace has left,
 *    or over what one relay carries, trunk's repo is deleted and the create
 *    is refused with nothing else made;
 * 3. staging is forked from trunk, and the mirror is created empty in the
 *    workspaces namespace (a fork cannot cross namespaces);
 * 4. trunk is synced, which brings staging and the mirror to its head;
 * 5. the pool is configured last, so it never forks an empty mirror;
 * 6. ProjectCreated commits, keyed by the creator's Idempotency-Key.
 * A replay of a finished bootstrap answers from what it committed. A start
 * the code host refuses (a missing template or project, an import it takes
 * nothing from) fails as the host said it, and leaves no repo.
 */
export const createProject: (
  command: CreateProject,
  poolTarget: number,
) => Effect.Effect<
  ProjectRecord,
  IdempotencyConflict | ProjectStartRefused,
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
  const { head, origin } = yield* startTrunk(command, entity);
  const trunks = yield* Trunks;
  // A retry names the same head (trunk was made once), so only a trunk moved by someone else refuses.
  yield* trunks.initialize(projectId, head, command.by, origin).pipe(
    Effect.catchTag("PromotionStateRefused", Effect.die),
    // The history is no project's: its repo goes, so the namespace holds nothing it was refused.
    Effect.tapError(() => host.delete(repos.trunk)),
  );
  if (!(yield* exists(repos.staging)))
    yield* host
      .fork(repos.trunk, repos.staging)
      .pipe(Effect.catchTag("RepoAlreadyExists", alreadyMade), Effect.orDie);
  if (!(yield* exists(repos.mirror)))
    yield* host.create(repos.mirror).pipe(Effect.catchTag("RepoAlreadyExists", alreadyMade));
  yield* trunks.sync(projectId);
  yield* (yield* WorkspacePool).configure(projectId, { source: repos.mirror, target: poolTarget });

  const committed: Committed<ProjectRecord> = yield* commit(
    {
      entity,
      cause: command.idempotencyKey,
      fingerprint: command.fingerprint,
      actor: userActor(command.by),
      project: projectId,
    },
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
