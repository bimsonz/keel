import * as ports from "@keeltown/core/ports";
import { describe, expect, it } from "vitest";
import { PORTS } from "../src/ports.ts";

/** The ports, one row each. */
const CONTRACT_PORTS = [
  "Clock", "Ids", "AgentDirectory", "TokenIssuer", "CodeHost", "WorkspacePool", "SubjectRegistry", "Recall",
  "Notifier", "EntityStore", "EventOutbox", "EventLog", "WorkQueue", "DecisionModel", "PlatformFunction",
  "VerifierRuntime", "FlowSpecSource", "BundleStore", "GuardRepo", "CandidateComposer", "TrunkWriter",
  "SessionStore", "MfpWriter", "HumanGate", "Deployer", "SecretsProvider", "Background", "Metrics",
];

/** A port is an exported `Context.Service` class keyed under `keel/`. */
const declared = Object.entries(ports)
  .filter(([, value]) => typeof value === "function" && "key" in value && typeof value.key === "string" && value.key.startsWith("keel/"))
  .map(([name]) => name);

describe("ports", () => {
  it("declares exactly the ports in the engineering contract", () => {
    expect(declared.toSorted()).toEqual(CONTRACT_PORTS.toSorted());
  });

  it("gives every port an in-memory adapter and a contract suite", () => {
    expect(Object.keys(PORTS).toSorted()).toEqual(CONTRACT_PORTS.toSorted());
  });
});

for (const entry of Object.values(PORTS)) entry.verifyMemory();
