import { introspectWorkflow, introspectWorkflowInstance } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { namespaceAddress } from "@keeltown/core/application/coordination";
import { projectRepos } from "@keeltown/core/application/integration";
import { abRef } from "@keeltown/core/application/verification";
import type { ProbeOutcome, World } from "@keeltown/core/domain/verification";
import { type EventEnvelope, makeId } from "@keeltown/core/kernel";
import { ulid } from "ulid";
import { afterEach, describe, expect, it, vi } from "vitest";
import { drainAfter, drainOutbox, POOL_ORG } from "./helpers.ts";
import {
  conflictStateOf,
  deliver,
  discardsOf,
  hash,
  kept,
  logOf,
  ok,
  probeIdOf,
  sha,
  subjectOf,
  suspected,
  WORKSPACE,
} from "./probe-harness.ts";

const WORLDS: readonly World[] = ["trunk", "A", "B", "AB", "A-noop"];
const DISCRIMINATING: Readonly<Record<World, ProbeOutcome>> = {
  trunk: "pass",
  A: "pass",
  B: "n/a",
  AB: "fail",
  "A-noop": "fail",
};
/** An admitted draft's kept value: every world on every run, as the draft ran it. */
const admittedDraft = kept({
  _tag: "Drafted",
  outcome: {
    _tag: "Admitted",
    probe: hash("7"),
    files: [{ path: ".keel/freshness.test.ts", text: "// the probe\n" }],
    attempts: 1,
    cells: [1, 2, 3].flatMap((run) =>
      WORLDS.map((world) => ({
        world,
        run,
        outcome: DISCRIMINATING[world],
        reason: DISCRIMINATING[world],
        observations: [],
      })),
    ),
  },
});
const submitted = (n: string) =>
  ok({ _tag: "Submitted", repo: WORKSPACE(n), head: sha(n), base: sha("0") });
const BUILT = kept({
  _tag: "Built",
  built: { trunk: hash("1"), A: hash("2"), B: hash("3"), AB: hash("4") },
  hunks: { A: "", B: "" },
});

/** A draft's kept value when the runner could not run its matrix. */
const UNAVAILABLE = kept({ _tag: "RunnerUnavailable", reason: "keel-verify did not answer" });
/** A draft's kept value when Workers AI refused its one model call for capacity. */
const RATE_LIMITED = kept({
  _tag: "Drafted",
  outcome: {
    _tag: "Abstained",
    reason: "rate-limited",
    attempts: 1,
    detail: "Error: 3040: Capacity temporarily exceeded",
    feedback: [],
  },
});

/**
 * Everything from trunk's head to the draft, kept, so an instance reaches the
 * ledger without the code host or the model. `drafts` is what each draft in
 * turn keeps (`draft`, `draft#2`, `draft#3`); one admitted draft unless given.
 */
async function mockWorlds(
  instance: Awaited<ReturnType<typeof introspectWorkflowInstance>>,
  options: {
    readonly worldChecks?: "kept" | "started";
    readonly drafts?: readonly string[];
  } = {},
) {
  const drafts = options.drafts ?? [admittedDraft];
  await instance.modify(async (m) => {
    await m.mockStepResult({ name: "trunk" }, kept(sha("0")));
    await m.mockStepResult(
      { name: "ab" },
      kept({ candidateId: makeId("cnd", ulid()), at: 1_791_709_200_000 }),
    );
    await m.mockStepResult({ name: "worlds" }, BUILT);
    await Promise.all(
      drafts.map((draft, n) =>
        m.mockStepResult({ name: n === 0 ? "draft" : `draft#${n + 1}` }, draft),
      ),
    );
    // KeelWorldCheck's own pool cases run world checks; here they are started and kept.
    await m.mockStepResult({ name: "trunk plan" }, kept({ _tag: "Unplanned", reason: "pool" }));
    if (options.worldChecks !== "started")
      await m.mockStepResult({ name: "world checks" }, kept([]));
    await m.mockStepResult({ name: "guard" }, kept(sha("9")));
  });
}

