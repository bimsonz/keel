import {
  env,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowStepConfig,
} from "cloudflare:workers";
import { decidePrecheck, type PrecheckFindings } from "@keeltown/core/application/verification";
import { GUARD_PATHS } from "@keeltown/core/domain/verification";
import { CommitSha, makeId } from "@keeltown/core/kernel";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { Precheck, type PrecheckParams } from "../../src/adapters/driving/workflow/precheck.ts";
import { POOL_ORG } from "./helpers.ts";

const BASE = "b".repeat(40);
const HEAD = "c".repeat(40);

/** The submission each run checks: a commit on its base. */
const EVENT: WorkflowEvent<PrecheckParams> = {
  payload: {
    changeId: makeId("chg", ulid()),
    revision: 1,
    commitSha: HEAD,
    baseSha: BASE,
    eventId: "evt-steps",
  },
  timestamp: new Date(),
  instanceId: "precheck-steps",
  workflowName: "keel-precheck",
};

/** What a step answers once its use-case ran: settled, with this value. */
const done = <A>(value: A) => ({ _tag: "Done", value });

/** What the reads of a clean submission find: one source path, no protected glob, no flow of its own, no guard. */
const CLEAN = {
  ancestry: { _tag: "Descends", base: CommitSha.make(BASE) },
  touched: { _tag: "Touched", paths: ["src/a.ts"] },
  policy: { protectedPaths: [], guardPaths: GUARD_PATHS },
  flow: { _tag: "Read", sources: { rootPaths: [] } },
  guards: { _tag: "Listed", admitted: [], refused: [] },
  subjects: [],
} satisfies PrecheckFindings;

/**
 * What the start step answers: the change's workspace, of which a run whose
 * every read is canned uses only the project and the declared subjects.
 */
const WORKSPACE = { projectId: makeId("prj", ulid()), subjects: [] };
/** What the derive step answers: the record it kept, which names no subject. */
const KEPT = { derivationRef: `sha256:${"d".repeat(64)}`, subjects: [] };
const VERDICT = makeId("vrd", ulid());

type Callback = () => Promise<unknown>;

/** How one step of the fake goes: how long it takes, then what it answers or throws. */
interface Canned {
  readonly ms: number;
  readonly settle: (callback: Callback) => Promise<unknown>;
}

/** A step that answers this after `ms`, running none of its use-case. */
const answers = (ms: number, value: unknown): Canned => ({ ms, settle: async () => value });
/** A step that throws this after `ms`, as a failed step does once its retries are spent. */
const fails = (ms: number, error: Error): Canned => ({
  ms,
  settle: async () => {
    throw error;
  },
});
/** A step that runs its own callback: decide's, which is pure. */
const runs: Canned = { ms: 0, settle: (callback) => callback() };

/** Every step of a clean submission's run, each answering at once. */
const clean = (): Record<string, Canned> => ({
  start: answers(0, done(WORKSPACE)),
  namespace: answers(0, POOL_ORG),
  ancestry: answers(0, done(CLEAN.ancestry)),
  diff: answers(0, done(CLEAN.touched)),
  policy: answers(0, done(CLEAN.policy)),
  flow: answers(0, done(CLEAN.flow)),
  guards: answers(0, done(CLEAN.guards)),
  derive: answers(0, done(KEPT)),
  derived: answers(0, { _tag: "Done" }),
  decide: runs,
  compile: answers(0, { _tag: "Done" }),
  refuse: answers(0, done(VERDICT)),
});

/**
 * A WorkflowStep that runs no use-case: each `do` logs `start:<name>` as it
 * is called, waits its step's time, logs `end:<name>`, then answers or throws
 * what that step is canned with. A step with nothing canned throws.
 */
