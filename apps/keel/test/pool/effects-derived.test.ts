// What Precheck derives, through real objects: `ChangePrecheck.derived` over
// the Change DO's RPC commits EffectsDerived, and the Subject DOs it names
// hear it through the fan-out and judge its effects against what they hold.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  conflictIdOf,
  PROBE_WORKFLOW,
  subjectAddress,
  subjectIdOf,
} from "@keeltown/core/application/coordination";
import { DerivedEffect, Proposition, SubjectKey } from "@keeltown/core/domain/coordination";
import { type EntityRef, type EventEnvelope, makeId, type ProjectId } from "@keeltown/core/kernel";
import { ChangePrecheck, EventOutbox, type PrecheckDerived } from "@keeltown/core/ports";
import { CodeHostFixture } from "@keeltown/testing";
import { Effect, Schema } from "effect";
import { ulid } from "ulid";
import { describe, expect, it, vi } from "vitest";
import type { SubjectDO } from "../../src/adapters/driving/do/subject.ts";
import { ChangePrecheckRpc } from "../../src/adapters/driven/do-rpc/change-precheck.ts";
import { ChangeCodecs, decodeExit } from "../../src/rpc/index.ts";
import { type ChangeUnderTest, changeUnderTest, ok } from "./change-harness.ts";
import { drainAfter, drainOutbox } from "./helpers.ts";
import { inertPrecheck } from "./inert-precheck.ts";
import { inertProbe } from "./inert-probe.ts";

const WAIT = { timeout: 10_000, interval: 20 };

const key = (value: string) => Schema.decodeUnknownSync(SubjectKey)(value);
const LEAF = key("authz.permission-evaluation");
const ROOT = key("authz");
const BILLING = key("billing.invoice-total");

const relied = Schema.decodeUnknownSync(Proposition)({
  subject: LEAF,
  predicate: "freshness",
  relation: "at-most",
  value: "per-request",
});
const billed = Schema.decodeUnknownSync(Proposition)({
  subject: BILLING,
  predicate: "freshness",
  relation: "is",
  value: "per-request",
});
/** What an extractor rules the change's code does to the leaf's freshness: nothing its intent declared. */
const derivedAtLeaf = (value: "per-request" | "per-session") => {
  const anchors = [{ path: "src/authz/evaluate.ts", symbol: "evaluate", commit: "c".repeat(40) }];
  return Schema.decodeUnknownSync(DerivedEffect)({
    proposition: { subject: LEAF, predicate: "freshness", relation: "is", value, anchors },
    anchors,
    declared: false,
    method: "extractor",
    evidenceClass: "ruling",
  });
};

