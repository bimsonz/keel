import {
  type AgentDirectory,
  type BatchVerification,
  type CandidateBundles,
  type CandidateComposer,
  type Changes,
  type Clock,
  type CodeHost,
  type EntityStore,
  type EventOutbox,
  type FanOut,
  type Ids,
  type OrgUsage,
  type ProjectOrgs,
  type Projects,
  type StagingWriter,
  type TrunkWriter,
  type Trunks,
  type WorkspaceRebaser,
  type WorkspacePool,
  type LiveChanges,
} from "@keeltown/core/ports";
import { projectRepos } from "@keeltown/core/application/integration";
import type { AgentId, ChangeId, ProjectId } from "@keeltown/core/kernel";
import { Layer, ManagedRuntime } from "effect";
import { CodeHostArtifacts } from "../adapters/driven/artifacts/code-host.ts";
import { ArtifactsObjects } from "../adapters/driven/artifacts/objects.ts";
import { AgentDirectoryD1 } from "../adapters/driven/d1/agent-directory.ts";
import { ProjectOrgsD1 } from "../adapters/driven/d1/project-orgs.ts";
import { ChangesRpc } from "../adapters/driven/do-rpc/changes.ts";
import { FanOutRpc } from "../adapters/driven/do-rpc/fan-out.ts";
import { OrgUsageRpc } from "../adapters/driven/do-rpc/org-usage.ts";
import { ProjectsRpc } from "../adapters/driven/do-rpc/projects.ts";
import { TrunksRpc } from "../adapters/driven/do-rpc/trunks.ts";
import { CandidateBundlesGitCore } from "../adapters/driven/gitcore/candidate-bundles.ts";
import { CandidateComposerGitCore } from "../adapters/driven/gitcore/candidate-composer.ts";
import { StagingWriterGitCore } from "../adapters/driven/gitcore/staging-writer.ts";
import { TrunkWriterGitCore } from "../adapters/driven/gitcore/trunk-writer.ts";
import { WorkspaceRebaserGitCore } from "../adapters/driven/gitcore/workspace-rebaser.ts";
import { BundleStoreR2 } from "../adapters/driven/r2/bundle-store.ts";
import { BatchVerificationWorkflow } from "../adapters/driven/workflow/batch-verification.ts";
import { LiveChangesRpc } from "../adapters/driven/do-rpc/live-changes.ts";
import { WorkspacePoolRpc } from "../adapters/driven/do-rpc/workspace-pool.ts";
import { EntityStoreSql, migrateEntityStore } from "../adapters/driven/do-storage/entity-store.ts";
import { EventOutboxSql, migrateEventOutbox } from "../adapters/driven/do-storage/event-outbox.ts";
import { SystemLive } from "../adapters/driven/system.ts";
import { migrateAlarms } from "../adapters/driving/do/alarm.ts";

export type DurableObjectServices = EntityStore | EventOutbox | Clock | Ids;
/** An object's runtime: the backbone's services, and `R`, the driven adapters its own use-cases need. */
export type DurableObjectRuntime<R = never> = ManagedRuntime.ManagedRuntime<
  DurableObjectServices | R,
  never
>;

/** The services every Durable Object runs on: its own storage and outbox, the system clock and ids. */
export function backbone(storage: DurableObjectStorage): Layer.Layer<DurableObjectServices> {
  return Layer.mergeAll(EntityStoreSql(storage), EventOutboxSql(storage), SystemLive);
}

/** The AgentSession DO's driven adapters beyond the backbone: it writes the directory row its events project. */
export type AgentSessionServices = AgentDirectory;

/** The Projector repeats each agent standing it hears in the AgentDirectory: the repair after the AgentSession DO's inline write. */
export type ProjectorServices = AgentDirectory;

export function projectorServices(env: Env): Layer.Layer<ProjectorServices> {
  return AgentDirectoryD1(env.DB);
}

/** The AgentSession DO writes the AgentDirectory D1 row inline, so enrolment and revocation bind the next request. */
export function agentSessionServices(env: Env): Layer.Layer<AgentSessionServices> {
  return AgentDirectoryD1(env.DB);
}

