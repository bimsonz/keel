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
  type HumanGate,
  type Ids,
  type NamespaceUsage,
  type NamespaceAgents,
  type Namespaces,
  type SponsorRequests,
  type ProjectAgents,
  type PlanStore,
  type QuestionRaisers,
  ProjectNamespaces,
  type Projects,
  type StagingWriter,
  type TrunkWriter,
  type Trunks,
  type WorkspaceRebaser,
  type WorkspaceWriter,
  type WorkspaceRefresher,
  type WorkspacePool,
  type LiveChanges,
  type Decisions,
  PROJECTOR,
} from "@keeltown/core/ports";
import { projectRepos } from "@keeltown/core/application/integration";
import type { AgentId, ChangeId, ProjectId } from "@keeltown/core/kernel";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import { CodeHostArtifacts, type CodeHostOptions } from "../adapters/driven/artifacts/code-host.ts";
import { ArtifactsObjects } from "../adapters/driven/artifacts/objects.ts";
import { AgentDirectoryD1 } from "../adapters/driven/d1/agent-directory.ts";
import { NamespaceAgentsD1 } from "../adapters/driven/d1/namespace-agents.ts";
import { ProjectAgentsD1 } from "../adapters/driven/d1/project-agents.ts";
import { NamespacesD1 } from "../adapters/driven/d1/namespaces.ts";
import { ProjectNamespacesD1 } from "../adapters/driven/d1/project-namespaces.ts";
import { SponsorRequestsD1 } from "../adapters/driven/d1/sponsor-requests.ts";
import { ChangesRpc } from "../adapters/driven/do-rpc/changes.ts";
import { boxComposerRpc } from "../adapters/driven/do-rpc/mergebox.ts";
import { FanOutRpc } from "../adapters/driven/do-rpc/fan-out.ts";
import { NamespaceUsageRpc } from "../adapters/driven/do-rpc/namespace-usage.ts";
import { ProjectsRpc } from "../adapters/driven/do-rpc/projects.ts";
import { TrunksRpc } from "../adapters/driven/do-rpc/trunks.ts";
import { CandidateBundlesGitCore } from "../adapters/driven/gitcore/candidate-bundles.ts";
import { CandidateComposerTiered } from "../adapters/driven/gitcore/candidate-composer.ts";
import type { CommitSigningConfig } from "../adapters/driven/gitcore/commit-signing.ts";
import { StagingWriterGitCore } from "../adapters/driven/gitcore/staging-writer.ts";
import { TrunkWriterGitCore } from "../adapters/driven/gitcore/trunk-writer.ts";
import { WorkspaceRebaserGitCore } from "../adapters/driven/gitcore/workspace-rebaser.ts";
import { WorkspaceWriterGitCore } from "../adapters/driven/gitcore/workspace-writer.ts";
import { WorkspaceRefresherGitCore } from "../adapters/driven/gitcore/workspace-refresher.ts";
import { BundleStoreR2 } from "../adapters/driven/r2/bundle-store.ts";
import { PlanStoreR2 } from "../adapters/driven/r2/plan-store.ts";
import { BatchVerificationWorkflow } from "../adapters/driven/workflow/batch-verification.ts";
import { TIER2_GATE } from "../adapters/driving/do/boxgate-leases.ts";
import { HumanGateRpc } from "../adapters/driven/do-rpc/human-gate.ts";
import { LiveChangesRpc } from "../adapters/driven/do-rpc/live-changes.ts";
import { QuestionRaisersRpc } from "../adapters/driven/do-rpc/question-raisers.ts";
import { DecisionsRpc } from "../adapters/driven/do-rpc/decisions.ts";
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

/** The AgentSession DO's driven adapters beyond the backbone: it writes the directory row its events project, holds the handle of an agent that signs itself up, and writes the rows of its sponsor requests to people. */
export type AgentSessionServices = AgentDirectory | Namespaces | SponsorRequests;

/**
 * The Projector repeats each agent standing it hears in the AgentDirectory,
 * each project's visibility in its place, and each invitation's move in the
 * namespace's agents: the repair after the AgentSession DO's, the Project
 * DO's and the namespace object's inline writes.
 */
export type ProjectorServices =
  | AgentDirectory
  | ProjectNamespaces
  | NamespaceAgents
  | ProjectAgents;

export function projectorServices(env: Env): Layer.Layer<ProjectorServices> {
  return Layer.mergeAll(
    AgentDirectoryD1(env.DB),
    ProjectNamespacesD1(env.DB),
    NamespaceAgentsD1(env.DB),
    ProjectAgentsD1(env.DB),
  );
}

