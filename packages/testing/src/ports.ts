import {
  describeAgentDirectoryContract,
  describeClockContract,
  describeEventOutboxContract,
  describeEntityStoreContract,
  describeIdsContract,
  describePendingContract,
  describeTokenIssuerContract,
  memoryOutboxHarness,
  type OutboxHarness,
} from "./contracts/index.ts";
import { describeChangesContract, type ChangesHarness } from "./contracts/changes.ts";
import type { CodeHostFixture } from "./code-host-fixture.ts";
import { describeCodeHostContract } from "./contracts/code-host.ts";
import { describeEnrolmentsContract, type EnrolmentsHarness } from "./contracts/enrolments.ts";
import { describeSessionsContract, type SessionsHarness } from "./contracts/sessions.ts";
import { describeStandingsContract, type StandingsHarness } from "./contracts/standings.ts";
import { describeLiveChangesContract, type LiveChangesHarness } from "./contracts/live-changes.ts";
import { describeProbeLedgerContract, type ProbeLedgerHarness } from "./contracts/probe-ledger.ts";
import { makeLiveChangesMemory } from "./memory/live-changes.ts";
import { makeProbeLedgerMemory } from "./memory/probe-ledger.ts";
import {
  describeNoopWorldsContract,
  describeProbeSourcesContract,
  type NoopWorldsHarness,
  type ProbeSourcesHarness,
} from "./contracts/probe-sources.ts";
import { makeNoopWorldsMemory, makeProbeSourcesMemory } from "./memory/probe-sources.ts";
import { makeSessionsMemory } from "./memory/sessions.ts";
import { makeStandingsMemory } from "./memory/standings.ts";
import { describeEventFeedContract, type EventFeedHarness } from "./contracts/event-feed.ts";
import {
  describeProjectViewsContract,
  type ProjectViewsHarness,
} from "./contracts/project-views.ts";
import { describeInboxContract, type InboxHarness } from "./contracts/inbox.ts";
import { describeNotifierContract, type NotifierHarness } from "./contracts/notifier.ts";
import { describeWorkspacePoolContract, type StockedPool } from "./contracts/workspace-pool.ts";
import { describeRepoServerContract } from "./contracts/repo-server.ts";
import {
  describeWorkspaceRebaserContract,
  type WorkspaceRebaserHarness,
} from "./contracts/workspace-rebaser.ts";
import {
  type BatchVerdictsHarness,
  type AdmittedGuardsHarness,
  type ChangePrecheckHarness,
  describeAdmittedGuardsContract,
  describeBatchVerdictsContract,
  describeBundleStoreContract,
  describeChangePrecheckContract,
  describeEvidenceStoreContract,
  describeFlowSpecSourceContract,
  describePlanStoreContract,
  describeProbeRunnerContract,
  describeProbeStoreContract,
  describeVerifierRuntimeContract,
  type FlowSpecSourceHarness,
  type PlanStoreHarness,
  type ProbeRunnerHarness,
  type ProbeStoreHarness,
  freshId,
} from "./contracts/verification.ts";
import { describeProjectsContract, type ProjectsHarness } from "./contracts/projects.ts";
import {
  describeMembershipsContract,
  describeOrgsContract,
  describeProjectOrgsContract,
  describeUsersContract,
  type TenancyHarness,
} from "./contracts/tenancy.ts";
import * as codeHost from "./memory/code-host.ts";
import * as coordination from "./memory/coordination.ts";
import * as delivery from "./memory/delivery.ts";
import * as feed from "./memory/event-feed.ts";
import * as outbox from "./memory/event-outbox.ts";
import * as identity from "./memory/identity.ts";
import * as integration from "./memory/integration.ts";
import * as operator from "./memory/operator.ts";
import * as projectViews from "./memory/project-views.ts";
import * as storage from "./memory/storage.ts";
import * as tenancy from "./memory/tenancy.ts";
import * as verification from "./memory/verification.ts";
import { SubjectKey } from "@keeltown/core/domain/coordination";
import { CommitSha, makeId } from "@keeltown/core/kernel";
import type {
  AdmittedGuards,
  AgentDirectory,
  CodeHost,
  BatchVerdicts,
  ChangePrecheck,
  Changes,
  Enrolments,
  EventFeed,
  FlowSpecSource,
  PlanStore,
  ProbeRunner,
  ProbeStore,
  Inbox,
  LiveChanges,
  Memberships,
  Orgs,
  ProbeLedger,
  NoopWorlds,
  ProbeSources,
  Notifier,
  Projects,
  ProjectViews,
  WorkspaceRebaser,
  Sessions,
  Standings,
  Users,
} from "@keeltown/core/ports";
import { Effect, Layer, Schema } from "effect";

