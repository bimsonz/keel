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
import { describeCodeHostContract } from "./contracts/code-host.ts";
import * as codeHost from "./memory/code-host.ts";
import * as coordination from "./memory/coordination.ts";
import * as delivery from "./memory/delivery.ts";
import * as outbox from "./memory/event-outbox.ts";
import * as identity from "./memory/identity.ts";
import * as integration from "./memory/integration.ts";
import * as storage from "./memory/storage.ts";
import * as verification from "./memory/verification.ts";
import { CommitSha } from "@keeltown/core/kernel";
import { Layer, Schema } from "effect";

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
  WorkspacePool: port(
    () => coordination.makeWorkspacePoolMemory().layer,
    pending("WorkspacePool", ["grant", "release"]),
  ),
  SubjectRegistry: port(
    () => coordination.makeSubjectRegistryMemory().layer,
    pending("SubjectRegistry", ["byKey", "byAnchor", "mint"]),
  ),
  Recall: port(
    () => coordination.makeRecallMemory(coordination.makeSubjectRegistryMemory()).layer,
    pending("Recall", ["nearest"]),
  ),
  Notifier: port(() => coordination.makeNotifierMemory().layer, pending("Notifier", ["notify"])),
  Changes: port(
    () => coordination.makeChangesMemory().layer,
    pending("Changes", ["declare", "submit", "get", "awaitSubmission"]),
  ),
  Inbox: port(() => coordination.makeInboxMemory().layer, pending("Inbox", ["read"])),
  EntityStore: port(() => storage.makeEntityStoreMemory().layer, describeEntityStoreContract),
  EventOutbox: eventOutbox,
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
    pending("VerifierRuntime", ["run"]),
  ),
  FlowSpecSource: port(
    () => verification.makeFlowSpecSourceMemory().layer,
    pending("FlowSpecSource", ["read"]),
  ),
  BundleStore: port(
    () => storage.makeBundleStoreMemory().layer,
    pending("BundleStore", ["put", "get"]),
  ),
  GuardRepo: port(
    () => verification.makeGuardRepoMemory().layer,
    pending("GuardRepo", ["list", "admit"]),
  ),
  CandidateComposer: port(
    () => integration.makeCandidateComposerMemory().layer,
    pending("CandidateComposer", ["compose"]),
  ),
  TrunkWriter: port(
    () => integration.makeTrunkWriterMemory(GENESIS).layer,
    pending("TrunkWriter", ["head", "push"]),
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
