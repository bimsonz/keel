import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  DRAFT_REPAIRS,
  type DraftContext,
  draftProbe,
  FRESHNESS_SCHEMA,
  FRESHNESS_TEMPLATE,
  type FreshnessSlots,
  freshnessNoop,
  MATRIX_WORLDS,
  type NoNoop,
  type NoopRecipe,
  type ProbeRun,
  type ProbeTemplate,
} from "../../../src/application/verification/index.ts";
import {
  PlatformFunction,
  type PlatformFunctionCall,
  ProbeRunner,
  type ProbeRunRequest,
  ProbeStore,
} from "../../../src/application/ports/index.ts";
import { Proposition } from "../../../src/domain/coordination/index.ts";
import { ContentHash, NamespaceId } from "../../../src/domain/kernel/index.ts";
import {
  type FlowWorld,
  ModelAbstained,
  type ProbeOutcome,
  type World,
} from "../../../src/domain/verification/index.ts";
import { fc } from "../../support/fast-check.ts";

const hash = (n: number) =>
  Schema.decodeUnknownSync(ContentHash)(`sha256:${String(n).padStart(64, "0")}`);
const WORLDS: Readonly<Record<FlowWorld, ContentHash>> = {
  trunk: hash(10),
  A: hash(11),
  B: hash(12),
  AB: hash(13),
};
/** The A-noop world the default builder answers with. */
const A_NOOP = hash(14);

/** The namespace every call names, and the only one the stores below keep anything for. */
const NAMESPACE = Schema.decodeUnknownSync(NamespaceId)("org_01JZ8PT2C4E6G8J0M2N4Q6S8V0");