/** Every sleep the instance began, in order, as its engine logged it: the step and how long it asked for. */
async function sleepsOf(id: string) {
  using events = await (await env.PROBE.get(id)).subscribe({ filter: ["sleep_started"] });
  const sleeps: { readonly step: string; readonly ms: number }[] = [];
  // oxlint-disable-next-line no-await-in-loop -- a subscription is read one event after another
  for (let next = await events.next(); next.done !== true; next = await events.next())
    if (next.value.type === "sleep_started")
      sleeps.push({ step: next.value.stepName, ms: next.value.durationMs });
  return sleeps;
}

/** The namespace object an unprovable conflict of a pool project is escalated to. */
const poolNamespace = () =>
  drainAfter(env.NAMESPACE.get(env.NAMESPACE.idFromName(namespaceAddress(POOL_ORG))));

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * The Probe Workflow through env.PROBE, started by the fan-out from the
 * ConflictSuspected the real Subject DO committed, and reporting to that
 * Subject DO over RPC. The parties' reads, trunk's head, the worlds, the draft
 * and the guard commit need the Change DO's awaitSubmission, the code host and
 * the model, which the pool has not, so their steps are kept; every fact the
 * ledger records runs for real. What each step decides is core's
 * probeConflict, proven in the unit suite.
 */
