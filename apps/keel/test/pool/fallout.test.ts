// Fallout through real objects: each change is the harness's real Change DO,
// and the subjects its premises and effects name are real Subject DOs, which
// hear its declare through the fan-out and judge what they hold.
import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import {
  conflictIdOf,
  PROBE_WORKFLOW,
  subjectAddress,
} from "@keeltown/core/application/coordination";
import { LEASE_TTL_MS, Proposition, SubjectKey } from "@keeltown/core/domain/coordination";
import { type EventEnvelope, makeId, type ProjectId } from "@keeltown/core/kernel";
import { EventOutbox } from "@keeltown/core/ports";
import { Effect, Schema } from "effect";
import { ulid } from "ulid";
import { describe, expect, it, vi } from "vitest";
import type { SubjectDO } from "../../src/adapters/driving/do/subject.ts";
import { type ChangeUnderTest, changeUnderTest, ok } from "./change-harness.ts";
import { BASE, drainAfter, drainOutbox, seedAgent, tokenFor } from "./helpers.ts";
import { inertProbe } from "./inert-probe.ts";

const key = (value: string) => Schema.decodeUnknownSync(SubjectKey)(value);
const LEAF = key("authz.permission-evaluation");
const ROOT = key("authz");

const premiseOf = (strength?: "should") =>
  Schema.decodeUnknownSync(Proposition)({
    subject: LEAF,
    predicate: "freshness",
    relation: "at-most",
    value: "per-request",
    ...(strength === undefined ? {} : { strength }),
  });
const cachedPerSession = Schema.decodeUnknownSync(Proposition)({
  subject: LEAF,
  predicate: "freshness",
  relation: "is",
  value: "per-session",
});

const subjectStub = (projectId: ProjectId, subject: SubjectKey) =>
  drainAfter(env.SUBJECT.get(env.SUBJECT.idFromName(subjectAddress(projectId, subject))));

/** What the subject committed about one entity, from its own outbox. */
const logAt = (
  projectId: ProjectId,
  subject: SubjectKey,
  entity: { kind: "conflict"; id: string },
) =>
  runInDurableObject(
    subjectStub(projectId, subject),
    (instance: SubjectDO): Promise<readonly EventEnvelope[]> =>
      instance["runtime"].runPromise(Effect.map(EventOutbox, (outbox) => outbox.log(entity))),
  );

/** A fresh project whose changes read its real index. */
async function project() {
  const projectId: ProjectId = makeId("prj", ulid());
  return { projectId, change: () => changeUnderTest(projectId, "project") };
}

const declared = async (c: ChangeUnderTest, intent: Parameters<ChangeUnderTest["declare"]>[1]) => {
  ok(await c.declare(`declare-${c.changeId}`, intent));
  await drainOutbox(c.stub);
};

const inbox = async (token: string) => {
  const response = await exports.default.fetch(`${BASE}/v1/inbox`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  return (await response.json<{ result: { notices: { kind: string; ref?: string }[] } }>()).result
    .notices;
};
const suspected = (notices: readonly { kind: string }[]) =>
  notices.filter((n) => n.kind === "PremiseSuspected");

describe("[b21.fallout-race] a premise and an effect that breaks it, in either order", () => {
  for (const order of ["premise first", "effect first"] as const)
    it(`[b21.fallout-race] [b21.probe-start] [b21.conflict-subject-key] ${order}: one conflict, its id from the pair, at the leaf only, with the Probe Workflow and both parties notified`, async () => {
      await using probes = await inertProbe();
      const { projectId, change } = await project();
      const [a, b] = [await change(), await change()];
      if (order === "premise first") {
        await declared(a, { premises: [premiseOf()] });
        await declared(b, { declaredEffects: [cachedPerSession] });
      } else {
        await declared(b, { declaredEffects: [cachedPerSession] });
        await declared(a, { premises: [premiseOf()] });
      }
      const conflictId = conflictIdOf(projectId, {
        premise: { holder: a.changeId, proposition: premiseOf() },
        effect: { changeId: b.changeId, proposition: cachedPerSession },
      });
      const atLeaf = await logAt(projectId, LEAF, { kind: "conflict", id: conflictId });
      const atRoot = await logAt(projectId, ROOT, { kind: "conflict", id: conflictId });
      expect(atLeaf.map((e) => e.type)).toEqual(["ConflictSuspected"]);
      expect(atRoot).toEqual([]);
      const [opened] = atLeaf;
      expect(opened?.payload).toMatchObject({
        conflictId,
        kind: "semantic",
        subjectKey: LEAF,
        parties: [a.changeId, b.changeId],
        origin: "fallout",
        premise: { holder: a.changeId },
        effect: {
          changeId: b.changeId,
          evidence: { declared: true, evidenceClass: "testimony" },
        },
      });
      expect(opened?.notified).toEqual(
        expect.arrayContaining([PROBE_WORKFLOW, `change:${a.changeId}`, `change:${b.changeId}`]),
      );
      // The fan-out starts the conflict's Probe, held inert here.
      await vi.waitFor(async () => expect(await probes.get()).toHaveLength(1), {
        timeout: 10_000,
        interval: 50,
      });
    });
});

describe("[b21.premise-suspected] a should premise an effect contradicts", () => {
  it("[b21.premise-suspected] its holder's agent is told, and after an adopt the adopter is told instead", async () => {
    const { projectId, change } = await project();
    const a = await change();
    await declared(a, { premises: [premiseOf("should")] });
    const b = await change();
    await declared(b, { declaredEffects: [cachedPerSession] });
    await drainOutbox(subjectStub(projectId, LEAF));
    const original = await tokenFor(await seedAgent({ id: a.agentId, projectId }));
    expect(suspected(await inbox(original))).toHaveLength(1);

    const adopter = await tokenFor(await seedAgent({ projectId }));
    a.clock.advance(LEASE_TTL_MS);
    const adopted = await exports.default.fetch(`${BASE}/v1/changes/${a.changeId}/adopt`, {
      method: "POST",
      headers: { authorization: `Bearer ${adopter}`, "idempotency-key": "adopt-key-0001" },
    });
    expect(adopted.status).toBe(200);
    await drainOutbox(a.stub);
    const c = await change();
    await declared(c, { declaredEffects: [cachedPerSession] });
    await drainOutbox(subjectStub(projectId, LEAF));
    expect({
      adopter: suspected(await inbox(adopter)),
      original: suspected(await inbox(original)),
    }).toMatchObject({ adopter: [{ kind: "PremiseSuspected" }], original: [{}] });
  });
});
