import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  DRAFT_REPAIRS,
  type DraftContext,
  draftProbe,
  FRESHNESS_SCHEMA,
  FRESHNESS_TEMPLATE,
  type FreshnessSlots,
  MATRIX_WORLDS,
  type ProbeRun,
} from "../../../src/application/verification/index.ts";
import {
  PlatformFunction,
  type PlatformFunctionCall,
  ProbeRunner,
  type ProbeRunRequest,
  ProbeStore,
} from "../../../src/application/ports/index.ts";
import { Proposition } from "../../../src/domain/coordination/index.ts";
import { ContentHash } from "../../../src/domain/kernel/index.ts";
import {
  ModelAbstained,
  type ProbeOutcome,
  type World,
} from "../../../src/domain/verification/index.ts";
import { fc } from "../../support/fast-check.ts";

const hash = (n: number) =>
  Schema.decodeUnknownSync(ContentHash)(`sha256:${String(n).padStart(64, "0")}`);
const WORLDS: Readonly<Record<World, ContentHash>> = {
  trunk: hash(10),
  A: hash(11),
  B: hash(12),
  AB: hash(13),
  "A-noop": hash(14),
};

const proposition = (value: string) =>
  Schema.decodeUnknownSync(Proposition)({
    subject: "authz.permission-evaluation",
    predicate: "freshness",
    relation: "at-most",
    value,
  });

const CONTEXT: DraftContext = {
  premise: proposition("per-request"),
  effect: proposition("per-session"),
  anchors: ["src/authz/require-permission.ts#requirePermission"],
  source: [
    { path: "src/app.ts", text: "export const createApp = () => {};" },
    { path: "src/authz/require-permission.ts", text: "export const requirePermission = () => {};" },
  ],
  hunks: {
    A: "+ app.delete('/repos/:owner/:repo/collaborators/:username')",
    B: "+ const cache = new Map();",
  },
};

/** S-1's slots, as scenarios/s1/probe.test.ts makes its calls. */
const good = (rationale = "revoked mid-session"): FreshnessSlots => ({
  owner: "alice",
  subject: "bob",
  setup: [
    {
      actor: "owner",
      method: "POST",
      path: "/repos",
      body: '{"name":"forge","visibility":"public"}',
      expectedStatus: 201,
    },
    {
      actor: "owner",
      method: "PUT",
      path: "/repos/alice/forge/collaborators/bob",
      body: '{"role":"admin"}',
      expectedStatus: 201,
    },
  ],
  call: {
    actor: "subject",
    method: "GET",
    path: "/repos/alice/forge",
    body: "",
    expectedStatus: 200,
  },
  revoke: {
    actor: "owner",
    method: "DELETE",
    path: "/repos/alice/forge/collaborators/bob",
    body: "",
    expectedStatus: 204,
  },
  callAgain: {
    actor: "subject",
    method: "DELETE",
    path: "/repos/alice/forge",
    body: "",
    expectedStatus: 403,
  },
  rationale,
});
/** Slots the template refuses, with the text it refuses them with. */
const BAD = { ...good(), owner: "Alice" };
const BAD_TEXT = "owner must be a lowercase username";

const ran = (outcome: ProbeOutcome, reason: string = outcome): ProbeRun => ({
  _tag: "ran",
  outcome,
  reason,
  observations: [],
});
const DISCRIMINATING: Readonly<Record<World, ProbeOutcome>> = {
  trunk: "n/a",
  A: "pass",
  B: "n/a",
  AB: "fail",
  "A-noop": "fail",
};
/** The matrix of a probe that tests the premise. */
const discriminates = (world: World): ProbeRun => ran(DISCRIMINATING[world]);

/** A reply that makes the scripted model abstain. */
const ABSTAIN = Symbol("abstain");
/** What the model replies on call `n` (1-based): slots, or ABSTAIN. */
type Script = (n: number) => unknown;
/** What the runner answers for a probe put on attempt `attempt`. */
type Matrix = (attempt: number, world: World, run: number) => ProbeRun;

/**
 * draftProbe's world: a scripted model, a store that numbers each probe put
 * by attempt, and a runner that answers by that attempt.
 */