/** The Project DO's driven adapters beyond the backbone: it bootstraps a project's repos, trunk and pool. */
export type ProjectServices = CodeHost | Trunks | WorkspacePool;

/** How many ready workspaces a new project's pool keeps forked, until `vars.POOL_TARGET` is declared. */
export const DEFAULT_POOL_TARGET = 2;

/**
 * The Project DO forks and creates repos through the code host, initializes
 * and syncs trunk through the Trunk DO, and configures the project's pool.
 */
export function projectServices(env: Env): Layer.Layer<ProjectServices> {
  return Layer.mergeAll(
    codeHostLayer(env),
    TrunksRpc(env.TRUNK, artifactsLocationHint(env)),
    WorkspacePoolRpc(env.WORKSPACE_POOL, artifactsLocationHint(env)),
  );
}

/** The Change DO's driven adapters beyond the backbone. */
export type ChangeServices = WorkspacePool | CodeHost | Trunks | WorkspaceRebaser | LiveChanges;

/**
 * The Change DO takes its workspace from its project's WorkspacePool DO and
 * asks the code host whether a submitted commit is in it. A rebase reads
 * trunk's head from the Trunk DO and relays trunk into the workspace's
 * keel/trunk; it never holds a trunk write token.
 */
export function changeServices(env: Env): Layer.Layer<ChangeServices> {
  const host = codeHostLayer(env);
  return Layer.mergeAll(
    WorkspacePoolRpc(env.WORKSPACE_POOL, artifactsLocationHint(env)),
    host,
    TrunksRpc(env.TRUNK, artifactsLocationHint(env)),
    WorkspaceRebaserGitCore().pipe(Layer.provide(host)),
    liveChangesLayer(env),
  );
}

/** The Trunk DO's driven adapters beyond the backbone: the one writer of its project's trunk, and what counts each landing against the project's org. */
export type TrunkServices = TrunkWriter | CodeHost | OrgUsage | ProjectOrgs;

/**
 * The Trunk DO writes and syncs its project's trunk through GitCore over the
 * code host, and reads each candidate it promotes from staging. It finds its
 * project's org in D1's `projects` table and counts what it lands into that
 * org's usage object. `projectId` is read lazily, on first use, from the
 * object's name.
 */
export function trunkServices(env: Env, projectId: () => ProjectId): Layer.Layer<TrunkServices> {
  return Layer.suspend(() => {
    const host = codeHostLayer(env);
    return Layer.mergeAll(
      host,
      TrunkWriterGitCore(projectRepos(projectId())).pipe(Layer.provide(host)),
      OrgUsageRpc(env.ORG_USAGE),
      ProjectOrgsD1(env.DB),
    );
  });
}

/** The Lane DO's driven adapters beyond the backbone: it composes, bundles and verifies its batches. */
export type LaneServices =
  | CodeHost
  | Changes
  | CandidateComposer
  | CandidateBundles
  | BatchVerification
  | StagingWriter
  | Projects;

/**
 * The Lane DO reads its members from their Change DOs and its project's
 * settings from the Project DO (verification may be off), composes and bundles
 * candidates through GitCore over the Artifacts bindings (one handle per repo
 * per compose), stores bundles in R2, starts KeelVerify, and moves staging's
 * main after trunk. It never holds a trunk write token. `projectId` is read
 * lazily, on first use, from the object's name.
 */