/**
 * The namespace object's driven adapters beyond the backbone: the rows of its
 * agents that the request gate reads, the rows of the agents invited to one
 * of its projects, which it reads for who is asked first, and the subjects
 * that raised its questions, which it asks to check them again.
 */
export type NamespaceServices = NamespaceAgents | ProjectAgents | QuestionRaisers;

/** The namespace object writes its agents' D1 rows inline, so an acceptance or a removal binds the agent's next request. */
export function namespaceServices(env: Env): Layer.Layer<NamespaceServices> {
  return Layer.mergeAll(
    NamespaceAgentsD1(env.DB),
    ProjectAgentsD1(env.DB),
    QuestionRaisersRpc((address) => env.SUBJECT.get(env.SUBJECT.idFromName(address))),
  );
}

/** The AgentSession DO writes the AgentDirectory D1 row inline, so enrolment and revocation bind the next request. */
export function agentSessionServices(env: Env): Layer.Layer<AgentSessionServices> {
  return Layer.mergeAll(AgentDirectoryD1(env.DB), NamespacesD1(env.DB), SponsorRequestsD1(env.DB));
}

/** The Subject DO's driven adapters beyond the backbone: what it needs to put a conflict to a person. */
export type SubjectServices = HumanGate | AgentDirectory | ProjectNamespaces;

/**
 * The Subject DO raises an escalation on the object of the namespace its
 * project belongs to, which it finds in D1's `projects` table; when Keel
 * escalates on its own, it reads who vouches for the premise holder's agent
 * from the directory.
 */
export function subjectServices(env: Env): Layer.Layer<SubjectServices> {
  return Layer.mergeAll(
    HumanGateRpc((address) => env.NAMESPACE.get(env.NAMESPACE.idFromName(address))),
    AgentDirectoryD1(env.DB),
    ProjectNamespacesD1(env.DB),
  );
}

/** The Project DO's driven adapters beyond the backbone: it bootstraps a project's repos, trunk and pool. */
export type ProjectServices = CodeHost | Trunks | WorkspacePool | ProjectNamespaces | ProjectAgents;

/** How many ready workspaces a project's pool keeps forked when the Worker's `POOL_TARGET` names none. */
export const DEFAULT_POOL_TARGET = 2;

/**
 * How many ready workspaces a project's pool keeps forked: the Worker's
 * `POOL_TARGET`, or DEFAULT_POOL_TARGET when it is unset or not a positive
 * whole number. A new project's pool is created with it, and every pool tops up
 * to it when its own stored target is lower.
 */
export const poolTargetOf = (declared: string | undefined): number => {
  const target = Number(declared);
  return Number.isInteger(target) && target > 0 ? target : DEFAULT_POOL_TARGET;
};

/**
 * The Project DO forks and creates repos through the code host, initializes
 * and syncs trunk through the Trunk DO, and configures the project's pool. It
 * writes its visibility to its place's D1 row inline, so the next list of
 * projects is narrowed by it, and the rows of the agents invited to it, so an
 * acceptance or a removal binds the agent's next request.
 */
export function projectServices(env: Env): Layer.Layer<ProjectServices> {
  return Layer.mergeAll(
    codeHostLayer(env),
    TrunksRpc(env.TRUNK, artifactsLocationHint(env)),
    WorkspacePoolRpc(env.WORKSPACE_POOL, artifactsLocationHint(env)),
    ProjectNamespacesD1(env.DB),
    ProjectAgentsD1(env.DB),
  );
}

/** The Change DO's driven adapters beyond the backbone. */
export type ChangeServices =
  | WorkspacePool
  | CodeHost
  | Trunks
  | WorkspaceRebaser
  | WorkspaceWriter
  | LiveChanges
  | Decisions;

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
    WorkspaceWriterGitCore(artifactsObjects(env), env.KEEL_HOST).pipe(Layer.provide(host)),
    liveChangesLayer(env),
    decisionsLayer(env),
  );
}

/** The WorkspacePool DO's driven adapters beyond the backbone. */
export type PoolServices = CodeHost | Trunks | WorkspaceRefresher;

/**
 * The WorkspacePool DO forks, reads and deletes workspaces through the code
 * host. To keep its ready workspaces on trunk it asks the Trunk DO for
 * trunk's head and relays trunk into a workspace nobody holds yet: it reads
 * trunk, and never holds a trunk write token.
 */
export function poolServices(env: Env): Layer.Layer<PoolServices> {
  const host = codeHostLayer(env);
  return Layer.mergeAll(
    host,
    TrunksRpc(env.TRUNK, artifactsLocationHint(env)),
    WorkspaceRefresherGitCore().pipe(Layer.provide(host)),
  );
}

