import {
  describeAgentDirectoryContract,
  describeClockContract,
  describeEventOutboxContract,
  describeEntityStoreContract,
  describeIdsContract,
  type EntityStoreHarness,
  memoryEntityStoreHarness,
  describePendingContract,
  describeTokenIssuerContract,
  memoryOutboxHarness,
  type OutboxHarness,
} from "./contracts/index.ts";
import { describeChangesContract, type ChangesHarness } from "./contracts/changes.ts";
import type { CodeHostFixture } from "./code-host-fixture.ts";
import { describeCodeHostContract } from "./contracts/code-host.ts";
import {
  type AgentSignUpsHarness,
  describeAgentSignUpsContract,
} from "./contracts/agent-sign-ups.ts";
import { describeEnrolmentsContract, type EnrolmentsHarness } from "./contracts/enrolments.ts";
import { describeSessionsContract, type SessionsHarness } from "./contracts/sessions.ts";
import {
  describeNamespaceUsageContract,
  freshNamespace,
  type NamespaceUsageHarness,
} from "./contracts/namespace-usage.ts";
import { describeLanesContract } from "./contracts/lanes.ts";
import { describeTrunksContract, type TrunksHarness } from "./contracts/trunks.ts";
import { describeStandingsContract, type StandingsHarness } from "./contracts/standings.ts";
import {
  describeSponsorshipsContract,
  type SponsorshipsHarness,
} from "./contracts/sponsorships.ts";
import { describeLiveChangesContract, type LiveChangesHarness } from "./contracts/live-changes.ts";
import {
  describeProbeChangesContract,
  type ProbeChangesHarness,
} from "./contracts/probe-changes.ts";
import {
  type ConflictMovesHarness,
  describeConflictMovesContract,
} from "./contracts/conflict-moves.ts";
import {
  describeEscalationsContract,
  describeHumanGateContract,
  type EscalationsHarness,
} from "./contracts/escalations.ts";
import { describeProbeLedgerContract, type ProbeLedgerHarness } from "./contracts/probe-ledger.ts";
import { makeProbeChangesMemory, makeWorldChecksMemory } from "./memory/probe-changes.ts";
import { makeLiveChangesMemory } from "./memory/live-changes.ts";
import { makeEscalationsMemory, makeQuestionRaisersMemory } from "./memory/escalations.ts";
import { makeProbeLedgerMemory } from "./memory/probe-ledger.ts";
import {
  describeNoopWorldsContract,
  describeProbeSourcesContract,
  type NoopWorldsHarness,
  type ProbeSourcesHarness,
} from "./contracts/probe-sources.ts";
import { makeNoopWorldsMemory, makeProbeSourcesMemory } from "./memory/probe-sources.ts";
import {
  describeSyntaxSourceContract,
  type SyntaxSourceHarness,
} from "./contracts/syntax-source.ts";
import { makeSyntaxSourceMemory } from "./memory/syntax-source.ts";
import { makeSessionsMemory } from "./memory/sessions.ts";
import { makeNamespaceUsageMemory } from "./memory/namespace-usage.ts";
import { makeStandingsMemory } from "./memory/standings.ts";
import { makeSponsorRequestsMemory, makeSponsorshipsMemory } from "./memory/sponsorships.ts";
import { describeSponsorRequestsContract } from "./contracts/sponsor-requests.ts";
import {
  makeInvitationsMemory,
  makeNamespaceAgentsMemory,
  makeProjectAgentsMemory,
} from "./memory/invitations.ts";
import {
  describeInvitationsContract,
  describeNamespaceAgentsContract,
  describeProjectAgentsContract,
} from "./contracts/invitations.ts";
import { describeEventFeedContract, type EventFeedHarness } from "./contracts/event-feed.ts";
import {
  describeProjectViewsContract,
  type ProjectViewsHarness,
} from "./contracts/project-views.ts";
import { type DecisionsHarness, describeDecisionsContract } from "./contracts/decisions.ts";
import { describeVerdictsContract, type VerdictsHarness } from "./contracts/verdicts.ts";
import { describeInboxContract, type InboxHarness } from "./contracts/inbox.ts";
import { describeNotifierContract, type NotifierHarness } from "./contracts/notifier.ts";
import { describeWorkspacePoolContract, type StockedPool } from "./contracts/workspace-pool.ts";
import { describeRepoServerContract } from "./contracts/repo-server.ts";
import {
  describeWorkspaceRebaserContract,
  type WorkspaceRebaserHarness,
} from "./contracts/workspace-rebaser.ts";
import {
  describeWorkspaceWriterContract,
  type WorkspaceWriterHarness,
} from "./contracts/workspace-writer.ts";
import {
  describeWorkspaceRefresherContract,
  type WorkspaceRefresherHarness,
} from "./contracts/workspace-refresher.ts";
import {
  type BatchVerdictsHarness,
  type AdmittedGuardsHarness,
  type ChangePrecheckHarness,
  describeAdmittedGuardsContract,
  describeBatchVerdictsContract,
  describeBundleStoreContract,
  describeChangePrecheckContract,
  describeDepsBuilderContract,
  describeEvidenceStoreContract,
  describeFlowSpecSourceContract,
  describePlanStoreContract,
  describeProbeRunnerContract,
  describeProbeStoreContract,
  describeVerifierRuntimeContract,
  type DepsBuilderHarness,
  type FlowSpecSourceHarness,
  type PlanStoreHarness,
  type ProbeRunnerHarness,
  type ProbeStoreHarness,
  freshId,
} from "./contracts/verification.ts";
import { describeCredentialStoreContract } from "./contracts/credential-store.ts";
import {
  type DeployTargetsHarness,
  describeDeployTargetsContract,
} from "./contracts/deploy-targets.ts";
import { describeProjectsContract, type ProjectsHarness } from "./contracts/projects.ts";
import {
  describeMembershipsContract,
  describeNamespacesContract,
  describeProjectNamespacesContract,
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
  ConflictMoves,
  Decisions,
  Escalations,
  HumanGate,
  BatchVerdicts,
  ChangePrecheck,
  Changes,
  AgentSignUps,
  DepsBuilder,
  DeployTargets,
  Enrolments,
  EventFeed,
  FlowSpecSource,
  PlanStore,
  ProbeRunner,
  ProbeStore,
  Inbox,
  LiveChanges,
  Memberships,
  Namespaces,
  ProbeChanges,
  ProbeLedger,
  NoopWorlds,
  ProbeSources,
  Notifier,
  ProjectNamespaces,
  Projects,
  ProjectViews,
  WorkspaceRebaser,
  WorkspaceRefresher,
  WorkspaceWriter,
  Sessions,
  Sponsorships,
  Standings,
  SyntaxSource,
  Trunks,
  Users,
  NamespaceUsage,
  Verdicts,
} from "@keeltown/core/ports";
import { Effect, Layer, Schema } from "effect";