const stepping = (
  canned: Readonly<Record<string, Canned | undefined>>,
  log: string[],
): WorkflowStep => {
  const fake = {
    do: async (name: string, ...args: [Callback] | [WorkflowStepConfig, Callback]) => {
      log.push(`start:${name}`);
      const step = canned[name];
      if (step === undefined) throw new Error(`nothing canned for the ${name} step`);
      await new Promise((resolve) => setTimeout(resolve, step.ms));
      log.push(`end:${name}`);
      return step.settle(args.length === 1 ? args[0] : args[1]);
    },
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the fake has the one method Precheck calls
  return fake as unknown as WorkflowStep;
};

/**
 * A Precheck holding the pool's env, made without WorkflowEntrypoint's
 * constructor: workerd's takes only an ExecutionContext of its own making,
 * which `createExecutionContext` is not, and `run` reads nothing of the
 * instance but `env`.
 */
const precheck = (): Precheck => Object.create(Precheck.prototype, { env: { value: env } });

/**
 * Precheck's run on the fake: `log` holds each step's start and end, then
 * `resolved` or `rejected` as the run ends, in the order they happened.
 */
const precheckOn = (canned: Readonly<Record<string, Canned | undefined>>) => {
  const log: string[] = [];
  const ended = precheck()
    .run(EVENT, stepping(canned, log))
    .then(
      (outcome) => {
        log.push("resolved");
        return outcome;
      },
      (error: unknown) => {
        log.push("rejected");
        throw error;
      },
    );
  return { log, ended };
};

/** The log between two of its entries, sorted: what happened there, in whatever order. */
const between = (log: readonly string[], after: string, before: string) =>
  log.slice(log.indexOf(after) + 1, log.indexOf(before)).toSorted();

/**
 * Precheck's own run, called directly on a fake WorkflowStep that answers
 * each step without running its use-case and logs when each starts and ends:
 * which steps run together, which wait for which, and when a failure is
 * thrown. Each step's time only sets which of those running together ends
 * first; the assertions are on the order the log holds.
 */
describe("Precheck's steps", () => {
  it("[precheck.reads-at-once] starts diff, policy, flow and guards together, derive as soon as diff is in while flow still reads, and derived only once all five are in", async () => {
    const { log, ended } = precheckOn({
      ...clean(),
      diff: answers(5, done(CLEAN.touched)),
      policy: answers(20, done(CLEAN.policy)),
      flow: answers(60, done(CLEAN.flow)),
      guards: answers(20, done(CLEAN.guards)),
      derive: answers(10, done(KEPT)),
    });
    const decision = decidePrecheck(CLEAN, POOL_ORG);
    if (decision._tag !== "Compile")
      throw new Error(`a clean submission was refused: ${decision.reasons.join(", ")}`);
    expect(await ended).toEqual({ outcome: "compiled", planHash: decision.planHash });

    expect(log.slice(0, 10)).toEqual([
      "start:start",
      "end:start",
      "start:namespace",
      "end:namespace",
      "start:ancestry",
      "end:ancestry",
      // The four reads, each started before any of them is in.
      "start:diff",
      "start:policy",
      "start:flow",
      "start:guards",
    ]);
    // derive waits for diff's paths alone: it starts once diff is in, while flow is still reading.
    expect(log.indexOf("start:derive")).toBeGreaterThan(log.indexOf("end:diff"));
    expect(log.indexOf("start:derive")).toBeLessThan(log.indexOf("end:flow"));
    expect(between(log, "start:guards", "start:derived")).toEqual(
      ["end:diff", "end:policy", "end:flow", "end:guards", "start:derive", "end:derive"].toSorted(),
    );
    expect(log.slice(log.indexOf("start:derived"))).toEqual([
      "start:derived",
      "end:derived",
      "start:decide",
      "end:decide",
      "start:compile",
      "end:compile",
      "resolved",
    ]);
  });

  it("[precheck.reads-settle-before-failing] throws a read that failed while derive was still running only once derive is in, and takes no step after it", async () => {
    const flowFailed = new Error("flow failed");
    const { log, ended } = precheckOn({
      ...clean(),
      diff: answers(1, done(CLEAN.touched)),
      flow: fails(10, flowFailed),
      derive: answers(40, done(KEPT)),
    });

    await expect(ended).rejects.toBe(flowFailed);
    expect(log.slice(log.indexOf("end:derive"))).toEqual(["end:derive", "rejected"]);
    // flow failed first: derive was still running when it did.
    expect(log.indexOf("end:flow")).toBeLessThan(log.indexOf("end:derive"));
    expect(log).not.toContain("start:derived");
  });

  it("[precheck.reads-settle-before-failing] throws the first failure in step order, not in time: policy's, though guards failed before it", async () => {
    const policyFailed = new Error("policy failed");
    const { log, ended } = precheckOn({
      ...clean(),
      policy: fails(30, policyFailed),
      guards: fails(5, new Error("guards failed")),
    });

    await expect(ended).rejects.toBe(policyFailed);
    expect(log.slice(log.indexOf("end:policy"))).toEqual(["end:policy", "rejected"]);
    expect(log.indexOf("end:guards")).toBeLessThan(log.indexOf("end:policy"));
    expect(log).not.toContain("start:derived");
  });

  it("[precheck.unreadable-diff-derives-nothing] derives nothing from a diff that could not be read, and still ends with the refusal decide makes of it", async () => {
    const { log, ended } = precheckOn({
      ...clean(),
      // Nothing canned: either one taken would throw.
      derive: undefined,
      derived: undefined,
      diff: answers(0, done({ _tag: "Unreadable", reason: `ObjectNotFound ${BASE}` })),
      flow: answers(20, done(CLEAN.flow)),
    });

    expect(await ended).toEqual({
      outcome: "refused",
      verdictId: VERDICT,
      reasons: [`precheck:unreadable:ObjectNotFound ${BASE}`],
    });
    expect(log).not.toContain("start:derive");
    expect(log).not.toContain("start:derived");
    // Between ancestry and decide, the four reads and nothing else.
    expect(between(log, "end:ancestry", "start:decide")).toEqual(
      ["diff", "policy", "flow", "guards"]
        .flatMap((name) => [`start:${name}`, `end:${name}`])
        .toSorted(),
    );
    expect(log.slice(log.indexOf("start:decide"))).toEqual([
      "start:decide",
      "end:decide",
      "start:refuse",
      "end:refuse",
      "resolved",
    ]);
  });
});