/**
 * Every port, with its in-memory
 * adapter and its contract suite. `contract(adapter, make)` registers the
 * suite against any adapter's Layer factory; `verifyMemory()` registers it
 * against the in-memory adapter.
 */
function port<S>(
  memory: () => Layer.Layer<S>,
  contract: (adapter: string, make: () => Layer.Layer<S>) => void,
) {
  return { memory, contract, verifyMemory: () => contract("in-memory", memory) };
}

const pending =
  (name: string, methods: readonly string[]) =>
  (adapter: string): void =>
    describePendingContract(name, adapter, methods);

/**
 * The outbox's suite needs more than a Layer (a scripted fan-out, a clock it can move, and a way into a
 * Durable Object's context), so its real adapters register with a harness factory instead.
 */
const eventOutbox = {
  memory: () => outbox.makeEventOutboxMemory().layer,
  contract: (adapter: string, harness: () => OutboxHarness) =>
    describeEventOutboxContract(adapter, harness),
  verifyMemory: () => describeEventOutboxContract("in-memory", memoryOutboxHarness),
};

/** A port whose suite needs a harness beside its Layer: the Layer is the harness's. */
function harnessed<S, H extends { readonly layer: Layer.Layer<S> }>(
  harness: () => H,
  contract: (adapter: string, make: () => H) => void,
) {
  return {
    memory: () => harness().layer,
    contract,
    verifyMemory: () => contract("in-memory", harness),
  };
}

function memoryChangesHarness(): ChangesHarness {
  const memory = coordination.makeChangesMemory();
  let commits = 0;
  return {
    layer: memory.layer,
    push: (grant) =>
      Effect.sync(() => {
        commits += 1;
        const sha = CommitSha.make(commits.toString(16).padStart(40, "a"));
        memory.push(grant.workspaceId, sha);
        return sha;
      }),
    lapse: (changeId) => Effect.sync(() => memory.lapse(changeId)),
  };
}

function memoryWorkspaceRebaserHarness(): WorkspaceRebaserHarness {
  const code = codeHost.makeCodeHostMemory();
  const trunk = code.fixture.scratch();
  return {
    projectId: makeId("prj", "01KRBSRCNTRCT0000000000000"),
    trunk,
    layer: Layer.mergeAll(code.layer, codeHost.makeWorkspaceRebaserMemory(code, () => trunk).layer),
  };
}

/** The in-memory RepoServer serves the in-memory code host's repos. */
function memoryRepoServer() {
  const code = codeHost.makeCodeHostMemory();
  return Layer.mergeAll(code.layer, codeHost.makeRepoServerMemory(code).layer);
}

function memoryEventFeedHarness(): EventFeedHarness {
  const memory = feed.makeEventFeedMemory();
  return { layer: memory.layer, arrive: (event) => Effect.sync(() => memory.append(event)) };
}

function memoryProjectViewsHarness(): ProjectViewsHarness {
  const memory = projectViews.makeProjectViewsMemory();
  return { layer: memory.layer, arrive: memory.arrive };
}

function memoryInboxHarness(): InboxHarness {
  const memory = coordination.makeInboxMemory();
  return {
    layer: memory.layer,
    deliver: (agentId, notice) => Effect.sync(() => memory.deliver(agentId, notice)),
  };
}

/** The piggyback and the inbox share one memory, so the suite can check that a read stops a notice riding. */
function memoryNotifierHarness(): NotifierHarness {
  const memory = coordination.makeInboxMemory();
  return {
    layer: Layer.merge(memory.layer, memory.notifier),
    deliver: (agentId, notice) => Effect.sync(() => memory.deliver(agentId, notice)),
  };
}

/** The pool's suite needs a pool stocked for a project, so its adapters register with a stocking factory. */
const workspacePool = {
  memory: () => coordination.makeWorkspacePoolMemory().layer,
  contract: (adapter: string, stocked: StockedPool) =>
    describeWorkspacePoolContract(adapter, stocked),
  verifyMemory: () =>
    describeWorkspacePoolContract(
      "in-memory",
      (_projectId, capacity) => coordination.makeWorkspacePoolMemory({ capacity }).layer,
    ),
};