/** A's revoke, as S-1's a.patch adds it: what the slots name for A-noop. */
const REVOKE_PATH = "src/routes/collaborators.ts";
const REVOKE_CALL = "store.removeCollaborator(repo.id, target.id, actor.id, clock.now());";

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
    A: [
      `diff --git a/${REVOKE_PATH} b/${REVOKE_PATH}`,
      `--- a/${REVOKE_PATH}`,
      `+++ b/${REVOKE_PATH}`,
      "@@ -1,2 +1,4 @@",
      " const existing = 1;",
      "+app.delete('/repos/:owner/:repo/collaborators/:username', async (c) => {",
      `+  ${REVOKE_CALL}`,
      "+});",
    ].join("\n"),
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
  noop: { path: REVOKE_PATH, call: REVOKE_CALL },
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
function drafting(
  script: Script,
  matrix: Matrix,
  aNoop: (recipe: NoopRecipe) => Effect.Effect<ContentHash, NoNoop> = () => Effect.succeed(A_NOOP),
  template: ProbeTemplate<FreshnessSlots> = FRESHNESS_TEMPLATE,
) {
  const recipes: NoopRecipe[] = [];
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
            if (reply === ABSTAIN) return Effect.fail(new ModelAbstained({ reason: "timeout" }));
            return reply instanceof ModelAbstained ? Effect.fail(reply) : Effect.succeed(reply);
          }),
      }),
    ),
    Layer.succeed(
      ProbeStore,
      ProbeStore.of({
        put: (namespace, files) =>
          Effect.sync(() => {
            expect(namespace).toBe("org_01JZ8PT2C4E6G8J0M2N4Q6S8V0");
            puts += 1;
            const probe = hash(1000 + puts);
            attemptOf.set(probe, calls.length);
            expect(files.map((f) => f.path)).toEqual([".keel/freshness.test.ts"]);
            return probe;
          }),
        get: () => Effect.die("drafting never reads a probe's source back"),
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
    Effect.runPromise(
      draftProbe(NAMESPACE, template, CONTEXT, WORLDS, (recipe) =>
        Effect.suspend(() => {
          recipes.push(recipe);
          return aNoop(recipe);
        }),
      ).pipe(Effect.provide(layer)),
    );
  const promptOf = (n: number) => String(calls[n - 1]?.input["prompt"]);
  return { calls, requests, recipes, run, promptOf };
}

describe("draftProbe: template first, repaired from deterministic text only", () => {
  it("[draft.first-admitted] admits a first draft that discriminates, after one call and one matrix", async () => {
    const d = drafting(
      () => good(),
      (_, world) => discriminates(world),
    );
    const outcome = await d.run();
    expect(outcome).toMatchObject({
      _tag: "Admitted",
      probe: hash(1001),
      files: FRESHNESS_TEMPLATE.render(good()),
      attempts: 1,
    });
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
    // It ran clean, so the domain decides it from its own matrix: the probe, its files and every cell.
    expect(outcome).toMatchObject({
      ran: {
        probe: hash(1001),
        files: FRESHNESS_TEMPLATE.render(good()),
        cells: expect.arrayContaining([expect.objectContaining({ world: "A-noop", run: 3 })]),
      },
    });
    expect(outcome._tag === "Discarded" ? outcome.ran?.cells : []).toHaveLength(15);
  });

  it("[draft.abstained] ends when the model abstains, with nothing run and no repair", async () => {
    const d = drafting(
      () => ABSTAIN,
      (_, world) => discriminates(world),
    );
    expect(await d.run()).toEqual({
      _tag: "Abstained",
      reason: "timeout",
      attempts: 1,
      feedback: [],
    });
    expect(d.calls).toHaveLength(1);
    expect(d.requests).toHaveLength(0);
  });

  it("[draft.abstained-detail] an abstain's outcome carries what the adapter said of it, and what every earlier attempt was told", async () => {
    const d = drafting(
      (n) =>
        n === 1
          ? BAD
          : new ModelAbstained({
              reason: "rate-limited",
              detail: "Error: 3040: Capacity temporarily exceeded",
            }),
      (_, world) => discriminates(world),
    );
    expect(await d.run()).toEqual({
      _tag: "Abstained",
      reason: "rate-limited",
      attempts: 2,
      detail: "Error: 3040: Capacity temporarily exceeded",
      feedback: ["attempt 1: slots: owner must be a lowercase username"],
    });
    expect(d.calls).toHaveLength(2);
    expect(d.requests).toHaveLength(0);
  });

  it("[draft.unparsed-repair] repairs a reply that did not parse, with the parser's message", async () => {
    const d = drafting(
      (n) =>
        n === 1
          ? new ModelAbstained({ reason: "schema", detail: "Unexpected end of JSON input" })
          : good(),
      (_, world) => discriminates(world),
    );
    expect(await d.run()).toMatchObject({ _tag: "Admitted", attempts: 2 });
    expect(d.promptOf(2)).toContain(
      "- attempt 1: reply did not parse as the slot schema: Unexpected end of JSON input",
    );
  });

  it("[draft.unparsed-repair] repairs a reply cut at the token limit, asking for the slots alone", async () => {
    const d = drafting(
      (n) => (n === 1 ? new ModelAbstained({ reason: "truncated", detail: "8192" }) : good()),
      (_, world) => discriminates(world),
    );
    expect(await d.run()).toMatchObject({ _tag: "Admitted", attempts: 2 });
    expect(d.promptOf(2)).toContain(
      "- attempt 1: reply cut at the token limit (8192); return only the slots",
    );
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

  it("[draft.noop-from-slots] builds A-noop from the recipe the slots name, and runs the probe there", async () => {
    const d = drafting(
      () => good(),
      (_, world) => discriminates(world),
    );
    expect(await d.run()).toMatchObject({ _tag: "Admitted", attempts: 1 });
    expect(d.recipes).toEqual([freshnessNoop({ path: REVOKE_PATH, call: REVOKE_CALL })]);
    expect(d.requests.filter((r) => r.world === "A-noop").map((r) => r.worldBundle)).toEqual([
      A_NOOP,
      A_NOOP,
      A_NOOP,
    ]);
  });

  it("[draft.noop-outside-hunk] repairs a recipe that is not on a line A adds, and never builds or runs it", async () => {
    const elsewhere = { ...good(), noop: { path: REVOKE_PATH, call: "const existing = 1;" } };
    const absent = { ...good(), noop: { path: "src/app.ts", call: REVOKE_CALL } };
    const d = drafting(
      (n) => (n === 1 ? elsewhere : n === 2 ? absent : good()),
      (_, world) => discriminates(world),
    );
    expect(await d.run()).toMatchObject({ _tag: "Admitted", attempts: 3 });
    expect(d.promptOf(3)).toContain(
      `- attempt 1: noop: the call is not on a line A adds to ${REVOKE_PATH}`,
    );
    expect(d.promptOf(3)).toContain("- attempt 2: noop: src/app.ts is not in A's diff");
    expect(d.recipes).toHaveLength(1);
    expect(new Set(d.requests.map((r) => r.probe))).toEqual(new Set([hash(1001)]));
  });

  it("[draft.noop-outside-hunk] repairs a recipe whose call is not once in A's file, saying how often it is", async () => {
    const d = drafting(
      () => good(),
      (_, world) => discriminates(world),
      (recipe) =>
        Effect.fail({ reason: "anchor-ambiguous", path: recipe.path, count: 2 } satisfies NoNoop),
    );
    expect(await d.run()).toMatchObject({ _tag: "Discarded", reason: "repairs-exhausted" });
    expect(d.promptOf(2)).toContain(
      `- attempt 1: noop: the call occurs 2 times in ${REVOKE_PATH} in A's tree, not once`,
    );
    expect(d.requests).toEqual([]);
  });

  it("[draft.noop-missing-incomplete] a template with no A-noop recipe is incomplete: nothing runs, no repair", async () => {
    const { id, fn, schema, instructions, validate, render } = FRESHNESS_TEMPLATE;
    const noRecipe: ProbeTemplate<FreshnessSlots> = {
      id,
      fn,
      schema,
      instructions,
      validate,
      render,
    };
    const d = drafting(
      () => good(),
      (_, world) => discriminates(world),
      undefined,
      noRecipe,
    );
    expect(await d.run()).toMatchObject({ _tag: "Discarded", reason: "incomplete", attempts: 1 });
    expect(d.calls).toHaveLength(1);
    expect(d.requests).toEqual([]);
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