/** Precheck's way to the change, as its Workflow composes it: the Change DO over RPC. */
const precheck = <A, E>(
  use: (changes: (typeof ChangePrecheck)["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.runPromise(
    Effect.result(ChangePrecheck.use(use)).pipe(Effect.provide(ChangePrecheckRpc(env.CHANGE))),
  );
const derivation = (
  instanceId: string,
  effects: readonly DerivedEffect[],
  revision = 1,
): PrecheckDerived => ({
  revision,
  instanceId,
  effects,
  derivationRef: `derivation-${instanceId}`,
});
/** The tag a Precheck call was refused with, or "ok". */
const outcomeOf = (result: {
  readonly _tag: string;
  readonly failure?: { readonly _tag: string };
}) => result.failure?._tag ?? "ok";

const subjectStub = (projectId: ProjectId, subject: SubjectKey) =>
  drainAfter(env.SUBJECT.get(env.SUBJECT.idFromName(subjectAddress(projectId, subject))));

/** What the subject committed about one entity, from its own outbox. */
const logAt = (projectId: ProjectId, subject: SubjectKey, entity: EntityRef) =>
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

const submitted = async (
  c: ChangeUnderTest,
  leaseId: string,
  commitSha: string,
  idempotencyKey: string,
) =>
  ok(
    decodeExit(
      ChangeCodecs.submit,
      await c.stub.submit({ agentId: c.agentId, leaseId, commitSha, idempotencyKey }),
    ),
  );
const submit = async (c: ChangeUnderTest, leaseId: string, idempotencyKey: string) =>
  submitted(c, leaseId, await c.push(), idempotencyKey);

/** The agent's next commit on the workspace it already pushed to: new code under the same intent. */
const pushAgain = async (c: ChangeUnderTest) => {
  const held = ok(decodeExit(ChangeCodecs.workspace, await c.stub.workspace()));
  return Effect.runPromise(
    Effect.flatMap(CodeHostFixture, (fixture) =>
      fixture.commit(held.repo, "refs/heads/main", { "a.txt": "a, fixed" }),
    ).pipe(Effect.provide(c.code.layer)),
  );
};

/** Declares `c` naming billing only, submits it, and starts its Precheck pass by hand as `instanceId`. */
const deriving = async (c: ChangeUnderTest, instanceId: string) => {
  const lease = ok(await c.declare(`declare-${c.changeId}`, { declaredEffects: [billed] })).change
    .lease.id;
  await submit(c, lease, "submit-1");
  expect(outcomeOf(await precheck((p) => p.started(c.changeId, { revision: 1, instanceId })))).toBe(
    "ok",
  );
  return lease;
};

const derivedIn = async (c: ChangeUnderTest) =>
  (await c.log()).filter((event) => event.type === "EffectsDerived");

describe("[b21.fallout-derived] an effect Precheck derives, at a subject the change never named", () => {
  it("[b21.fallout-derived] an undeclared effect that breaks a neighbour's premise: EffectsDerived names the subject, which hears it and opens one conflict naming both, and its Probe starts", async () => {
    await using held = await inertPrecheck();
    await using probes = await inertProbe();
    const { projectId, change } = await project();
    const [a, b] = [await change(), await change()];
    ok(await a.declare(`declare-${a.changeId}`, { premises: [relied] }));
    await drainOutbox(a.stub);
    await deriving(b, "p-1");
    const effect = derivedAtLeaf("per-session");

    expect(
      outcomeOf(await precheck((p) => p.derived(b.changeId, derivation("p-1", [effect])))),
    ).toBe("ok");
    await drainOutbox(b.stub);

    const [recorded] = await derivedIn(b);
    expect(recorded).toMatchObject({
      affected: [{ kind: "subject", id: subjectIdOf(projectId, LEAF) }],
      payload: { revision: 1, derivationRef: "derivation-p-1", effects: [{ method: "extractor" }] },
    });
    expect(recorded?.notified).toEqual(
      expect.arrayContaining([subjectAddress(projectId, LEAF), subjectAddress(projectId, ROOT)]),
    );
    const conflictId = conflictIdOf(projectId, {
      premise: { holder: a.changeId, proposition: relied },
      effect: { changeId: b.changeId, proposition: effect.proposition },
    });
    const atLeaf = await logAt(projectId, LEAF, { kind: "conflict", id: conflictId });
    expect(atLeaf.map((event) => event.type)).toEqual(["ConflictSuspected"]);
    expect(await logAt(projectId, ROOT, { kind: "conflict", id: conflictId })).toEqual([]);
    const [opened] = atLeaf;
    expect(opened?.payload).toMatchObject({
      conflictId,
      subjectKey: LEAF,
      parties: [a.changeId, b.changeId],
      origin: "fallout",
      premise: { holder: a.changeId },
      effect: { changeId: b.changeId, proposition: { anchors: effect.anchors } },
    });
    expect(opened?.notified).toEqual(
      expect.arrayContaining([PROBE_WORKFLOW, `change:${a.changeId}`, `change:${b.changeId}`]),
    );
    // The fan-out starts the conflict's Probe, held inert here.
    await vi.waitFor(async () => expect(await probes.get()).toHaveLength(1), WAIT);
    await vi.waitFor(async () => expect(await held.get()).toHaveLength(1), WAIT);
  });

  it("[b21.fallout-derived] a derived effect the premise allows opens nothing: the subject hears it, tells the holder, and no conflict exists", async () => {
    await using held = await inertPrecheck();
    const { projectId, change } = await project();
    const [a, b] = [await change(), await change()];
    ok(await a.declare(`declare-${a.changeId}`, { premises: [relied] }));
    await drainOutbox(a.stub);
    await deriving(b, "p-1");
    const effect = derivedAtLeaf("per-request");

    expect(
      outcomeOf(await precheck((p) => p.derived(b.changeId, derivation("p-1", [effect])))),
    ).toBe("ok");
    await drainOutbox(b.stub);

    const subject = await logAt(projectId, LEAF, {
      kind: "subject",
      id: subjectIdOf(projectId, LEAF),
    });
    // The subject did hear the derivation: it told the premise's holder its premise is touched.
    expect(subject.map((event) => event.type)).toContain("PremiseSuspected");
    const conflictId = conflictIdOf(projectId, {
      premise: { holder: a.changeId, proposition: relied },
      effect: { changeId: b.changeId, proposition: effect.proposition },
    });
    expect(await logAt(projectId, LEAF, { kind: "conflict", id: conflictId })).toEqual([]);
    await vi.waitFor(async () => expect(await held.get()).toHaveLength(1), WAIT);
  });
});

describe("[b21.effects-derived] Precheck records what it derived, once a pass", () => {
  it("[b21.effects-derived] a replay commits nothing new, a second derivation in the pass is refused, and the next pass of the same revision derives again", async () => {
    await using held = await inertPrecheck();
    const { change } = await project();
    const c = await change();
    const lease = await deriving(c, "p-1");
    const first = derivation("p-1", [derivedAtLeaf("per-session")]);

    const outcomes = [
      outcomeOf(await precheck((p) => p.derived(c.changeId, first))),
      outcomeOf(await precheck((p) => p.derived(c.changeId, first))),
      outcomeOf(await precheck((p) => p.derived(c.changeId, derivation("p-2", [])))),
    ];
    expect(outcomes).toEqual(["ok", "ok", "ChangeStateRefused"]);
    expect(await derivedIn(c)).toHaveLength(1);

    // Bounced and submitted again with new code: the same revision, a new pass.
    const refused = await precheck((p) =>
      p.refused(c.changeId, {
        revision: 1,
        instanceId: "p-1",
        reasons: ["precheck:protected:src/secret.ts (src/secret*)"],
        nextActions: [{ kind: "call", title: "Submit again", operationId: "submit" }],
      }),
    );
    expect(outcomeOf(refused)).toBe("ok");
    await submitted(c, lease, await pushAgain(c), "submit-2");
    const again = [
      outcomeOf(await precheck((p) => p.started(c.changeId, { revision: 1, instanceId: "p-3" }))),
      outcomeOf(await precheck((p) => p.derived(c.changeId, derivation("p-3", [])))),
    ];
    expect(again).toEqual(["ok", "ok"]);
    const derived = await derivedIn(c);
    expect(derived.map((event) => Reflect.get(Object(event.payload), "revision"))).toEqual([1, 1]);
    expect(derived.map((event) => Reflect.get(Object(event.payload), "derivationRef"))).toEqual([
      "derivation-p-1",
      "derivation-p-3",
    ]);
    await drainOutbox(c.stub);
    await vi.waitFor(async () => expect(await held.get()).toHaveLength(2), WAIT);
  });

  it("[b21.effects-derived] refused before the pass starts, for a stale revision, and for a change never declared: nothing is recorded", async () => {
    await using held = await inertPrecheck();
    const { change } = await project();
    const c = await change();
    const lease = ok(await c.declare(`declare-${c.changeId}`, { declaredEffects: [billed] })).change
      .lease.id;
    await submit(c, lease, "submit-1");
    const effects = [derivedAtLeaf("per-session")];

    const early = await precheck((p) => p.derived(c.changeId, derivation("p-1", effects)));
    await precheck((p) => p.started(c.changeId, { revision: 1, instanceId: "p-1" }));
    const stale = await precheck((p) => p.derived(c.changeId, derivation("p-1", effects, 2)));
    const unknown = await precheck((p) =>
      p.derived(makeId("chg", ulid()), derivation("p-1", effects)),
    );
    expect([early, stale, unknown].map(outcomeOf)).toEqual([
      "ChangeStateRefused",
      "ChangeStateRefused",
      "ChangeNotFound",
    ]);
    expect(await derivedIn(c)).toEqual([]);
    // The stale call moved nothing: the current revision still derives.
    expect(
      outcomeOf(await precheck((p) => p.derived(c.changeId, derivation("p-1", effects)))),
    ).toBe("ok");
    await drainOutbox(c.stub);
    await vi.waitFor(async () => expect(await held.get()).toHaveLength(1), WAIT);
  });

  it("[b21.workspace-intent] the workspace Precheck reads carries the change's current intent", async () => {
    await using held = await inertPrecheck();
    const { change } = await project();
    const c = await change();
    const lease = ok(await c.declare(`declare-${c.changeId}`, { declaredEffects: [billed] })).change
      .lease.id;
    await submit(c, lease, "submit-1");
    const workspace = await precheck((p) => p.workspace(c.changeId));
    expect(workspace).toMatchObject({
      success: { subjects: [BILLING], intent: (await c.current()).intent },
    });
    expect((await c.current()).intent.declaredEffects).toMatchObject([{ subject: BILLING }]);
    await vi.waitFor(async () => expect(await held.get()).toHaveLength(1), WAIT);
  });
});