/** Precheck's suite needs submitted changes holding workspaces. */
function memoryChangePrecheckHarness(): ChangePrecheckHarness {
  const memory = verification.makeChangePrecheckMemory();
  return {
    layer: memory.layer,
    submitted: () =>
      Effect.sync(() => {
        const changeId = freshId("chg");
        const workspace = {
          workspaceId: makeId("wsp", changeId.slice(4)),
          repo: { namespace: "keel-ws-00", name: `ws-${changeId.slice(4).toLowerCase()}` },
          baseSha: GENESIS,
          grantedSha: GENESIS,
          projectId: freshId("prj"),
          subjects: [Schema.decodeUnknownSync(SubjectKey)("authz.sessions")],
        };
        memory.submit(changeId, 1, workspace);
        return { changeId, revision: 1, workspace };
      }),
  };
}

/** The lane's suite needs a formed batch of one change to record against. */
function memoryBatchVerdictsHarness(): BatchVerdictsHarness {
  const fence = { batchId: freshId("bat"), attempt: 1, chainEpoch: 0 };
  const candidateId = freshId("cnd");
  const lane = verification.makeBatchVerdictsMemory(
    new Map([
      [fence.batchId, { members: [freshId("chg")], candidateId, attempt: 1, chainEpoch: 0 }],
    ]),
  );
  return { layer: lane.layer, laneId: "lane:prj:default", fence, candidateId };
}

/** The in-memory Projects can fork from one source repo, which the suite names. */
function memoryProjectsHarness(): ProjectsHarness {
  const source = "fixture-source";
  const memory = operator.makeProjectsMemory({ sources: [source] });
  return {
    layer: memory.layer,
    source,
    withSettings: (settings) =>
      Effect.sync(() => {
        const projectId = freshId("prj");
        memory.setSettings(projectId, settings);
        return projectId;
      }),
  };
}

/** In-memory Enrolments project into an in-memory AgentDirectory, which the suite reads. */
function memoryEnrolmentsHarness(): EnrolmentsHarness {
  const directory = identity.makeAgentDirectoryMemory().layer;
  return {
    layer: Layer.merge(
      operator.makeEnrolmentsMemory().layer.pipe(Layer.provide(directory)),
      directory,
    ),
  };
}

/** The in-memory ledger runs the Subject DO's own use-cases, one object per subject. */
function memoryProbeLedgerHarness(): ProbeLedgerHarness {
  const memory = makeProbeLedgerMemory();
  return { layer: memory.layer, suspect: memory.suspect, log: memory.log };
}

/** The in-memory index folds what the suite feeds it with the Project DO's own `hearLiveChange`. */
function memoryLiveChangesHarness(): LiveChangesHarness {
  const memory = makeLiveChangesMemory();
  return {
    layer: memory.layer,
    hear: (projectId, event) => Effect.sync(() => memory.hear(projectId, event)),
  };
}

/** In-memory Sessions read the agents that in-memory Enrolments write into one in-memory AgentDirectory. */
function memorySessionsHarness(): SessionsHarness {
  const directory = identity.makeAgentDirectoryMemory();
  return {
    layer: Layer.mergeAll(makeSessionsMemory().layer, operator.makeEnrolmentsMemory().layer).pipe(
      Layer.provideMerge(directory.layer),
    ),
    suspend: (agentId) =>
      Effect.sync(() => {
        const agent = directory.agents.get(agentId);
        if (agent !== undefined) directory.agents.set(agentId, { ...agent, state: "suspended" });
      }),
  };
}

/** In-memory Standings move the agents that in-memory Enrolments write into one in-memory AgentDirectory. */
function memoryStandingsHarness(): StandingsHarness {
  const directory = identity.makeAgentDirectoryMemory();
  return {
    layer: Layer.mergeAll(makeStandingsMemory().layer, operator.makeEnrolmentsMemory().layer).pipe(
      Layer.provideMerge(directory.layer),
    ),
  };
}

/** A tenancy port's suite seeds Better Auth's rows into the memory its adapter reads. */
function memoryTenancyHarness<S>(
  make: (rows: tenancy.BetterAuthMemory) => { readonly layer: Layer.Layer<S> },
): () => TenancyHarness<S> {
  return () => {
    const rows = tenancy.makeBetterAuthMemory();
    return {
      layer: make(rows).layer,
      seed: (seeded) => Effect.sync(() => rows.seed(seeded)),
    };
  };
}