/** The Trunk DO's driven adapters beyond the backbone: the one writer of its project's trunk, and what counts each landing against the project's namespace. */
export type TrunkServices = TrunkWriter | CodeHost | NamespaceUsage | ProjectNamespaces;

/**
 * The Trunk DO writes and syncs its project's trunk through GitCore over the
 * code host, and reads each candidate it promotes from staging. It finds its
 * project's namespace in D1's `projects` table and counts what it lands into that
 * namespace's usage object. `projectId` is read lazily, on first use, from the
 * object's name.
 */
export function trunkServices(env: Env, projectId: () => ProjectId): Layer.Layer<TrunkServices> {
  return Layer.suspend(() => {
    const host = codeHostLayer(env);
    return Layer.mergeAll(
      host,
      TrunkWriterGitCore(projectRepos(projectId()), commitSigning(env)).pipe(Layer.provide(host)),
      NamespaceUsageRpc(env.NAMESPACE_USAGE),
      ProjectNamespacesD1(env.DB),
    );
  });
}

/** BoxGate reads its namespace's `concurrent-containers` and halt from the namespace's usage object. */
export type BoxGateServices = NamespaceUsage;

export function boxGateServices(env: Env): Layer.Layer<BoxGateServices> {
  return NamespaceUsageRpc(env.NAMESPACE_USAGE);
}

/** The Lane DO's driven adapters beyond the backbone: it composes, bundles and verifies its batches. */
export type LaneServices =
  | CodeHost
  | Changes
  | AgentDirectory
  | CandidateComposer
  | CandidateBundles
  | BatchVerification
  | StagingWriter
  | Projects
  | ProjectNamespaces
  | PlanStore;

/**
 * The Lane DO reads its members from their Change DOs and its project's
 * settings from the Project DO (verification may be off), reads each queued
 * change's plan and stores a batch's union of them in R2, composes and bundles
 * candidates through GitCore over the Artifacts bindings (one handle per repo
 * per compose), names each member's agent by the handle D1's directory holds, stores bundles in R2 for the namespace D1's `projects` table
 * places its project in, starts KeelVerify, and moves staging's
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
    const places = ProjectNamespacesD1(env.DB);
    const box = boxComposerRpc(projectId, {
      namespaceOf: (id) =>
        ProjectNamespaces.use((namespaces) => namespaces.byId(id)).pipe(
          Effect.map(Option.map((place) => place.namespace)),
          Effect.provide(places),
        ),
      gate: (namespace) => env.BOXGATE.get(env.BOXGATE.idFromName(`boxgate:${namespace}`)),
      box: (id) => env.MERGEBOX.get(env.MERGEBOX.idFromName(`mergebox:${id}`)),
    });
    return Layer.mergeAll(
      host,
      ChangesRpc({ change, agentSession }),
      ProjectsRpc(project),
      places,
      AgentDirectoryD1(env.DB),
      CandidateComposerTiered(objects, commitSigning(env), box).pipe(Layer.provide(host)),
      CandidateBundlesGitCore(objects).pipe(Layer.provide(BundleStoreR2(env.BUNDLES))),
      BatchVerificationWorkflow(env.CI_WORKFLOW, {
        free: () => env.BOXGATE.get(env.BOXGATE.idFromName(TIER2_GATE)).free(),
      }),
      StagingWriterGitCore({ trunk: repos.trunk, staging: repos.staging }).pipe(
        Layer.provide(host),
      ),
      PlanStoreR2(env.ARCHIVE),
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

/** What this deployment says of the commits Keel composes: its host, its commit-signing key and the signers it publishes. */
export const commitSigning = (
  env: Pick<Env, "KEEL_HOST" | "KEEL_COMMIT_SIGNING_KEY" | "KEEL_COMMIT_SIGNERS">,
): CommitSigningConfig => ({
  host: env.KEEL_HOST,
  signingKey: env.KEEL_COMMIT_SIGNING_KEY,
  signers: env.KEEL_COMMIT_SIGNERS,
});

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

/** The Projector's decision index: the precedents a change's preflight reads. */
export function decisionsLayer(env: Env): Layer.Layer<Decisions> {
  return DecisionsRpc(() => env.PROJECTOR.get(env.PROJECTOR.idFromName(PROJECTOR)));
}

export function codeHostLayer(env: Env, options: CodeHostOptions = {}): Layer.Layer<CodeHost> {
  return CodeHostArtifacts({ "keel-core": env.ARTIFACTS, "keel-ws-00": workspaces(env) }, options);
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
