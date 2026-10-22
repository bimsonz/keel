// A change to how Keel verifies, on the real path: the real Change DO parks
// it for a ruling as Precheck's plan queues it, Precheck's ruling step puts
// the question to the project's maintainers through the HumanGate adapter on
// the real namespace object, and a person's ruling over the deployed fetch
// handler resumes it into the lane or bounces it. Only a person rules: an
// agent's token and a change's workspace token are refused. A person signed
// in as themselves over MCP lists the question and rules with its tool.
import { heldLease } from "@keeltown/testing";
import { env } from "cloudflare:workers";
import {
  askFlowRuling,
  decisionIdOf,
  FLOW_RULING_APPROVE,
  flowRulingIdOf,
  namespaceAddress,
} from "@keeltown/core/application/coordination";
import { type EscalationId, makeId } from "@keeltown/core/kernel";
import { Escalations, PROJECTOR } from "@keeltown/core/ports";
import { Effect, Layer } from "effect";
import { ulid } from "ulid";
import { describe, expect, it, vi } from "vitest";
import { EscalationsRpc } from "../../src/adapters/driven/do-rpc/escalations.ts";
import { ChangePrecheckRpc } from "../../src/adapters/driven/do-rpc/change-precheck.ts";
import { HumanGateRpc } from "../../src/adapters/driven/do-rpc/human-gate.ts";
import { PERSON_INSTRUCTIONS } from "../../src/adapters/driving/mcp/server.ts";
import { ChangeCodecs, decodeExit } from "../../src/rpc/index.ts";
import { type ChangeUnderTest, changeUnderTest, ok } from "./change-harness.ts";
import {
  BASE,
  drainAfter,
  drainOutbox,
  mcp,
  mcpResult,
  POOL_ORG,
  seedAgent,
  seedUser,
  tokenFor,
  uniqueHandle,
  worker,
} from "./helpers.ts";
import { inertPrecheck } from "./inert-precheck.ts";

const WAIT = { timeout: 20_000, interval: 50 };
const PLAN_HASH = `sha256:${"f".repeat(64)}`;

const namespaceObject = () =>
  drainAfter(env.NAMESPACE.get(env.NAMESPACE.idFromName(namespaceAddress(POOL_ORG))));

/** Declares, pushes, submits and starts Precheck: the change is deriving, awaiting its plan. */
async function deriving(c: ChangeUnderTest) {
  const lease = heldLease(ok(await c.declare(`declare-${c.changeId}`, {})).change).id;
  await drainOutbox(c.stub);
  const commitSha = await c.push();
  ok(
    decodeExit(
      ChangeCodecs.submit,
      await c.stub.submit({
        agentId: c.agentId,
        projectId: c.projectId,
        leaseId: lease,
        commitSha,
        idempotencyKey: "s-1",
      }),
    ),
  );
  ok(
    decodeExit(
      ChangeCodecs.precheckStarted,
      await c.stub.precheckStarted({
        revision: 1,
        instanceId: "p-1",
        commitSha: await c.carried(),
      }),
    ),
  );
}

/**
 * Precheck run `instanceId`'s plan for a change to `.keel/flow`: it holds the
 * gate, so the change queues and parks for its ruling, asked of that run.
 */
async function compiledForRuling(c: ChangeUnderTest, instanceId = "p-1") {
  const compiled = ok(
    decodeExit(
      ChangeCodecs.planCompiled,
      await c.stub.planCompiled({
        revision: 1,
        instanceId,
        planHash: PLAN_HASH,
        steps: 1,
        costEstimate: 1,
        needsRuling: true,
      }),
    ),
  );
  // Precheck's `ruling` step, through the adapter its runtime composes.
  await Effect.runPromise(
    askFlowRuling({
      namespace: POOL_ORG,
      project: c.projectId,
      changeId: c.changeId,
      revision: 1,
      instanceId,
    }).pipe(
      Effect.provide(
        Layer.merge(
          HumanGateRpc((address) => env.NAMESPACE.get(env.NAMESPACE.idFromName(address))),
          ChangePrecheckRpc(env.CHANGE),
        ),
      ),
      Effect.orDie,
    ),
  );
  await drainOutbox(namespaceObject());
  return compiled;
}

/** The question as the Projector holds it, once the namespace object's outbox has drained to it. */
const asked = (escalationId: EscalationId) =>
  Effect.runPromise(
    Escalations.use((port) => port.get(escalationId)).pipe(
      Effect.provide(
        EscalationsRpc(
          () => env.PROJECTOR.get(env.PROJECTOR.idFromName(PROJECTOR)),
          (address) => drainAfter(env.NAMESPACE.get(env.NAMESPACE.idFromName(address))),
        ),
      ),
      Effect.orDie,
    ),
  );

/** A ruling through the doorway. */
const rule = (token: string, escalationId: string, key: string, option: string) =>
  worker(`${BASE}/v1/escalations/${escalationId}/ruling`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": key,
    },
    body: JSON.stringify({ option, rationale: "the flow change was read" }),
  });