const GENESIS = Schema.decodeUnknownSync(CommitSha)("0".repeat(40));

export const PORTS = {
  Clock: port(() => identity.makeClockMemory().layer, describeClockContract),
  Ids: port(() => identity.makeIdsMemory().layer, describeIdsContract),
  AgentDirectory: port(
    () => identity.makeAgentDirectoryMemory().layer,
    describeAgentDirectoryContract,
  ),
  TokenIssuer: port(
    () =>
      identity.makeTokenIssuerMemory().layer.pipe(Layer.provide(identity.makeClockMemory().layer)),
    describeTokenIssuerContract,
  ),
  CodeHost: port(() => codeHost.makeCodeHostMemory().layer, describeCodeHostContract),
  WorkspacePool: workspacePool,
  WorkspaceRebaser: harnessed<
    WorkspaceRebaser | CodeHost | CodeHostFixture,
    WorkspaceRebaserHarness
  >(memoryWorkspaceRebaserHarness, describeWorkspaceRebaserContract),
  RepoServer: port(memoryRepoServer, describeRepoServerContract),
  Trunks: port(
    () => integration.makeTrunksMemory().layer,
    pending("Trunks", ["initialize", "sync"]),
  ),
  Lanes: port(() => integration.makeLanesMemory().layer, pending("Lanes", ["destroy"])),
  SubjectRegistry: port(
    () => coordination.makeSubjectRegistryMemory().layer,
    pending("SubjectRegistry", ["byKey", "byAnchor", "mint"]),
  ),
  Recall: port(
    () => coordination.makeRecallMemory(coordination.makeSubjectRegistryMemory()).layer,
    pending("Recall", ["nearest"]),
  ),
  Notifier: harnessed<Notifier | Inbox, NotifierHarness>(
    memoryNotifierHarness,
    describeNotifierContract,
  ),
  Changes: harnessed<Changes, ChangesHarness>(memoryChangesHarness, describeChangesContract),
  Inbox: harnessed<Inbox, InboxHarness>(memoryInboxHarness, describeInboxContract),
  Projects: harnessed<Projects, ProjectsHarness>(memoryProjectsHarness, describeProjectsContract),
  Enrolments: harnessed<Enrolments | AgentDirectory, EnrolmentsHarness>(
    memoryEnrolmentsHarness,
    describeEnrolmentsContract,
  ),
  LiveChanges: harnessed<LiveChanges, LiveChangesHarness>(
    memoryLiveChangesHarness,
    describeLiveChangesContract,
  ),
  ProbeLedger: harnessed<ProbeLedger, ProbeLedgerHarness>(
    memoryProbeLedgerHarness,
    describeProbeLedgerContract,
  ),
  Sessions: harnessed<Sessions | Enrolments | AgentDirectory, SessionsHarness>(
    memorySessionsHarness,
    describeSessionsContract,
  ),
  Standings: harnessed<Standings | Enrolments | AgentDirectory, StandingsHarness>(
    memoryStandingsHarness,
    describeStandingsContract,
  ),
  Orgs: harnessed<Orgs, TenancyHarness<Orgs>>(
    memoryTenancyHarness(tenancy.makeOrgsMemory),
    describeOrgsContract,
  ),
  Users: harnessed<Users, TenancyHarness<Users>>(
    memoryTenancyHarness(tenancy.makeUsersMemory),
    describeUsersContract,
  ),
  Memberships: harnessed<Memberships, TenancyHarness<Memberships>>(
    memoryTenancyHarness(tenancy.makeMembershipsMemory),
    describeMembershipsContract,
  ),
  ProjectOrgs: port(() => tenancy.makeProjectOrgsMemory().layer, describeProjectOrgsContract),
  EntityStore: port(() => storage.makeEntityStoreMemory().layer, describeEntityStoreContract),
  EventOutbox: eventOutbox,
  EventFeed: harnessed<EventFeed, EventFeedHarness>(
    memoryEventFeedHarness,
    describeEventFeedContract,
  ),
  ProjectViews: harnessed<ProjectViews, ProjectViewsHarness>(
    memoryProjectViewsHarness,
    describeProjectViewsContract,
  ),
  EventLog: port(() => storage.makeEventLogMemory().layer, pending("EventLog", ["publish"])),
  WorkQueue: port(() => storage.makeWorkQueueMemory().layer, pending("WorkQueue", ["enqueue"])),
  DecisionModel: port(
    () => verification.makeDecisionModelMemory().layer,
    pending("DecisionModel", ["ask"]),
  ),
  PlatformFunction: port(
    () => verification.makePlatformFunctionMemory().layer,
    pending("PlatformFunction", ["call"]),
  ),
  VerifierRuntime: port(
    () => verification.makeVerifierRuntimeMemory().layer,
    describeVerifierRuntimeContract,
  ),
  FlowSpecSource: harnessed<FlowSpecSource, FlowSpecSourceHarness>(
    verification.makeFlowSpecSourceMemory,
    describeFlowSpecSourceContract,
  ),
  BundleStore: port(() => storage.makeBundleStoreMemory().layer, describeBundleStoreContract),
  EvidenceStore: port(() => storage.makeEvidenceStoreMemory().layer, describeEvidenceStoreContract),
  PlanStore: harnessed<PlanStore, PlanStoreHarness>(
    storage.makePlanStoreMemory,
    describePlanStoreContract,
  ),
  ProbeRunner: harnessed<ProbeRunner, ProbeRunnerHarness>(
    verification.memoryProbeRunnerHarness,
    describeProbeRunnerContract,
  ),
  ProbeStore: harnessed<ProbeStore, ProbeStoreHarness>(
    verification.makeProbeStoreMemory,
    describeProbeStoreContract,
  ),
  BatchVerdicts: harnessed<BatchVerdicts, BatchVerdictsHarness>(
    memoryBatchVerdictsHarness,
    describeBatchVerdictsContract,
  ),
  ChangePrecheck: harnessed<ChangePrecheck, ChangePrecheckHarness>(
    memoryChangePrecheckHarness,
    describeChangePrecheckContract,
  ),
  AdmittedGuards: harnessed<AdmittedGuards, AdmittedGuardsHarness>(
    verification.makeAdmittedGuardsMemory,
    describeAdmittedGuardsContract,
  ),
  ProbeSources: harnessed<ProbeSources, ProbeSourcesHarness>(
    makeProbeSourcesMemory,
    describeProbeSourcesContract,
  ),
  NoopWorlds: harnessed<NoopWorlds, NoopWorldsHarness>(
    makeNoopWorldsMemory,
    describeNoopWorldsContract,
  ),
  GuardRepo: port(
    () => verification.makeGuardRepoMemory().layer,
    pending("GuardRepo", ["list", "admit"]),
  ),
  CandidateComposer: port(
    () => integration.makeCandidateComposerMemory().layer,
    pending("CandidateComposer", ["compose"]),
  ),
  CandidateBundles: port(
    () => integration.makeCandidateBundlesMemory().layer,
    pending("CandidateBundles", ["bundle"]),
  ),
  BatchVerification: port(
    () => integration.makeBatchVerificationMemory().layer,
    pending("BatchVerification", ["start"]),
  ),
  TrunkWriter: port(
    () => integration.makeTrunkWriterMemory(GENESIS).layer,
    pending("TrunkWriter", ["head", "push", "sync"]),
  ),
  StagingWriter: port(
    () => integration.makeStagingWriterMemory().layer,
    pending("StagingWriter", ["fastForward"]),
  ),
  SessionStore: port(
    () => storage.makeSessionStoreMemory().layer,
    pending("SessionStore", ["append", "read"]),
  ),
  MfpWriter: port(
    () => storage.makeMfpWriterMemory().layer,
    pending("MfpWriter", ["write", "note"]),
  ),
  HumanGate: port(
    () => verification.makeHumanGateMemory().layer,
    pending("HumanGate", ["raise", "awaitRuling"]),
  ),
  Deployer: port(
    () => delivery.makeDeployerMemory().layer,
    pending("Deployer", ["plan", "preview", "verify", "promote", "rollback", "teardown"]),
  ),
  SecretsProvider: port(
    () => storage.makeSecretsProviderMemory().layer,
    pending("SecretsProvider", ["get"]),
  ),
  Background: port(() => storage.makeBackgroundMemory().layer, pending("Background", ["run"])),
  Metrics: port(() => storage.makeMetricsMemory().layer, pending("Metrics", ["count", "observe"])),
} satisfies Record<string, { readonly verifyMemory: () => void }>;

export type PortName = keyof typeof PORTS;
