import {
  type AgentDirectory,
  type Clock,
  type CodeHost,
  type EntityStore,
  type EventOutbox,
  type FanOut,
  type Ids,
  type TrunkWriter,
  type Trunks,
  type WorkspacePool,
} from "@keeltown/core/ports";
import { projectRepos } from "@keeltown/core/application/integration";
import type { ProjectId } from "@keeltown/core/kernel";
import { Layer, ManagedRuntime } from "effect";
import { CodeHostArtifacts } from "../adapters/driven/artifacts/code-host.ts";
import { AgentDirectoryD1 } from "../adapters/driven/d1/agent-directory.ts";
import { FanOutRpc } from "../adapters/driven/do-rpc/fan-out.ts";
import { TrunksRpc } from "../adapters/driven/do-rpc/trunks.ts";
import { TrunkWriterGitCore } from "../adapters/driven/gitcore/trunk-writer.ts";
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
export type ChangeServices = WorkspacePool | CodeHost;

/**
 * The Change DO takes its workspace from its project's WorkspacePool DO and
 * asks the code host whether a submitted commit is in it.
 */
export function changeServices(env: Env): Layer.Layer<ChangeServices> {
  return Layer.mergeAll(
    WorkspacePoolRpc(env.WORKSPACE_POOL, artifactsLocationHint(env)),
    codeHostLayer(env),
  );
}

/** The Trunk DO's driven adapters beyond the backbone: the one writer of its project's trunk. */
export type TrunkServices = TrunkWriter;

/**
 * The Trunk DO writes and syncs its project's trunk through GitCore over the
 * code host. `projectId` is read lazily, on first use, from the object's name.
 */
export function trunkServices(env: Env, projectId: () => ProjectId): Layer.Layer<TrunkServices> {
  return Layer.suspend(() =>
    TrunkWriterGitCore(projectRepos(projectId())).pipe(Layer.provide(codeHostLayer(env))),
  );
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