/** A tool call's answer over MCP: whether it failed, and its structured content or the failure's problem. */
async function tool(token: string, name: string, args: Record<string, unknown>) {
  const result = await mcpResult(await mcp(token, "tools/call", { name, arguments: args }, name));
  const [first] = Array.isArray(result["content"]) ? result["content"] : [];
  const text: unknown =
    typeof first === "object" && first !== null ? Reflect.get(first, "text") : "";
  return {
    isError: result["isError"] === true,
    body: Object(
      result["structuredContent"] ?? (typeof text === "string" ? JSON.parse(text) : undefined),
    ),
  };
}

describe("a change to how Keel verifies, on the real Change and namespace objects", () => {
  it("[flow-ruling.real] parks as Precheck's plan queues it and asks the project's maintainers; a maintainer's approve over the doorway resumes it into the lane, and a refuse bounces another, citing the decision", async () => {
    await using prechecks = await inertPrecheck();
    const projectId = makeId("prj", ulid());
    const [approved, refused] = [
      await changeUnderTest(projectId, "project"),
      await changeUnderTest(projectId, "project"),
    ];
    await seedAgent({ id: approved.agentId, projectId });
    await seedAgent({ id: refused.agentId, projectId });
    const maintainer = await seedUser(uniqueHandle("keeper"), { role: "maintainer" });
    await deriving(approved);
    await deriving(refused);
    await vi.waitFor(async () => expect(await prechecks.get()).toHaveLength(2), WAIT);

    for (const c of [approved, refused])
      expect(await compiledForRuling(c)).toMatchObject({
        state: "parked",
        parkReason: "awaiting-ruling",
        escalationId: flowRulingIdOf(c.changeId, "p-1"),
      });

    const yes = await rule(
      maintainer.token,
      flowRulingIdOf(approved.changeId, "p-1"),
      "flow-approve",
      FLOW_RULING_APPROVE,
    );
    expect(yes.status).toBe(200);
    const no = await rule(
      maintainer.token,
      flowRulingIdOf(refused.changeId, "p-1"),
      "flow-refuse",
      "refuse",
    );
    expect(no.status).toBe(200);
    await drainOutbox(namespaceObject());

    await vi.waitFor(async () => {
      await drainOutbox(approved.stub);
      expect((await approved.current()).state).toBe("queued");
    }, WAIT);
    await vi.waitFor(async () => {
      await drainOutbox(refused.stub);
      const log = await refused.log();
      const bounced = log.find((event) => event.type === "ChangeBounced");
      expect(bounced?.payload).toMatchObject({
        decisionId: decisionIdOf(flowRulingIdOf(refused.changeId, "p-1")),
      });
    }, WAIT);
  });

  it("[flow-ruling.people-only] an agent's token and a change's workspace token are refused a ruling on the doorway as users-only; nothing is ruled", async () => {
    await using prechecks = await inertPrecheck();
    const projectId = makeId("prj", ulid());
    const c = await changeUnderTest(projectId, "project");
    const agent = await seedAgent({ id: c.agentId, projectId });
    const declared = ok(await c.declare(`declare-${c.changeId}`, {}));
    await drainOutbox(c.stub);
    const commitSha = await c.push();
    ok(
      decodeExit(
        ChangeCodecs.submit,
        await c.stub.submit({
          agentId: c.agentId,
          projectId: c.projectId,
          leaseId: heldLease(declared.change).id,
          commitSha,
          idempotencyKey: "s-1",
        }),
      ),
    );
    ok(
      decodeExit(
        ChangeCodecs.precheckStarted,
        await c.stub.precheckStarted({
          revision: 1,
          instanceId: "p-1",
          commitSha: await c.carried(),
        }),
      ),
    );
    await vi.waitFor(async () => expect(await prechecks.get()).toHaveLength(1), WAIT);
    await compiledForRuling(c);
    const escalationId = flowRulingIdOf(c.changeId, "p-1");

    const byAgent = await rule(
      await tokenFor(agent),
      escalationId,
      "agent-ruling-1",
      FLOW_RULING_APPROVE,
    );
    expect([byAgent.status, (await byAgent.json<{ detail: string }>()).detail]).toEqual([
      403,
      "Refused: users-only.",
    ]);
    const byWorkspace = await rule(
      declared.grant.token,
      escalationId,
      "workspace-ruling-1",
      FLOW_RULING_APPROVE,
    );
    expect(byWorkspace.status).toBeGreaterThanOrEqual(401);
    expect(byWorkspace.status).toBeLessThanOrEqual(403);
    expect((await c.current()).state).toBe("parked");
  });

  it("[flow-ruling.mcp] a maintainer signed in as themselves over MCP is told they act as a person, lists the question with its tool and rules on it with another: the change resumes into the lane on a decision that is theirs, and an agent's ruling by the same tool is refused users-only", async () => {
    await using prechecks = await inertPrecheck();
    const projectId = makeId("prj", ulid());
    const c = await changeUnderTest(projectId, "project");
    const agent = await seedAgent({ id: c.agentId, projectId });
    const maintainer = await seedUser(uniqueHandle("keeper"), { role: "maintainer" });
    await deriving(c);
    await vi.waitFor(async () => expect(await prechecks.get()).toHaveLength(1), WAIT);
    await compiledForRuling(c);
    const escalationId = flowRulingIdOf(c.changeId, "p-1");

    const discovered = await mcpResult(await mcp(maintainer.token, "server/discover"));
    expect(discovered["instructions"]).toBe(PERSON_INSTRUCTIONS);
    await vi.waitFor(async () => {
      const listed = await tool(maintainer.token, "Operator_listEscalations", { state: "open" });
      expect(listed.isError).toBe(false);
      expect(listed.body["items"]).toContainEqual(
        expect.objectContaining({ id: escalationId, category: "verification-change" }),
      );
    }, WAIT);

    const ruling = {
      escalationId,
      option: FLOW_RULING_APPROVE,
      rationale: "the flow change was read",
    };
    const byAgent = await tool(await tokenFor(agent), "Operator_giveRuling", {
      ...ruling,
      "idempotency-key": "agent-mcp-ruling-1",
    });
    expect([byAgent.isError, byAgent.body["status"], byAgent.body["detail"]]).toEqual([
      true,
      403,
      "Refused: users-only.",
    ]);
    expect((await c.current()).state).toBe("parked");

    const ruled = await tool(maintainer.token, "Operator_giveRuling", {
      ...ruling,
      "idempotency-key": "person-mcp-ruling-1",
    });
    expect([ruled.isError, ruled.body["id"], ruled.body["state"]]).toEqual([
      false,
      escalationId,
      "ruled",
    ]);
    await drainOutbox(namespaceObject());
    await vi.waitFor(async () => {
      await drainOutbox(c.stub);
      expect((await c.current()).state).toBe("queued");
    }, WAIT);
    const resumed = (await c.log()).find((event) => event.type === "ChangeResumed");
    expect(resumed?.payload).toMatchObject({ decisionId: decisionIdOf(escalationId) });
    await vi.waitFor(async () => {
      await drainOutbox(namespaceObject());
      expect(await asked(escalationId)).toMatchObject({
        escalation: { state: "ruled", ruling: { by: `user:${maintainer.userId}` } },
      });
    }, WAIT);
  });

  it("[flow-ruling.resubmit] a refused change submitted again, at the same revision and commit, is asked again of its new Precheck run: a new open question, which a maintainer's approve answers", async () => {
    await using prechecks = await inertPrecheck();
    const projectId = makeId("prj", ulid());
    const c = await changeUnderTest(projectId, "project");
    await seedAgent({ id: c.agentId, projectId });
    const maintainer = await seedUser(uniqueHandle("keeper"), { role: "maintainer" });
    const lease = heldLease(ok(await c.declare(`declare-${c.changeId}`, {})).change).id;
    await drainOutbox(c.stub);
    const commitSha = await c.push();
    const submitted = async (key: string, instanceId: string) => {
      ok(
        decodeExit(
          ChangeCodecs.submit,
          await c.stub.submit({
            agentId: c.agentId,
            projectId: c.projectId,
            leaseId: lease,
            commitSha,
            idempotencyKey: key,
          }),
        ),
      );
      ok(
        decodeExit(
          ChangeCodecs.precheckStarted,
          await c.stub.precheckStarted({ revision: 1, instanceId, commitSha: await c.carried() }),
        ),
      );
    };
    await submitted("s-1", "p-1");
    await vi.waitFor(async () => expect(await prechecks.get()).toHaveLength(1), WAIT);
    await compiledForRuling(c, "p-1");
    const first = flowRulingIdOf(c.changeId, "p-1");
    expect((await rule(maintainer.token, first, "flow-refuse-1", "refuse")).status).toBe(200);
    await drainOutbox(namespaceObject());
    await vi.waitFor(async () => {
      await drainOutbox(c.stub);
      expect((await c.current()).state).toBe("bounced");
    }, WAIT);

    await submitted("s-2", "p-2");
    await vi.waitFor(async () => expect(await prechecks.get()).toHaveLength(2), WAIT);
    const again = flowRulingIdOf(c.changeId, "p-2");
    expect(again).not.toBe(first);
    expect(await compiledForRuling(c, "p-2")).toMatchObject({
      state: "parked",
      parkReason: "awaiting-ruling",
      escalationId: again,
    });
    await vi.waitFor(async () => {
      await drainOutbox(namespaceObject());
      expect(await asked(again)).toMatchObject({
        project: projectId,
        escalation: { state: "open", category: "verification-change" },
      });
    }, WAIT);
    expect(
      (await rule(maintainer.token, again, "flow-approve-2", FLOW_RULING_APPROVE)).status,
    ).toBe(200);
    await drainOutbox(namespaceObject());
    await vi.waitFor(async () => {
      await drainOutbox(c.stub);
      expect((await c.current()).state).toBe("queued");
    }, WAIT);
  });
});
