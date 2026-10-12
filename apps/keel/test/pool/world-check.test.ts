import { introspectWorkflowInstance, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { FlowWorld } from "@keeltown/core/domain/verification";
import { ContentHash } from "@keeltown/core/kernel";
import { EventOutbox, PlanStore, WorldChecks } from "@keeltown/core/ports";
import { suitePlan } from "@keeltown/testing";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { PlanStoreR2 } from "../../src/adapters/driven/r2/plan-store.ts";
import { WorldChecksWorkflow } from "../../src/adapters/driven/workflow/world-checks.ts";
import type { SubjectDO } from "../../src/adapters/driving/do/subject.ts";
import { type WorldCheckJob, worldCheckParams } from "../../src/rpc/index.ts";
import { suiteStdout } from "../support-suite-stdout.ts";
import { admitted, drafted, hash, LEAF, logOf, subjectOf, suspected } from "./probe-harness.ts";

const SUITE = suitePlan();
const SUITE_STEP = "js-ts.suite";

/** Stores the plan as Precheck does, before any check names it. */
const stored = async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* PlanStore).put(SUITE);
    }).pipe(Effect.provide(PlanStoreR2(env.ARCHIVE))),
  );
  return SUITE.planHash;
};

/** What the engine's runner step persists: its logs, as the suite command printed them. */
const runnerOutput = (stdout: string) => ({
  exitCode: 0,
  logs: { stdout, stderr: "" },
  snapshot: { id: "snap", dir: "/workspace", localBucket: true },
});

/** The conflict's checks of one world, as the Probe starts them. */
const jobOf = (
  s: Awaited<ReturnType<typeof suspected>>,
  world: FlowWorld,
  checks: WorldCheckJob["checks"],
): WorldCheckJob => ({
  projectId: s.projectId,
  key: LEAF,
  conflictId: s.conflictId,
  world,
  bundle: Schema.decodeUnknownSync(ContentHash)(hash("d")),
  checks,
});
/** A WorldCheckRan's cell, as the Subject DO records it. */
const Cell = Schema.Struct({
  world: Schema.String,
  check: Schema.String,
  run: Schema.Int,
  outcome: Schema.String,
  reason: Schema.optional(Schema.String),
});

/** Runs one world's checks through the real Workflow and the real CI engine, the suite's runner step mocked. */
async function runWorld(job: WorldCheckJob, stdout?: string) {
  const id = `world-${job.conflictId}-${job.world}`;
  await using instance = await introspectWorkflowInstance(env.WORLD_CHECK, id);
  if (stdout !== undefined)
    await instance.modify(async (m) => {
      await m.mockStepResult({ name: SUITE_STEP }, runnerOutput(stdout));
    });
  await env.WORLD_CHECK.create({ id, params: worldCheckParams(job) });
  await instance.waitForStatus("complete");
}

/**
 * KeelWorldCheck through the real Workflow and the real CI engine. The pool
 * cannot start a container, so the suite's runner step is mocked with the
 * suite command's output, once: a second runner call would find no mock and
 * no container. Everything after it (the plan read from ARCHIVE, evidence,
 * the cell, each WorldCheckRan on the conflict's real Subject DO) runs for
 * real.
 */