export function laneServices(env: Env, projectId: () => ProjectId): Layer.Layer<LaneServices> {
  return Layer.suspend(() => {
    const repos = projectRepos(projectId());
    const host = codeHostLayer(env);
    const objects = artifactsObjects(env);
    const change = (changeId: ChangeId) =>
      env.CHANGE.get(env.CHANGE.idFromName(`change:${changeId}`));
    const agentSession = (agentId: AgentId) =>
      env.AGENT_SESSION.get(env.AGENT_SESSION.idFromName(`agent:${agentId}`));
    const project = (id: ProjectId) => env.PROJECT.get(env.PROJECT.idFromName(`project:${id}`));
    return Layer.mergeAll(
      host,
      ChangesRpc({ change, agentSession }),
      ProjectsRpc(project),
      CandidateComposerGitCore(objects).pipe(Layer.provide(host)),
      CandidateBundlesGitCore(objects).pipe(Layer.provide(BundleStoreR2(env.BUNDLES))),
      BatchVerificationWorkflow(env.CI_WORKFLOW),
      StagingWriterGitCore({ trunk: repos.trunk, staging: repos.staging }).pipe(
        Layer.provide(host),
      ),
    );
  });
}

const LOCATION_HINTS: readonly DurableObjectLocationHint[] = [
  "wnam",
  "enam",
  "sam",
  "weur",
  "eeur",
  "apac",
  "oc",
  "afr",
  "me",
];

/**
 * Where the deployment's Artifacts namespaces live (`vars.ARTIFACTS_LOCATION_HINT`,
 * `wnam` on staging): repo-touching objects are placed there. Empty means no
 * hint; any other value is a misconfiguration and fails loudly.
 */
export function artifactsLocationHint(env: Env): DurableObjectLocationHint | undefined {
  const value = env.ARTIFACTS_LOCATION_HINT;
  if (value === "") return undefined;
  const hint = LOCATION_HINTS.find((h) => h === value);
  if (hint === undefined)
    throw new Error(`ARTIFACTS_LOCATION_HINT is ${JSON.stringify(value)}, not a location hint`);
  return hint;
}

export interface DurableObjectComposition<R = never> {
  readonly runtime: DurableObjectRuntime<R>;
  /** How this object's committed events reach their subscribers. */
  readonly fanOut: FanOut;
}

/**
 * A Durable Object's composition root, called once from its constructor.
 * Migrations run inside `blockConcurrencyWhile`, so no request sees a half-built
 * schema; the runtime lives as long as the instance.
 */
export function durableObjectRuntime<R>(
  ctx: DurableObjectState,
  env: Env,
  driven: Layer.Layer<R>,
): DurableObjectComposition<R> {
  void ctx.blockConcurrencyWhile(async () => {
    migrateEntityStore(ctx.storage);
    migrateEventOutbox(ctx.storage);
    migrateAlarms(ctx.storage);
  });
  return {
    runtime: ManagedRuntime.make(Layer.mergeAll(backbone(ctx.storage), driven)),
    fanOut: FanOutRpc(env),
  };
}

/**
 * CodeHost over the Worker's Artifacts bindings, keyed by the namespace each is
 * bound to in wrangler.jsonc: `keel-core` (trunk, staging, guards) and
 * `keel-ws-00` (workspaces and their mirror).
 */
/** Each project's live-change index, kept by its Project DO: what a change's preflight reads. */
export function liveChangesLayer(env: Env): Layer.Layer<LiveChanges> {
  return LiveChangesRpc((projectId) =>
    env.PROJECT.get(env.PROJECT.idFromName(`project:${projectId}`)),
  );
}

export function codeHostLayer(env: Env): Layer.Layer<CodeHost> {
  return CodeHostArtifacts({ "keel-core": env.ARTIFACTS, "keel-ws-00": workspaces(env) });
}

declare global {
  interface Env {
    /**
     * Test-only: a fake Artifacts namespace the pool tests bind, because
     * Artifacts has no local simulator and miniflare will not rebind
     * WORKSPACES. No deployed Worker declares it.
     */
    readonly TEST_ARTIFACTS?: Artifacts;
  }
}

/** The workspaces namespace: TEST_ARTIFACTS where a test binds it, WORKSPACES everywhere else. */
const workspaces = (env: Env): Artifacts => env.TEST_ARTIFACTS ?? env.WORKSPACES;

/** gitcore's object reads over the Artifacts bindings: the core namespace and the workspaces. */
export const artifactsObjects = (env: Env) =>
  ArtifactsObjects({ "keel-core": env.ARTIFACTS, "keel-ws-00": workspaces(env) });
