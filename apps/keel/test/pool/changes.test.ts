// The Changes contract through the real Change and AgentSession DOs. The
// real WorkspacePool DO grants each workspace, forked from a mirror in the fake
// Artifacts namespace (TEST_ARTIFACTS), and the Change DO asks the real CodeHost
// adapter whether a submitted commit is in the workspace.
import { runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { AgentToken } from "@keeltown/core/domain/identity";
import { LEASE_TTL_MS } from "@keeltown/core/domain/coordination";
import { type AgentId, type ChangeId, makeId, type ProjectId } from "@keeltown/core/kernel";
import { makeManualClock, PORTS } from "@keeltown/testing";
import { Effect, Exit } from "effect";
import { ulid } from "ulid";
import { afterAll, beforeAll, expect, vi } from "vitest";
import { ChangesRpc } from "../../src/adapters/driven/do-rpc/changes.ts";
import { changeServices } from "../../src/composition/do.ts";
import { rewire } from "./change-harness.ts";
import { inertPrecheck } from "./inert-precheck.ts";
import { followTrunk } from "./pool-harness.ts";
import { decodeExit, WorkspacePoolCodecs } from "../../src/rpc/index.ts";

const poolStub = (projectId: ProjectId) =>
  env.WORKSPACE_POOL.get(env.WORKSPACE_POOL.idFromName(`pool:${projectId}`));

async function readyIn(projectId: ProjectId): Promise<number> {
  const exit = decodeExit(WorkspacePoolCodecs.status, await poolStub(projectId).status());
  return Exit.isSuccess(exit) ? exit.value.ready : 0;
}

/** An agent in a project of its own, whose pool holds ready workspaces, as the project's finish leaves it. */
async function stockedCaller(): Promise<AgentToken> {
  if (env.TEST_ARTIFACTS === undefined) throw new Error("vitest.config.ts binds TEST_ARTIFACTS");
  const projectId: ProjectId = makeId("prj", ulid());
  const mirror = `mirror-${ulid().toLowerCase()}`;
  await env.TEST_ARTIFACTS.create(mirror);
  const pool = poolStub(projectId);
  const source = { namespace: "keel-ws-00", name: mirror };
  // A project's trunk is initialized before its finish configures the pool; this project has none.
  await followTrunk(projectId, source);
  await pool.configure({ source, target: 3 });
  // The refill is a deadline armed for now; the platform may run it before this line does.
  await runDurableObjectAlarm(pool);
  await vi.waitFor(async () => expect(await readyIn(projectId)).toBeGreaterThan(0), {
    timeout: 20_000,
    interval: 25,
  });
  const agentId: AgentId = makeId("agt", ulid());
  return { agentId, projectId, scopes: ["agent:read", "agent:work"], revocationEpoch: 0 };
}

// The contract asks nothing of Precheck, and each submit starts one: held inert for the whole
// file, where its real run would refuse the caller's unplaced project behind the case's back.
let precheck: Awaited<ReturnType<typeof inertPrecheck>> | undefined;
beforeAll(async () => {
  precheck = await inertPrecheck();
});
afterAll(async () => {
  await precheck?.dispose();
});

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