describe("KeelWorldCheck", () => {
  it("[d22.pool.world-check-ab] AB's two checks run the suite once and record two WorldCheckRan, each under its own party's plan", async () => {
    const s = await suspected();
    await drafted(s.projectId, s.conflictId);
    const planHash = await stored();
    await runWorld(
      jobOf(s, "AB", [
        { check: `suite:${s.A}`, plan: { _tag: "Planned", planHash } },
        { check: `suite:${s.B}`, plan: { _tag: "Planned", planHash } },
      ]),
      await suiteStdout(200, 0),
    );
    expect(await recorded(s)).toEqual([
      { world: "AB", check: `suite:${s.A}`, run: 1, outcome: "pass" },
      { world: "AB", check: `suite:${s.B}`, run: 1, outcome: "pass" },
    ]);
  });

  it("[d22.pool.world-check-red] a red suite in a world records its check as a fail, saying which step", async () => {
    const s = await suspected();
    await drafted(s.projectId, s.conflictId);
    const planHash = await stored();
    await runWorld(
      jobOf(s, "trunk", [{ check: "suite:trunk", plan: { _tag: "Planned", planHash } }]),
      await suiteStdout(200, 2),
    );
    expect(await recorded(s)).toEqual([
      {
        world: "trunk",
        check: "suite:trunk",
        run: 1,
        outcome: "fail",
        reason: `${SUITE_STEP} failed`,
      },
    ]);
  });

  it("[d22.pool.world-check-unplanned] a check with no plan is recorded n/a with why, and runs nothing", async () => {
    const s = await suspected();
    await drafted(s.projectId, s.conflictId);
    await runWorld(
      jobOf(s, "B", [
        { check: `suite:${s.B}`, plan: { _tag: "Unplanned", reason: `${s.B} has no stored plan` } },
      ]),
    );
    expect(await recorded(s)).toEqual([
      {
        world: "B",
        check: `suite:${s.B}`,
        run: 1,
        outcome: "n/a",
        reason: `${s.B} has no stored plan`,
      },
    ]);
  });

  it("[d22.pool.world-check-decided] a conflict whose probe has decided still takes its checks: they are evidence for people, not for admission", async () => {
    const s = await suspected();
    await admitted(s.projectId, s.conflictId);
    await runWorld(
      jobOf(s, "A", [
        { check: `suite:${s.A}`, plan: { _tag: "Unplanned", reason: `${s.A} has no stored plan` } },
      ]),
    );
    expect(await recorded(s)).toEqual([
      {
        world: "A",
        check: `suite:${s.A}`,
        run: 1,
        outcome: "n/a",
        reason: `${s.A} has no stored plan`,
      },
    ]);
  });

  it("[d22.pool.world-check-stale] a conflict whose probe was never drafted takes no check: the instance ends with nothing recorded", async () => {
    const s = await suspected();
    await runWorld(
      jobOf(s, "B", [{ check: `suite:${s.B}`, plan: { _tag: "Unplanned", reason: "no plan" } }]),
    );
    expect(await recorded(s)).toEqual([]);
    expect(await logOf(s.projectId, { kind: "conflict", id: s.conflictId })).not.toContain(
      "WorldCheckRan",
    );
  });

  it("[d22.pool.world-checks-start] the Probe's start makes one instance per world, by its id, once", async () => {
    const s = await suspected();
    const job = jobOf(s, "A", [
      { check: `suite:${s.A}`, plan: { _tag: "Unplanned", reason: "no plan" } },
    ]);
    const id = `world-${s.conflictId}-A`;
    await using instance = await introspectWorkflowInstance(env.WORLD_CHECK, id);
    const start = Effect.gen(function* () {
      yield* (yield* WorldChecks).start(id, job);
    }).pipe(Effect.provide(WorldChecksWorkflow(env.WORLD_CHECK)));
    await Effect.runPromise(start);
    await Effect.runPromise(start);
    await instance.waitForStatus("complete");
    expect((await (await env.WORLD_CHECK.get(id)).status()).status).toBe("complete");
  });
});

/** The checks the conflict's Subject DO holds, from its WorldCheckRan events, in order. */
async function recorded(s: Awaited<ReturnType<typeof suspected>>) {
  return runInDurableObject(subjectOf(s.projectId), (instance: SubjectDO) =>
    instance["runtime"].runPromise(
      Effect.map(EventOutbox, (outbox) =>
        outbox
          .log({ kind: "conflict", id: s.conflictId })
          .filter((e) => e.type === "WorldCheckRan")
          .map((e) => {
            const { world, check, run, outcome, reason } = Schema.decodeUnknownSync(Cell)(
              e.payload,
            );
            return { world, check, run, outcome, ...(reason === undefined ? {} : { reason }) };
          }),
      ),
    ),
  );
}