describe("Probe", () => {
  it("[d22.pool.probe-admits] drafts the suspected conflict, reports every cell to its Subject DO and ends admitted with the guard's commit", async () => {
    const s = await suspected();
    const id = `probe-${s.conflictId}`;
    await using instance = await introspectWorkflowInstance(env.PROBE, id);
    await instance.modify(async (m) => {
      await m.mockStepResult({ name: "party A 1" }, submitted("a"));
      await m.mockStepResult({ name: "party B 1" }, submitted("b"));
    });
    await mockWorlds(instance);
    expect((await deliver("workflow:Probe", [s.envelope]))._tag).toBe("Success");
    await instance.waitForStatus("complete");
    const { output } = await (await env.PROBE.get(id)).status();
    expect(output).toMatchObject({ outcome: "admitted", guardCommit: sha("9") });
    const probeId = await probeIdOf(s.projectId, s.conflictId);
    const probeLog = await logOf(s.projectId, { kind: "probe", id: probeId });
    expect(probeLog.filter((t) => t === "ProbeRan")).toHaveLength(15);
    expect(probeLog).toContain("GuardAdmitted");
  });

  it("[d22.pool.probe-world-checks] a drafted conflict's Probe starts its four world checks, which record every check on the conflict's Subject DO", async () => {
    const s = await suspected();
    const id = `probe-${s.conflictId}`;
    await using instance = await introspectWorkflowInstance(env.PROBE, id);
    await instance.modify(async (m) => {
      await m.mockStepResult({ name: "party A 1" }, submitted("a"));
      await m.mockStepResult({ name: "party B 1" }, submitted("b"));
    });
    // trunk's plan and the parties' are kept unplanned, so each check records n/a without a runner.
    await mockWorlds(instance, { worldChecks: "started" });
    expect((await deliver("workflow:Probe", [s.envelope]))._tag).toBe("Success");
    await instance.waitForStatus("complete");
    await vi.waitFor(
      async () =>
        expect(
          (await logOf(s.projectId, { kind: "conflict", id: s.conflictId })).filter(
            (t) => t === "WorldCheckRan",
          ),
        ).toHaveLength(5),
      { timeout: 30_000, interval: 250 },
    );
  });

  it("[d22.pool.fan-out-probe] one Probe per conflict, probe-<conflictId>, at the subject's own Subject DO; a redelivery starts nothing new", async () => {
    const s = await suspected();
    const id = `probe-${s.conflictId}`;
    await using instance = await introspectWorkflowInstance(env.PROBE, id);
    // B left before its submission: the Probe re-reads the conflict, still suspected, and fails its draft.
    await instance.modify(async (m) => {
      await m.mockStepResult({ name: "party A 1" }, submitted("a"));
      await m.mockStepResult({ name: "party B 1" }, ok({ _tag: "Gone", state: "withdrawn" }));
    });
    expect((await deliver("workflow:Probe", [s.envelope]))._tag).toBe("Success");
    expect((await deliver("workflow:Probe", [s.envelope, s.envelope]))._tag).toBe("Success");
    await instance.waitForStatus("complete");
    const { output } = await (await env.PROBE.get(id)).status();
    expect(output).toEqual({ outcome: "draft-failed", reason: "party-gone", attempts: 0 });
    // The real conflict on the real Subject DO took the failed draft: params named the right one.
    const probeId = await probeIdOf(s.projectId, s.conflictId);
    expect(await logOf(s.projectId, { kind: "probe", id: probeId })).toEqual(["ProbeDiscarded"]);
  });

  it("[d22.pool.no-propositions] a conflict that names no effect is drafted for no one: its draft fails unprovable on its Subject DO", async () => {
    const s = await suspected({ effect: false });
    const id = `probe-${s.conflictId}`;
    await using instance = await introspectWorkflowInstance(env.PROBE, id);
    expect((await deliver("workflow:Probe", [s.envelope]))._tag).toBe("Success");
    await instance.waitForStatus("complete");
    const { output } = await (await env.PROBE.get(id)).status();
    expect(output).toEqual({ outcome: "draft-failed", reason: "no-propositions", attempts: 0 });
    const probeId = await probeIdOf(s.projectId, s.conflictId);
    expect(await logOf(s.projectId, { kind: "probe", id: probeId })).toEqual(["ProbeDiscarded"]);
  });

  it("[d22.pool.no-subject-key] a ConflictSuspected that names no subject key is acknowledged with an ops line, and starts no Probe", async () => {
    const s = await suspected();
    // As an event committed before ConflictSuspected carried the key.
    const older = Object.fromEntries(
      Object.entries(Object(s.envelope.payload)).filter(([field]) => field !== "subjectKey"),
    );
    await using workflows = await introspectWorkflow(env.PROBE);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = await deliver("workflow:Probe", [{ ...s.envelope, payload: older }]);
    expect(exit._tag).toBe("Success");
    expect(errors.mock.calls.flat().join("\n")).toContain(s.conflictId);
    expect(await workflows.get()).toHaveLength(0);
  });

  for (const when of ["with the start", "once the last step before the wait has run"] as const)
    it(`[d22.pool.probe-waits] a party with nothing submitted is waited for, and its next move, sent ${when}, reaches the instance as change-<changeId>`, async () => {
      const s = await suspected();
      const id = `probe-${s.conflictId}`;
      await using instance = await introspectWorkflowInstance(env.PROBE, id);
      await instance.modify(async (m) => {
        await m.mockStepResult({ name: "party A 1" }, ok({ _tag: "Waiting" }));
        // A lands while the instance waits: its world is then its commit on trunk.
        await m.mockStepResult(
          { name: "party A 2" },
          ok({ _tag: "Landed", landing: sha("c"), parent: sha("0") }),
        );
        await m.mockStepResult({ name: "party B 1" }, submitted("b"));
      });
      await mockWorlds(instance);
      expect((await deliver("workflow:Probe", [s.envelope]))._tag).toBe("Success");
      const landed: EventEnvelope = {
        ...s.envelope,
        eventId: makeId("evt", ulid()),
        type: "ChangeLanded",
        entity: { kind: "change", id: s.A },
      };
      // Miniflare reports a waiting instance as running, so the step before the wait is the signal.
      if (when === "once the last step before the wait has run")
        await instance.waitForStepResult({ name: "clock A 1" });
      const sent = await deliver(`workflow:Probe/${id}`, [landed]);
      expect(sent._tag).toBe("Success");
      await instance.waitForStatus("complete");
      const { output } = await (await env.PROBE.get(id)).status();
      expect(output).toMatchObject({ outcome: "admitted" });
    });

  it("[d22.pool.probe-deadline] a party that never submits within the wait ends the draft as no-submission on its Subject DO", async () => {
    const s = await suspected();
    const id = `probe-${s.conflictId}`;
    await using instance = await introspectWorkflowInstance(env.PROBE, id);
    await instance.modify(async (m) => {
      await m.mockStepResult({ name: "party A 1" }, ok({ _tag: "Waiting" }));
      await m.forceEventTimeout({ name: "change A 1" });
    });
    expect((await deliver("workflow:Probe", [s.envelope]))._tag).toBe("Success");
    await instance.waitForStatus("complete");
    const { output } = await (await env.PROBE.get(id)).status();
    expect(output).toEqual({ outcome: "draft-failed", reason: "no-submission", attempts: 0 });
    const probeId = await probeIdOf(s.projectId, s.conflictId);
    expect(await logOf(s.projectId, { kind: "probe", id: probeId })).toEqual(["ProbeDiscarded"]);
  });

  it("[d22.pool.probe-runner-unavailable] a runner that can run none of the three drafts ends the instance errored, with the draft recorded incomplete and the conflict escalated", async () => {
    const s = await suspected();
    const id = `probe-${s.conflictId}`;
    const namespace = poolNamespace();
    await using instance = await introspectWorkflowInstance(env.PROBE, id);
    await instance.modify(async (m) => {
      await m.mockStepResult({ name: "party A 1" }, submitted("a"));
      await m.mockStepResult({ name: "party B 1" }, submitted("b"));
      await m.disableSleeps();
    });
    await mockWorlds(instance, { drafts: [UNAVAILABLE, UNAVAILABLE, UNAVAILABLE] });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await deliver("workflow:Probe", [s.envelope]))._tag).toBe("Success");
    await instance.waitForStatus("errored");
    // The engine names no step's error as the instance's; the instance's own ops line says what ended it.
    expect(errors.mock.calls.flat().join("\n")).toContain(
      "draft#3: the probe runner could not run any of 3 drafts: keel-verify did not answer",
    );
    expect(await sleepsOf(id)).toEqual([
      { step: "draft wait-1", ms: 30_000 },
      { step: "draft#2 wait-1", ms: 120_000 },
    ]);
    expect(await discardsOf(s.projectId, s.conflictId)).toMatchObject([
      { reason: "draft-failed", detail: "incomplete", conflictId: s.conflictId },
    ]);
    expect(await conflictStateOf(s.projectId, s.conflictId)).toBe("escalated");
    await drainOutbox(subjectOf(s.projectId));
    await drainOutbox(namespace);
  });

  it("[d22.pool.probe-runner-unready] a world keel-verify holds no deps bundle for ends the instance errored before any draft, with the draft recorded incomplete and the conflict escalated", async () => {
    const s = await suspected();
    const id = `probe-${s.conflictId}`;
    const namespace = poolNamespace();
    await using instance = await introspectWorkflowInstance(env.PROBE, id);
    await instance.modify(async (m) => {
      await m.mockStepResult({ name: "party A 1" }, submitted("a"));
      await m.mockStepResult({ name: "party B 1" }, submitted("b"));
      await m.mockStepResult({ name: "trunk" }, kept(sha("0")));
      await m.mockStepResult(
        { name: "ab" },
        kept({ candidateId: makeId("cnd", ulid()), at: 1_791_709_200_000 }),
      );
      // B's world is the one the pool's keel-verify answers as unready (vitest.config.ts). The
      // `runner` step is not mocked: it asks keel-verify over the VERIFIER binding. Nor is any
      // draft, so an instance that went on to draft would not end as this one does.
      await m.mockStepResult(
        { name: "worlds" },
        kept({
          _tag: "Built",
          built: { trunk: hash("1"), A: hash("2"), B: hash("d"), AB: hash("4") },
          hunks: { A: "", B: "" },
        }),
      );
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await deliver("workflow:Probe", [s.envelope]))._tag).toBe("Success");
    await instance.waitForStatus("errored");
    expect(errors.mock.calls.flat().join("\n")).toContain(
      "runner: the probe runner cannot run in world B: lockfile-diverged: no deps bundle for pnpm-lock.yaml 0ddba11",
    );
    expect(await sleepsOf(id)).toEqual([]);
    expect(await discardsOf(s.projectId, s.conflictId)).toMatchObject([
      { reason: "draft-failed", detail: "incomplete", conflictId: s.conflictId },
    ]);
    expect(await conflictStateOf(s.projectId, s.conflictId)).toBe("escalated");
    await drainOutbox(subjectOf(s.projectId));
    await drainOutbox(namespace);
  });

  it("[d22.pool.probe-step-died] a step that runs out of tries once the conflict was read as suspected ends the instance errored, with the draft recorded incomplete and the conflict escalated", async () => {
    const s = await suspected();
    const id = `probe-${s.conflictId}`;
    const namespace = poolNamespace();
    await using instance = await introspectWorkflowInstance(env.PROBE, id);
    await instance.modify(async (m) => {
      await m.mockStepResult({ name: "party A 1" }, submitted("a"));
      await m.mockStepResult({ name: "party B 1" }, submitted("b"));
      await m.mockStepResult({ name: "trunk" }, kept(sha("0")));
      await m.mockStepResult(
        { name: "ab" },
        kept({ candidateId: makeId("cnd", ulid()), at: 1_791_709_200_000 }),
      );
      await m.mockStepResult({ name: "worlds" }, BUILT);
      // The draft dies on its first try and on its one retry.
      await m.mockStepError({ name: "draft" }, new Error("the verifier fell over"));
      await m.disableRetryDelays();
    });
    expect((await deliver("workflow:Probe", [s.envelope]))._tag).toBe("Success");
    await instance.waitForStatus("errored");
    expect(await discardsOf(s.projectId, s.conflictId)).toMatchObject([
      { reason: "draft-failed", detail: "incomplete", conflictId: s.conflictId },
    ]);
    expect(await conflictStateOf(s.projectId, s.conflictId)).toBe("escalated");
    await drainOutbox(subjectOf(s.projectId));
    await drainOutbox(namespace);
  });

  it("[d22.pool.probe-run-died] a step that runs out of tries once the draft is recorded ends the instance errored, with the probe's run recorded as failed and the conflict escalated", async () => {
    const s = await suspected();
    const id = `probe-${s.conflictId}`;
    const namespace = poolNamespace();
    await using instance = await introspectWorkflowInstance(env.PROBE, id);
    await instance.modify(async (m) => {
      await m.mockStepResult({ name: "party A 1" }, submitted("a"));
      await m.mockStepResult({ name: "party B 1" }, submitted("b"));
      await m.mockStepResult({ name: "trunk" }, kept(sha("0")));
      await m.mockStepResult(
        { name: "ab" },
        kept({ candidateId: makeId("cnd", ulid()), at: 1_791_709_200_000 }),
      );
      await m.mockStepResult({ name: "worlds" }, BUILT);
      await m.mockStepResult({ name: "draft" }, admittedDraft);
      // The draft is recorded on the real Subject DO; the step after it dies on its first try and
      // on its one retry. Neither record is mocked: `incomplete` is refused and `run-failed` lands.
      await m.mockStepError({ name: "trunk plan" }, new Error("the code host fell over"));
      await m.disableRetryDelays();
    });
    expect((await deliver("workflow:Probe", [s.envelope]))._tag).toBe("Success");
    await instance.waitForStatus("errored");
    const discards = await discardsOf(s.projectId, s.conflictId);
    expect(discards).toMatchObject([{ reason: "run-failed", conflictId: s.conflictId }]);
    expect(discards[0]).not.toHaveProperty("detail");
    const probeId = await probeIdOf(s.projectId, s.conflictId);
    expect(await logOf(s.projectId, { kind: "probe", id: probeId })).toEqual([
      "ProbeDrafted",
      "ProbeDiscarded",
    ]);
    expect(await conflictStateOf(s.projectId, s.conflictId)).toBe("escalated");
    await drainOutbox(subjectOf(s.projectId));
    await drainOutbox(namespace);
  });

  it("[d22.pool.probe-rate-limited] a model rate-limited for two drafts is waited out, 30 s and then 120 s, and the third draft is admitted", async () => {
    const s = await suspected();
    const id = `probe-${s.conflictId}`;
    await using instance = await introspectWorkflowInstance(env.PROBE, id);
    await instance.modify(async (m) => {
      await m.mockStepResult({ name: "party A 1" }, submitted("a"));
      await m.mockStepResult({ name: "party B 1" }, submitted("b"));
      await m.disableSleeps();
    });
    await mockWorlds(instance, { drafts: [RATE_LIMITED, RATE_LIMITED, admittedDraft] });
    expect((await deliver("workflow:Probe", [s.envelope]))._tag).toBe("Success");
    await instance.waitForStatus("complete");
    const { output } = await (await env.PROBE.get(id)).status();
    expect(output).toMatchObject({ outcome: "admitted", guardCommit: sha("9") });
    expect(await sleepsOf(id)).toEqual([
      { step: "draft wait-1", ms: 30_000 },
      { step: "draft#2 wait-1", ms: 120_000 },
    ]);
    const probeId = await probeIdOf(s.projectId, s.conflictId);
    expect(await logOf(s.projectId, { kind: "probe", id: probeId })).toContain("GuardAdmitted");
    await drainOutbox(subjectOf(s.projectId));
  });

  it("[d22.pool.probe-rate-limited-out] a model rate-limited for all three drafts fails the draft as abstained on its Subject DO", async () => {
    const s = await suspected();
    const id = `probe-${s.conflictId}`;
    const namespace = poolNamespace();
    await using instance = await introspectWorkflowInstance(env.PROBE, id);
    await instance.modify(async (m) => {
      await m.mockStepResult({ name: "party A 1" }, submitted("a"));
      await m.mockStepResult({ name: "party B 1" }, submitted("b"));
      await m.disableSleeps();
    });
    await mockWorlds(instance, { drafts: [RATE_LIMITED, RATE_LIMITED, RATE_LIMITED] });
    expect((await deliver("workflow:Probe", [s.envelope]))._tag).toBe("Success");
    await instance.waitForStatus("complete");
    const { output } = await (await env.PROBE.get(id)).status();
    expect(output).toEqual({ outcome: "draft-failed", reason: "abstained", attempts: 1 });
    expect(await sleepsOf(id)).toEqual([
      { step: "draft wait-1", ms: 30_000 },
      { step: "draft#2 wait-1", ms: 120_000 },
    ]);
    expect(await discardsOf(s.projectId, s.conflictId)).toMatchObject([
      { reason: "draft-failed", detail: "abstained", conflictId: s.conflictId },
    ]);
    await drainOutbox(subjectOf(s.projectId));
    await drainOutbox(namespace);
  });

  it("[d22.pool.send-finished] an event for an instance that has finished is acknowledged, since nothing waits for it", async () => {
    const s = await suspected({ effect: false });
    const id = `probe-${s.conflictId}`;
    await using instance = await introspectWorkflowInstance(env.PROBE, id);
    expect((await deliver("workflow:Probe", [s.envelope]))._tag).toBe("Success");
    await instance.waitForStatus("complete");
    const late: EventEnvelope = {
      ...s.envelope,
      eventId: makeId("evt", ulid()),
      type: "ChangeSubmitted",
      entity: { kind: "change", id: s.A },
    };
    expect((await deliver(`workflow:Probe/${id}`, [late]))._tag).toBe("Success");
  });

  it("[d22.pool.ab-ref-ignored] a push of AB's ref to staging is no workspace push: PushObserved ends without asking any pool", async () => {
    const projectId = makeId("prj", ulid());
    const id = `push-${ulid().toLowerCase()}`;
    await using instance = await introspectWorkflowInstance(env.PUSH_OBSERVED, id);
    await env.PUSH_OBSERVED.create({
      id,
      params: {
        type: "cf.artifacts.repo.pushed",
        source: { namespace: "keel-core", repoName: projectRepos(projectId).staging.name },
        payload: { ref: abRef(makeId("cfl", ulid())), before: sha("0"), after: sha("a") },
      },
    });
    await instance.waitForStatus("complete");
    expect((await (await env.PUSH_OBSERVED.get(id)).status()).output).toBeNull();
  });
});
