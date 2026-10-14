import { env } from "cloudflare:workers";
import type { FlowPlan } from "@keeltown/core/domain/verification";
import { EventEnvelope, makeId, type ProjectId } from "@keeltown/core/kernel";
import { PlanStore } from "@keeltown/core/ports";
import { guardedPlan, TEST_DECISION } from "@keeltown/testing";
import { Effect, Schema } from "effect";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { PlanStoreR2 } from "../../src/adapters/driven/r2/plan-store.ts";
import {
  BASE,
  POOL_ORG,
  seedAgent,
  seedForeignAgent,
  seedUser,
  tokenFor,
  uniqueHandle,
  worker,
} from "./helpers.ts";
import { project as heldProject } from "./project-harness.ts";

/** The one Projector every object's outbox delivers to. */
const projector = () => env.PROJECTOR.get(env.PROJECTOR.idFromName("projector"));

/** A verdict issued in `project`, delivered to the Projector as the lane's outbox would. */
async function issue(project: ProjectId, evidence: readonly string[], planHash?: string) {
  const verdictId = makeId("vrd", ulid());
  const event = Schema.decodeUnknownSync(EventEnvelope)({
    eventId: makeId("evt", ulid()),
    type: "VerdictIssued",
    entity: { kind: "verdict", id: verdictId },
    seq: 1,
    at: Date.UTC(2026, 9, 14, 4),
    dedupeKey: `verdict:${verdictId}/verdicts-test/VerdictIssued#1`,
    project,
    affected: [],
    notified: [],
    payload: {
      _tag: "VerdictIssued",
      verdictId,
      subject: makeId("bat", ulid()),
      outcome: "bounce",
      evidence,
      ...(planHash === undefined ? {} : { planHash }),
    },
  });
  await projector().receive([Schema.encodeSync(EventEnvelope)(event)]);
  return verdictId;
}

const stored = async (plan: FlowPlan): Promise<FlowPlan> => {
  await Effect.runPromise(
    PlanStore.use((plans) => plans.put(POOL_ORG, plan)).pipe(
      Effect.provide(PlanStoreR2(env.ARCHIVE)),
    ),
  );
  return plan;
};

async function verdict(verdictId: string, token: string) {
  const response = await worker(`${BASE}/v1/verdicts/${verdictId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: response.status, body: await response.json<Record<string, unknown>>() };
}

describe("GET /v1/verdicts/{verdictId}", () => {
  it("[verdict.route] serves a verdict to its project's agent and to a member who reads the project: each line classed by its step, and the plan it was issued under", async () => {
    const { projectId } = await heldProject();
    const plan = await stored(guardedPlan("advise", TEST_DECISION));
    const guard = plan.steps.find((s) => s.guards !== undefined);
    if (guard === undefined) throw new Error("the plan guards nothing");
    const cited = `guard failed: ${guard.id} (freshness): subject GET /me -> 200 (expected 401)`;
    const verdictId = await issue(projectId, [cited, "failed: test/a.test.ts > a"], plan.planHash);
    const agent = await tokenFor(await seedAgent({ projectId }));
    const member = (await seedUser(uniqueHandle("member"))).token;
    for (const token of [agent, member]) {
      const read = await verdict(verdictId, token);
      expect(read.status).toBe(200);
      expect(read.body).toMatchObject({
        id: verdictId,
        outcome: "bounce",
        issuedAt: new Date(Date.UTC(2026, 9, 14, 4)).toISOString(),
        reasons: [
          { line: cited, step: guard.id, class: guard.effectiveClass ?? guard.evidenceCeiling },
          { line: "failed: test/a.test.ts > a", class: "proof" },
        ],
        plan: {
          hash: plan.planHash,
          steps: plan.steps.map((s) => ({
            id: s.id,
            kind: s.kind,
            tier: s.tier.tier,
            tierReason: s.tier.reason,
            evidenceCeiling: s.evidenceCeiling,
            because: s.because,
          })),
        },
      });
      const steps = Reflect.get(Object(read.body["plan"]), "steps");
      expect(
        Array.isArray(steps) ? steps.find((s) => Reflect.get(Object(s), "id") === guard.id) : null,
      ).toMatchObject({
        guards: {
          predicate: "freshness",
          policy: "block",
          probe: guard.guards?.probe,
          decision: { id: TEST_DECISION.id, summary: TEST_DECISION.summary },
        },
      });
    }
  });

  it("[verdict.route-unplanned] serves a verdict reached with no plan, or whose plan is not stored, without one", async () => {
    const { projectId } = await heldProject();
    const agent = await tokenFor(await seedAgent({ projectId }));
    const unplanned = await issue(projectId, ["refused: no flow"]);
    const unstored = await issue(projectId, ["refused: gone"], `sha256:${"e".repeat(64)}`);
    for (const verdictId of [unplanned, unstored]) {
      const read = await verdict(verdictId, agent);
      expect(read.status).toBe(200);
      expect(read.body["plan"]).toBeUndefined();
      expect(read.body["reasons"]).toEqual([
        { line: verdictId === unplanned ? "refused: no flow" : "refused: gone", class: "proof" },
      ]);
    }
  });

  it("[verdict.route-hidden] answers a verdict in a project the caller cannot read, and one that does not exist, 404 alike", async () => {
    const { projectId } = await heldProject();
    const verdictId = await issue(projectId, ["failed: x"]);
    const outsider = await tokenFor(await seedForeignAgent());
    const hidden = await verdict(verdictId, outsider);
    const missing = await verdict(makeId("vrd", ulid()), outsider);
    for (const read of [hidden, missing]) {
      expect(read.status).toBe(404);
      expect(read.body).toMatchObject({ code: "verdict.not_found" });
    }
  });
});