function drafting(script: Script, matrix: Matrix) {
  const calls: PlatformFunctionCall[] = [];
  const requests: ProbeRunRequest[] = [];
  const attemptOf = new Map<string, number>();
  let puts = 0;
  const layer = Layer.mergeAll(
    Layer.succeed(
      PlatformFunction,
      PlatformFunction.of({
        call: (call) =>
          Effect.suspend(() => {
            calls.push(call);
            const reply = script(calls.length);
            return reply === ABSTAIN
              ? Effect.fail(new ModelAbstained({ reason: "timeout" }))
              : Effect.succeed(reply);
          }),
      }),
    ),
    Layer.succeed(
      ProbeStore,
      ProbeStore.of({
        put: (files) =>
          Effect.sync(() => {
            puts += 1;
            const probe = hash(1000 + puts);
            attemptOf.set(probe, calls.length);
            expect(files.map((f) => f.path)).toEqual([".keel/freshness.test.ts"]);
            return probe;
          }),
      }),
    ),
    Layer.succeed(
      ProbeRunner,
      ProbeRunner.of({
        run: (request) =>
          Effect.sync(() => {
            requests.push(request);
            return matrix(attemptOf.get(request.probe) ?? 0, request.world, request.run);
          }),
      }),
    ),
  );
  const run = () =>
    Effect.runPromise(draftProbe(FRESHNESS_TEMPLATE, CONTEXT, WORLDS).pipe(Effect.provide(layer)));
  const promptOf = (n: number) => String(calls[n - 1]?.input["prompt"]);
  return { calls, requests, run, promptOf };
}

