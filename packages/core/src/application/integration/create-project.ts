import { Effect, Result, Schema } from "effect";
import { IdempotencyConflict } from "../../domain/identity/index.ts";
import { ProjectCreated, type TrunkOrigin } from "../../domain/integration/index.ts";
import {
  type CommandActor,
  type EntityRef,
  type Instant,
  InstantSchema,
  ProjectId,
  type RunRef,
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
  /** Who creates it, by id: the events' `by`. A person, or an agent in a namespace of its own. */
  readonly by: string;
  /** The creator as the commit's envelope names it: `user:<by>` or `agent:<by>`. */
  readonly actor: CommandActor;
  /** The run the agent creates it in, when its token named one. */
  readonly run?: RunRef | undefined;
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
 * - A template is forked, as it is.
 * - A fork's trunk is created, and the trunk's one writer takes the source
 *   trunk's whole history into it, unless main is already there. It is not
 *   forked: the code host serves a fork's whole history at several times
 *   its source's size, and a trunk is fetched whole by its mirror's first
 *   sync and by every clone. A source that is gone, or over what one relay
 *   carries, refuses the start, and the empty repo is deleted.
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
  if (source._tag === "Template") {
    const from = { namespace: repos.trunk.namespace, name: source.repo };
    if (!made)
      yield* host.fork(from, repos.trunk).pipe(Effect.catchTag("RepoAlreadyExists", alreadyMade));
    const head = yield* Effect.orDie(host.head(repos.trunk, MAIN));
    const template: TrunkOrigin = { kind: "template", name: source.repo, commit: head };
    return { head, origin: template };
  }
  if (source._tag === "Project") {
    if (!made)
      yield* host.create(repos.trunk).pipe(Effect.catchTag("RepoAlreadyExists", alreadyMade));
    const main = branchOf(yield* Effect.orDie(host.branches(repos.trunk)), MAIN);
    const head =
      main?.commit ??
      (yield* (yield* Trunks)
        .take(projectId, source.projectId)
        // Nothing was taken: the empty repo goes, so a refused fork leaves none.
        .pipe(Effect.tapError(() => host.delete(repos.trunk))));
    const forked: TrunkOrigin = { kind: "forked", project: source.projectId, commit: head };
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
 * Creates a project and answers once its trunk has its first head, each step
 * idempotent, so a retry after a crash finishes the job:
 * 1. trunk is made by the project's start (`startTrunk`) in keel-core;
 * 2. trunk is initialized at its first head, with where it came from. An
 *    imported history is admitted there: over what its namespace has left,
 *    or over what one relay carries, trunk's repo is deleted and the create
 *    is refused with nothing else made (a fork over what one relay carries
 *    was refused the same way in step 1, where its history is taken);
 * 3. ProjectCreated commits, keyed by the creator's Idempotency-Key.
 * Staging, the mirror and the pool come after, by `finishProject`: a project
 * is answered as soon as its trunk can be read and cloned. A replay of a
 * created project answers from what it committed. A start the code host
 * refuses (a missing template or project, an import it takes nothing from)
 * fails as the host said it, and leaves no repo.
 */
export const createProject: (
  command: CreateProject,
) => Effect.Effect<
  ProjectRecord,
  IdempotencyConflict | ProjectStartRefused,
  Clock | EntityStore | EventOutbox | CodeHost | Trunks
> = Effect.fn("integration/createProject")(function* (command: CreateProject) {
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
  // A retry names the same head (trunk was made once), so only a trunk moved by someone else refuses.
  yield* (yield* Trunks).initialize(projectId, head, command.by, origin).pipe(
    Effect.catchTag("PromotionStateRefused", Effect.die),
    // The history is no project's: its repo goes, so the namespace holds nothing it was refused.
    Effect.tapError(() => host.delete(repos.trunk)),
  );

  const committed: Committed<ProjectRecord> = yield* commit(
    {
      entity,
      cause: command.idempotencyKey,
      fingerprint: command.fingerprint,
      actor: command.actor,
      ...(command.run === undefined ? {} : { run: command.run }),
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

/** What a project's finish makes, in order, after it is created. */
export const FINISH_STEPS = ["staging", "mirror", "sync", "pool"] as const;
export type FinishStep = (typeof FINISH_STEPS)[number];

/** Where the Project DO keeps how far its finish has come, keyed by the project id. */
const PROJECT_FINISH = "project-finish";
const FinishRecord = Schema.Struct({
  done: Schema.Array(Schema.Literals(FINISH_STEPS)),
  /** The step that failed last, and how many times in a row. */
  failing: Schema.optionalKey(
    Schema.Struct({ step: Schema.Literals(FINISH_STEPS), times: Schema.Int }),
  ),
});
export type FinishRecord = typeof FinishRecord.Type;
const decodeFinish = Schema.decodeUnknownSync(FinishRecord);
const encodeFinish = Schema.encodeSync(FinishRecord);

/** How far the project's finish has come: no step done before it begins. */
export const finishOf = (
  store: (typeof EntityStore)["Service"],
  projectId: ProjectId,
): FinishRecord => {
  const stored = store.get(PROJECT_FINISH, projectId);
  return stored === undefined ? { done: [] } : decodeFinish(stored);
};

/** The first step the finish has still to make, or none once it is finished. */
const nextStep = (finish: FinishRecord): FinishStep | undefined =>
  FINISH_STEPS.find((step) => !finish.done.includes(step));

const putFinish = (projectId: ProjectId, change: (finish: FinishRecord) => FinishRecord) =>
  commit(
    {
      entity: { kind: "project", id: projectId },
      cause: `finish:${projectId}`,
      project: projectId,
    },
    (tx) => {
      const after = change(finishOf(tx.store, projectId));
      tx.store.put(PROJECT_FINISH, projectId, asStored(encodeFinish(after)));
      return Result.succeed({ value: after, drafts: [] });
    },
  ).pipe(
    Effect.andThen(EntityStore),
    Effect.map((store) => finishOf(store, projectId)),
  );

/** Whether ProjectDeleted was committed for the project: its finish then makes nothing. */
const deleted = (projectId: ProjectId) =>
  Effect.map(EventOutbox, (outbox) =>
    outbox.log({ kind: "project", id: projectId }).some((event) => event.type === "ProjectDeleted"),
  );

/** What `finishProject` found: it made what was left, there was no project to finish, or the project was deleted. */
export type FinishOutcome = "finished" | "absent" | "deleted";

/**
 * Makes what a project needs beyond its trunk, after ProjectCreated, each
 * step idempotent and recorded once done, so a retried pass makes only what
 * is left:
 * 1. staging is forked from trunk;
 * 2. the mirror is created empty in the workspaces namespace (a fork cannot
 *    cross namespaces);
 * 3. trunk is synced, which brings staging and the mirror to its head;
 * 4. the pool is configured last, so it never forks an empty mirror.
 * Nothing is made for a project that was never created, and nothing more
 * once it is deleted. A step's failure fails the pass, and the step stays
 * the next to make.
 */
export const finishProject = Effect.fn("integration/finishProject")(function* (
  projectId: ProjectId,
  poolTarget: number,
) {
  if ((yield* EntityStore).get(PROJECT, projectId) === undefined)
    return "absent" satisfies FinishOutcome;
  const repos = projectRepos(projectId);
  const host = yield* CodeHost;
  for (;;) {
    if (yield* deleted(projectId)) return "deleted" satisfies FinishOutcome;
    const step = nextStep(finishOf(yield* EntityStore, projectId));
    if (step === undefined) return "finished" satisfies FinishOutcome;
    if (step === "staging" && !(yield* exists(repos.staging)))
      yield* host
        .fork(repos.trunk, repos.staging)
        .pipe(Effect.catchTag("RepoAlreadyExists", alreadyMade), Effect.orDie);
    if (step === "mirror" && !(yield* exists(repos.mirror)))
      yield* host.create(repos.mirror).pipe(Effect.catchTag("RepoAlreadyExists", alreadyMade));
    if (step === "sync") yield* (yield* Trunks).sync(projectId);
    if (step === "pool")
      yield* (yield* WorkspacePool).configure(projectId, {
        source: repos.mirror,
        target: poolTarget,
      });
    yield* putFinish(projectId, (finish) => ({ done: [...finish.done, step] }));
  }
});

/** The longest a failing finish waits before it tries again. */
export const FINISH_RETRY_CAP_MS = 5 * 60_000;

/** From this many failures in a row of one step, each is a defect: a finish step should not keep failing. */
export const FINISH_DEFECT_AFTER = 5;

/** A failed pass of the finish, and when it tries again. */
export interface FinishRetry {
  readonly step: FinishStep;
  /** How many times in a row the step has failed. */
  readonly times: number;
  /** 1 s·2ⁿ⁻¹ after the n-th failure in a row, up to five minutes. */
  readonly delayMs: number;
  readonly defect: boolean;
}

/**
 * Counts one more failure of the step the finish has still to make, and
 * answers how many times in a row it has failed and when the finish tries
 * again; none once the finish is done.
 */
export const finishFailed = Effect.fn("integration/finishFailed")(function* (projectId: ProjectId) {
  const step = nextStep(finishOf(yield* EntityStore, projectId));
  if (step === undefined) return undefined;
  const after = yield* putFinish(projectId, (finish) => ({
    done: finish.done,
    failing: { step, times: finish.failing?.step === step ? finish.failing.times + 1 : 1 },
  }));
  const times = after.failing?.times ?? 1;
  return {
    step,
    times,
    delayMs: Math.min(1_000 * 2 ** (times - 1), FINISH_RETRY_CAP_MS),
    defect: times >= FINISH_DEFECT_AFTER,
  } satisfies FinishRetry;
});

/**
 * Tells the project's pool, while it has no workspace and none can be made
 * before `at` (when the finish next tries), so a grant is told to come back
 * no sooner. Once the finish has configured the pool, nothing is told.
 */
export const holdPool = Effect.fn("integration/holdPool")(function* (
  projectId: ProjectId,
  at: Instant,
) {
  if (finishOf(yield* EntityStore, projectId).done.includes("pool")) return;
  yield* (yield* WorkspacePool).configure(projectId, {
    source: projectRepos(projectId).mirror,
    target: 0,
    readyAt: at,
  });
});
