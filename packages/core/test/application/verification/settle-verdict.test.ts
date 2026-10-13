import { Effect, Layer, Logger, Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { settleVerdict, WORKER_APP_PACK } from "../../../src/application/verification/index.ts";
import { EvidenceMissing, EvidenceStore, Ids } from "../../../src/application/ports/index.ts";
import {
  CommitSha,
  ContentHash,
  contentHashOf,
  type Json,
  makeId,
  OrgId,
} from "../../../src/domain/kernel/index.ts";
import { compile, type StepReport } from "../../../src/domain/verification/index.ts";
import { fc } from "../../support/fast-check.ts";

/** The namespace every call names, and the only one the stores below keep anything for. */
const NAMESPACE = Schema.decodeUnknownSync(OrgId)("org_01JZ8PT2C4E6G8J0M2N4Q6S8V0");

/** The worker-app pack's plan: two proof steps in Tier 2, the suite and the typecheck. */
const PLAN = Result.getOrThrow(
  compile(
    undefined,
    {
      baseCommit: Schema.decodeUnknownSync(CommitSha)("a".repeat(40)),
      touchedPaths: ["src/a.ts"],
      subjects: [],
      facts: {},
    },
    WORKER_APP_PACK,
  ),
);

/** How a step ended: passed, failed with its evidence stored, or failed citing evidence nobody stored. */
type Ending = "pass" | "fail-stored" | "fail-missing";

const hex = fc
  .array(fc.constantFrom(..."0123456789abcdef".split("")), { minLength: 64, maxLength: 64 })
  .map((cs) => Schema.decodeUnknownSync(ContentHash)(`sha256:${cs.join("")}`));

/** One ending per step of the plan, at least one of them a fail whose evidence is missing. */
const endings = fc
  .array(fc.tuple(fc.constantFrom<Ending>("pass", "fail-stored", "fail-missing"), hex), {
    minLength: PLAN.steps.length,
    maxLength: PLAN.steps.length,
  })
  .filter((es) => es.some(([e]) => e === "fail-missing"));

const settle = (es: readonly (readonly [Ending, ContentHash])[]) => {
  const stored = new Map<ContentHash, Json>();
  const logged: string[] = [];
  const reports = PLAN.steps.map((step, i): StepReport => {
    const [ending, unstored] = es[i] ?? ["pass", undefined];
    const base = {
      stepId: step.id,
      evidenceClass: "proof" as const,
      tier: step.tier,
      durationMs: 1,
    };
    if (ending === "pass") return { ...base, outcome: "pass" };
    if (ending === "fail-missing") return { ...base, outcome: "fail", resultRef: unstored };
    const document = { failing: [{ file: `test/${step.id}.test.ts`, test: "it broke" }] };
    const resultRef = contentHashOf(document);
    stored.set(resultRef, document);
    return { ...base, outcome: "fail", resultRef };
  });
  const layer = Layer.mergeAll(
    Layer.succeed(
      EvidenceStore,
      EvidenceStore.of({
        put: (_namespace, document) =>
          Effect.die(`settling stores nothing, not ${JSON.stringify(document)}`),
        // Evidence is read for the namespace the verdict is settled in, and no other.
        get: (namespace, hash) => {
          const document =
            namespace === "org_01JZ8PT2C4E6G8J0M2N4Q6S8V0" ? stored.get(hash) : undefined;
          return document === undefined
            ? Effect.fail(new EvidenceMissing({ hash }))
            : Effect.succeed(document);
        },
      }),
    ),
    Layer.succeed(
      Ids,
      Ids.of({ next: (prefix) => Effect.succeed(makeId(prefix, "01JZ8PT2C4E6G8J0M2N4Q6S8V0")) }),
    ),
    Logger.layer([
      Logger.make(({ logLevel, message }) => {
        if (logLevel === "Error") logged.push(String(message));
      }),
    ]),
  );
  const exit = Effect.runSyncExit(
    settleVerdict(NAMESPACE, PLAN, reports).pipe(Effect.provide(layer)),
  );
  return { exit, logged, reports };
};

describe("settling a verdict", () => {
  it("[d21.evidence-missing-red] a fail whose evidence is not stored still bounces, citing it as missing, and logs an ops error", () => {
    fc.assert(
      fc.property(endings, (es) => {
        const { exit, logged, reports } = settle(es);
        if (exit._tag === "Failure") throw new Error(`settling died: ${String(exit.cause)}`);
        const missing = reports
          .filter((r, i) => es[i]?.[0] === "fail-missing")
          .map((r) => r.resultRef ?? "");
        expect(exit.value.outcome).toBe("bounce");
        for (const ref of missing) {
          expect(exit.value.evidence).toContain(`evidence missing: ${ref}`);
          expect(logged.some((line) => line.includes(ref))).toBe(true);
        }
        // What was stored is still cited by name.
        expect(exit.value.failingTests).toEqual(
          es.flatMap(([e], i) =>
            e === "fail-stored" ? [`test/${PLAN.steps[i]?.id ?? ""}.test.ts > it broke`] : [],
          ),
        );
        expect(exit.value.nextActions).toEqual([
          expect.objectContaining({ kind: "call", operationId: "submit" }),
        ]);
      }),
    );
  });
});