describe("draftProbe: template first, repaired from deterministic text only", () => {
  it("[draft.first-admitted] admits a first draft that discriminates, after one call and one matrix", async () => {
    const d = drafting(
      () => good(),
      (_, world) => discriminates(world),
    );
    const outcome = await d.run();
    expect(outcome).toMatchObject({ _tag: "Admitted", probe: hash(1001), attempts: 1 });
    expect(d.calls).toHaveLength(1);
    expect(d.calls[0]).toMatchObject({
      name: "keel.probe.freshness",
      outputSchema: FRESHNESS_SCHEMA,
    });
    expect(d.requests).toHaveLength(15);
    expect(d.promptOf(1)).not.toContain("Your earlier replies failed");
  });

  it("[draft.slot-repair] repairs slots the template refuses with its own text, and never runs them", async () => {
    const d = drafting(
      (n) => (n === 1 ? BAD : good()),
      (_, world) => discriminates(world),
    );
    const outcome = await d.run();
    expect(outcome).toMatchObject({ _tag: "Admitted", attempts: 2 });
    expect(d.promptOf(2)).toContain(`- attempt 1: slots: ${BAD_TEXT}`);
    // Only the second draft reached the runner: a bad slot is never a cell.
    expect(d.requests).toHaveLength(15);
    expect(new Set(d.requests.map((r) => r.probe))).toEqual(new Set([hash(1001)]));
  });

  it("[draft.harness-repair] repairs a harness error, naming every world and run that gave it", async () => {
    const reason = "the probe did not bundle: Could not resolve ../src/missing.ts";
    const d = drafting(
      () => good(),
      (attempt, world) =>
        attempt === 1 && world === "B"
          ? { _tag: "harness-error", reason, observations: [] }
          : discriminates(world),
    );
    const outcome = await d.run();
    // B does not decide admission: without the harness check the first draft would have been admitted.
    expect(outcome).toMatchObject({ _tag: "Admitted", attempts: 2 });
    expect(d.promptOf(2)).toContain(`- attempt 1: harness error in B#1, B#2, B#3: ${reason}`);
  });

  it("[draft.identical-fail-repair] feeds back a failure identical in every world as non-discriminating", async () => {
    const reason = "AssertionError: expected 201 to be 200 // Object.is equality";
    const d = drafting(
      () => good(),
      (attempt, world) => (attempt === 1 ? ran("fail", reason) : discriminates(world)),
    );
    const outcome = await d.run();
    expect(outcome).toMatchObject({ _tag: "Admitted", attempts: 2 });
    expect(d.promptOf(2)).toContain(
      `- attempt 1: non-discriminating: every world failed with ${JSON.stringify(reason)}`,
    );
  });

  it("[draft.bounded] stops after DRAFT_REPAIRS repairs: 1 + 3 calls, then discards", async () => {
    const d = drafting(
      () => BAD,
      (_, world) => discriminates(world),
    );
    const outcome = await d.run();
    expect(1 + DRAFT_REPAIRS).toBe(4);
    expect(d.calls).toHaveLength(4);
    expect(outcome).toEqual({
      _tag: "Discarded",
      reason: "repairs-exhausted",
      attempts: 4,
      feedback: [1, 2, 3, 4].map((n) => `attempt ${n}: slots: ${BAD_TEXT}`),
    });
  });

  it("[draft.bounded] never calls the model more than 1 + DRAFT_REPAIRS times, whatever it replies", async () => {
    const reply = fc.constantFrom<"good" | "bad" | "identical" | "harness">(
      "good",
      "bad",
      "identical",
      "harness",
    );
    await fc.assert(
      fc.asyncProperty(fc.array(reply, { minLength: 1, maxLength: 8 }), async (kinds) => {
        const kindOf = (n: number) => kinds[Math.min(n, kinds.length) - 1] ?? "bad";
        const d = drafting(
          (n) => (kindOf(n) === "bad" ? BAD : good()),
          (attempt, world) => {
            const kind = kindOf(attempt);
            if (kind === "identical") return ran("fail", "setup broke");
            if (kind === "harness")
              return { _tag: "harness-error", reason: "two tests", observations: [] };
            return discriminates(world);
          },
        );
        const outcome = await d.run();
        expect(d.calls.length).toBeLessThanOrEqual(1 + DRAFT_REPAIRS);
        expect(outcome.attempts).toBe(d.calls.length);
        const firstGood = kinds.slice(0, 1 + DRAFT_REPAIRS).indexOf("good");
        expect(outcome._tag).toBe(firstGood === -1 ? "Discarded" : "Admitted");
      }),
    );
  });

  it("[draft.vacuous-discarded] discards a probe that passes everywhere, without a repair", async () => {
    const d = drafting(
      () => good(),
      () => ran("pass"),
    );
    const outcome = await d.run();
    expect(outcome).toMatchObject({ _tag: "Discarded", reason: "non-discriminating", attempts: 1 });
    expect(d.calls).toHaveLength(1);
  });

  it("[draft.abstained] ends when the model abstains, with nothing run and no repair", async () => {
    const d = drafting(
      () => ABSTAIN,
      (_, world) => discriminates(world),
    );
    expect(await d.run()).toEqual({ _tag: "Abstained", reason: "timeout", attempts: 1 });
    expect(d.calls).toHaveLength(1);
    expect(d.requests).toHaveLength(0);
  });

  it("[draft.feedback-deterministic] never feeds the model's own rationale back", async () => {
    const marker = "MARKER-rationale-7f3a";
    const d = drafting(
      (n) => good(n === 1 ? marker : "second"),
      (attempt, world) => (attempt === 1 ? ran("fail", "setup broke") : discriminates(world)),
    );
    expect(await d.run()).toMatchObject({ _tag: "Admitted", attempts: 2 });
    expect(d.promptOf(2)).toContain("non-discriminating");
    expect(d.promptOf(2)).not.toContain(marker);
  });

  it("[draft.prompt] carries the disagreement, the rules with A-noop, both hunks, every source file and the template", async () => {
    const d = drafting(
      () => good(),
      (_, world) => discriminates(world),
    );
    await d.run();
    const prompt = d.promptOf(1);
    for (const part of [
      JSON.stringify(CONTEXT.premise),
      JSON.stringify(CONTEXT.effect),
      ...CONTEXT.anchors,
      "A-noop",
      "probe not applicable",
      CONTEXT.hunks.A,
      CONTEXT.hunks.B,
      ...CONTEXT.source.flatMap((f) => [f.path, f.text]),
      FRESHNESS_TEMPLATE.instructions,
    ])
      expect(prompt).toContain(part);
    expect(MATRIX_WORLDS).toHaveLength(5);
  });
});
