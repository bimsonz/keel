// The Changes contract through the real Change and AgentSession DOs. The
// real WorkspacePool DO grants each workspace, forked from a mirror in the fake
// Artifacts namespace (TEST_ARTIFACTS), and the Change DO asks the real CodeHost
// adapter whether a submitted commit is in the workspace.
import { runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Principal } from "@keeltown/core/domain/identity";
import { LEASE_TTL_MS } from "@keeltown/core/domain/coordination";
import { type AgentId, type ChangeId, makeId, type ProjectId } from "@keeltown/core/kernel";
import { makeManualClock, PORTS } from "@keeltown/testing";
import { Effect, Exit } from "effect";
import { ulid } from "ulid";
import { expect, vi } from "vitest";
import { ChangesRpc } from "../../src/adapters/driven/do-rpc/changes.ts";
import { changeServices } from "../../src/composition/do.ts";
import { rewire } from "./change-harness.ts";
import { decodeExit, WorkspacePoolCodecs } from "../../src/rpc/index.ts";

const poolStub = (projectId: ProjectId) =>
  env.WORKSPACE_POOL.get(env.WORKSPACE_POOL.idFromName(`pool:${projectId}`));

async function readyIn(projectId: ProjectId): Promise<number> {
  const exit = decodeExit(WorkspacePoolCodecs.status, await poolStub(projectId).status());
  return Exit.isSuccess(exit) ? exit.value.ready : 0;
}

/** An agent in a project of its own, whose pool holds ready workspaces, as createProject leaves it. */
async function stockedCaller(): Promise<Principal> {
  if (env.TEST_ARTIFACTS === undefined) throw new Error("vitest.config.ts binds TEST_ARTIFACTS");
  const projectId: ProjectId = makeId("prj", ulid());
  const mirror = `mirror-${ulid().toLowerCase()}`;
  await env.TEST_ARTIFACTS.create(mirror);
  const pool = poolStub(projectId);
  await pool.configure({ source: { namespace: "keel-ws-00", name: mirror }, target: 3 });
  // The refill is a deadline armed for now; the platform may run it before this line does.
  await runDurableObjectAlarm(pool);
  await vi.waitFor(async () => expect(await readyIn(projectId)).toBeGreaterThan(0), {
    timeout: 20_000,
    interval: 25,
  });
  const agentId: AgentId = makeId("agt", ulid());
  return { agentId, projectId, scopes: ["agent:read", "agent:work"], revocationEpoch: 0 };
}

PORTS.Changes.contract("Change DO over RPC", () => ({
  layer: ChangesRpc({
    change: (changeId: ChangeId) => env.CHANGE.get(env.CHANGE.idFromName(`change:${changeId}`)),
    agentSession: (agentId: AgentId) =>
      env.AGENT_SESSION.get(env.AGENT_SESSION.idFromName(`agent:${agentId}`)),
  }),
  // The fake namespace holds no git content, so the one commit a workspace holds
  // is the head it was forked at: its base. The in-memory harness pushes a fresh one.
  push: (grant) => Effect.succeed(grant.baseSha),
  caller: () => Effect.promise(stockedCaller),
  // The object's own adapters on a clock past the lease's TTL: the deadline has passed for it.
  lapse: (changeId) =>
    Effect.promise(() => {
      const stub = env.CHANGE.get(env.CHANGE.idFromName(`change:${changeId}`));
      const past = makeManualClock(Date.now() + LEASE_TTL_MS + 60_000);
      return rewire(stub, changeServices(env), past.layer);
    }),
}));