/**
 * Every port of Keel's application layer, with its in-memory
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

/** The store's suite runs inside a Durable Object's context for DO SQLite, so it too registers with a harness factory. */
const entityStore = {
  memory: () => storage.makeEntityStoreMemory().layer,
  contract: (adapter: string, harness: () => EntityStoreHarness) =>
    describeEntityStoreContract(adapter, harness),
  verifyMemory: () => describeEntityStoreContract("in-memory", memoryEntityStoreHarness),
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

function memoryWorkspaceWriterHarness(): WorkspaceWriterHarness {
  const code = codeHost.makeCodeHostMemory();
  return { layer: Layer.mergeAll(code.layer, codeHost.makeWorkspaceWriterMemory(code).layer) };
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

function memoryWorkspaceRefresherHarness(): WorkspaceRefresherHarness {
  const code = codeHost.makeCodeHostMemory();
  const trunk = code.fixture.scratch();
  return {
    projectId: makeId("prj", "01KRBSRCNTRCT0000000000000"),
    trunk,
    layer: Layer.mergeAll(
      code.layer,
      codeHost.makeWorkspaceRefresherMemory(code, () => trunk).layer,
    ),
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

function memoryDecisionsHarness(): DecisionsHarness {
  const memory = projectViews.makeDecisionsMemory();
  return { layer: memory.layer, arrive: memory.arrive };
}

function memoryVerdictsHarness(): VerdictsHarness {
  const memory = projectViews.makeVerdictsMemory();
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
          intent: { revision: 1, goal: "cache the sessions", footprint: [], premises: [] },
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

/** The in-memory deploy targets, each project's held as its own Project DO would hold them. */
function memoryDeployTargetsHarness(): DeployTargetsHarness {
  const memory = delivery.makeDeployTargetsMemory();
  return {
    layer: memory.layer,
    establish: (projectId) => Effect.sync(() => memory.establish(projectId)),
  };
}

/** The in-memory Projects can fork from one source repo, which the suite names. */
function memoryProjectsHarness(): ProjectsHarness {
  const source = "fixture-source";
  const memory = operator.makeProjectsMemory({ sources: [source] });
  return {
    layer: memory.layer,
    source,
    hear: (projectId, event) => Effect.sync(() => void memory.live.hear(projectId, event)),
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

function memoryAgentSignUpsHarness(): AgentSignUpsHarness {
  const directory = identity.makeAgentDirectoryMemory().layer;
  const rows = tenancy.makeBetterAuthMemory();
  return {
    layer: Layer.mergeAll(
      operator.makeAgentSignUpsMemory(rows).layer.pipe(Layer.provide(directory)),
      directory,
      tenancy.makeNamespacesMemory(rows).layer,
    ),
  };
}

/** The in-memory ledger runs the Subject DO's own use-cases, one object per subject. */
function memoryProbeLedgerHarness(): ProbeLedgerHarness {
  const memory = makeProbeLedgerMemory();
  return { layer: memory.layer, suspect: memory.suspect, log: memory.log };
}

/** The in-memory subjects escalate into the in-memory namespaces, whose reads fold at once: nothing to wait for. */
function memoryConflictMovesHarness(): ConflictMovesHarness {
  const memory = makeProbeLedgerMemory();
  return {
    layer: memory.world,
    suspect: memory.suspect,
    log: memory.log,
    place: (projectId, namespace) =>
      Effect.sync(() => {
        memory.orgs.places.set(projectId, {
          projectId,
          namespace: namespace,
          name: projectId.toLowerCase(),
        });
      }),
    settled: () => Effect.void,
  };
}

/** The in-memory namespaces run the namespace object's own use-cases, and their reads fold at once. */
function memoryEscalationsHarness(): EscalationsHarness {
  const memory = makeEscalationsMemory();
  return {
    layer: memory.layer,
    settled: () => Effect.void,
    log: (namespace, entity) => Effect.sync(() => memory.log(namespace, entity)),
  };
}

/** The in-memory index folds what the suite feeds it with the Project DO's own `hearLiveChange`. */
function memoryLiveChangesHarness(): LiveChangesHarness {
  const memory = makeLiveChangesMemory();
  return {
    layer: memory.layer,
    hear: (projectId, event) => Effect.sync(() => memory.hear(projectId, event)),
    live: (projectId) => Effect.sync(() => memory.live(projectId)),
    rows: (projectId, kind) =>
      Effect.sync(() =>
        memory
          .storeOf(projectId)
          .list(kind)
          .map((row) => row.id),
      ),
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

/** In-memory Trunks take any project: each case gets one no other has named. */
function memoryTrunksHarness(): TrunksHarness {
  return {
    layer: integration.makeTrunksMemory().layer,
    fresh: () =>
      Effect.sync(() => ({
        projectId: makeId(
          "prj",
          crypto.randomUUID().replaceAll("-", "").slice(0, 26).toUpperCase(),
        ),
        head: CommitSha.make("7".repeat(40)),
      })),
  };
}

/** In-memory NamespaceUsage counts for any namespace, on a clock the suite moves. */
function memoryNamespaceUsageHarness(): NamespaceUsageHarness {
  const usage = makeNamespaceUsageMemory();
  return {
    layer: usage.layer,
    namespace: () => Effect.sync(freshNamespace),
    now: Effect.sync(usage.clock.now),
    advance: (ms) => Effect.sync(() => usage.clock.advance(ms)),
  };
}

/** In-memory Sponsorships link the agents that in-memory Enrolments write, and in-memory Standings pause, in one in-memory AgentDirectory. */
function memorySponsorshipsHarness(): SponsorshipsHarness {
  const directory = identity.makeAgentDirectoryMemory();
  const sponsorships = makeSponsorshipsMemory();
  return {
    layer: Layer.mergeAll(
      sponsorships.layer,
      makeStandingsMemory().layer,
      operator.makeEnrolmentsMemory().layer,
    ).pipe(Layer.provideMerge(directory.layer)),
    expire: sponsorships.expire,
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
  WorkspaceWriter: harnessed<WorkspaceWriter | CodeHost | CodeHostFixture, WorkspaceWriterHarness>(
    memoryWorkspaceWriterHarness,
    describeWorkspaceWriterContract,
  ),
  WorkspaceRefresher: harnessed<
    WorkspaceRefresher | CodeHost | CodeHostFixture,
    WorkspaceRefresherHarness
  >(memoryWorkspaceRefresherHarness, describeWorkspaceRefresherContract),
  RepoServer: port(memoryRepoServer, describeRepoServerContract),
  Trunks: harnessed<Trunks, TrunksHarness>(memoryTrunksHarness, describeTrunksContract),
  Lanes: port(() => integration.makeLanesMemory().layer, describeLanesContract),
  NamespaceUsage: harnessed<NamespaceUsage, NamespaceUsageHarness>(
    memoryNamespaceUsageHarness,
    describeNamespaceUsageContract,
  ),
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
  AgentSignUps: harnessed<AgentSignUps | AgentDirectory | Namespaces, AgentSignUpsHarness>(
    memoryAgentSignUpsHarness,
    describeAgentSignUpsContract,
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
  Sponsorships: harnessed<
    Sponsorships | Standings | Enrolments | AgentDirectory,
    SponsorshipsHarness
  >(memorySponsorshipsHarness, describeSponsorshipsContract),
  NamespaceAgents: port(() => makeNamespaceAgentsMemory().layer, describeNamespaceAgentsContract),
  SponsorRequests: port(() => makeSponsorRequestsMemory().layer, describeSponsorRequestsContract),
  ProjectAgents: port(() => makeProjectAgentsMemory().layer, describeProjectAgentsContract),
  Invitations: port(
    () =>
      makeInvitationsMemory().layer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(makeNamespaceAgentsMemory().layer, makeProjectAgentsMemory().layer),
        ),
      ),
    describeInvitationsContract,
  ),
  Namespaces: harnessed<Namespaces, TenancyHarness<Namespaces>>(
    memoryTenancyHarness(tenancy.makeNamespacesMemory),
    describeNamespacesContract,
  ),
  Users: harnessed<Users, TenancyHarness<Users>>(
    memoryTenancyHarness(tenancy.makeUsersMemory),
    describeUsersContract,
  ),
  Memberships: harnessed<Memberships, TenancyHarness<Memberships>>(
    memoryTenancyHarness(tenancy.makeMembershipsMemory),
    describeMembershipsContract,
  ),
  ProjectNamespaces: harnessed<ProjectNamespaces, TenancyHarness<ProjectNamespaces>>(
    memoryTenancyHarness(tenancy.makeProjectNamespacesMemory),
    describeProjectNamespacesContract,
  ),
  EntityStore: entityStore,
  EventOutbox: eventOutbox,
  EventFeed: harnessed<EventFeed, EventFeedHarness>(
    memoryEventFeedHarness,
    describeEventFeedContract,
  ),
  ProjectViews: harnessed<ProjectViews, ProjectViewsHarness>(
    memoryProjectViewsHarness,
    describeProjectViewsContract,
  ),
  Decisions: harnessed<Decisions, DecisionsHarness>(
    memoryDecisionsHarness,
    describeDecisionsContract,
  ),
  Verdicts: harnessed<Verdicts, VerdictsHarness>(memoryVerdictsHarness, describeVerdictsContract),
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
  DepsBuilder: harnessed<DepsBuilder, DepsBuilderHarness>(
    verification.makeDepsBuilderMemory,
    describeDepsBuilderContract,
  ),
  ProbeSources: harnessed<ProbeSources, ProbeSourcesHarness>(
    makeProbeSourcesMemory,
    describeProbeSourcesContract,
  ),
  NoopWorlds: harnessed<NoopWorlds, NoopWorldsHarness>(
    makeNoopWorldsMemory,
    describeNoopWorldsContract,
  ),
  SyntaxSource: harnessed<SyntaxSource, SyntaxSourceHarness>(
    makeSyntaxSourceMemory,
    describeSyntaxSourceContract,
  ),
  ProbeChanges: harnessed<ProbeChanges, ProbeChangesHarness>(
    () => makeProbeChangesMemory(),
    describeProbeChangesContract,
  ),
  WorldChecks: port(() => makeWorldChecksMemory().layer, pending("WorldChecks", ["start"])),
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
    pending("TrunkWriter", ["head", "push", "packBytes", "historyBytes", "sync"]),
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
  HumanGate: harnessed<HumanGate | Escalations, EscalationsHarness>(
    memoryEscalationsHarness,
    describeHumanGateContract,
  ),
  Escalations: harnessed<HumanGate | Escalations, EscalationsHarness>(
    memoryEscalationsHarness,
    describeEscalationsContract,
  ),
  ConflictMoves: harnessed<ConflictMoves | ProbeLedger | Escalations, ConflictMovesHarness>(
    memoryConflictMovesHarness,
    describeConflictMovesContract,
  ),
  Deployer: port(
    () => delivery.makeDeployerMemory().layer,
    pending("Deployer", ["preview", "promote", "deleteVersion"]),
  ),
  Deployments: port(
    () => delivery.makeDeploymentsMemory().layer,
    pending("Deployments", ["record", "of", "promoted", "refused"]),
  ),
  PreviewNotices: port(
    () => delivery.makePreviewNoticesMemory().layer,
    pending("PreviewNotices", ["tell"]),
  ),
  // The real probe asks a preview over the network; its mapping is unit-tested against a fetch double.
  SmokeProbe: port(() => delivery.makeSmokeProbeMemory().layer, pending("SmokeProbe", ["ask"])),
  // The real check asks Cloudflare's API, so no suite runs it: its mapping is unit-tested against a fetch double.
  DeployTargetCheck: port(
    () => delivery.makeDeployTargetCheckMemory().layer,
    pending("DeployTargetCheck", ["reach"]),
  ),
  CloudflareOAuth: port(
    () => delivery.makeCloudflareOAuthMemory().layer,
    pending("CloudflareOAuth", ["begin", "exchange", "accounts", "mint"]),
  ),
  DeployTargets: harnessed<DeployTargets, DeployTargetsHarness>(
    memoryDeployTargetsHarness,
    describeDeployTargetsContract,
  ),
  CredentialStore: port(
    () => delivery.makeCredentialStoreMemory().layer,
    describeCredentialStoreContract,
  ),
  QuestionRaisers: port(
    () => makeQuestionRaisersMemory().layer,
    pending("QuestionRaisers", ["recheck"]),
  ),
  Background: port(() => storage.makeBackgroundMemory().layer, pending("Background", ["run"])),
  Metrics: port(() => storage.makeMetricsMemory().layer, pending("Metrics", ["count", "observe"])),
} satisfies Record<string, { readonly verifyMemory: () => void }>;

export type PortName = keyof typeof PORTS;
