import { Result } from "effect";
import { describe, expect, it } from "vitest";
import {
  anchorsOf,
  type DraftOutcome,
  draftWorlds,
  guardOf,
  type MatrixCell,
  partiesOf,
  planStateOf,
  type ProbeParties,
  probeWorldPlan,
  reportsOf,
  submissionStateOf,
  worldChecks,
} from "../../../src/application/verification/index.ts";
import {
  ChangeState,
  type Proposition,
  SubjectKey,
} from "../../../src/domain/coordination/index.ts";
import {
  CommitSha,
  ContentHash,
  Instant,
  makeId,
  userActor,
} from "../../../src/domain/kernel/index.ts";
import { MATRIX_WORLDS } from "../../../src/application/verification/index.ts";
import type { Probe } from "../../../src/domain/verification/index.ts";
import { fc } from "../../support/fast-check.ts";

const ulid = (n: number): string => String(n).padStart(26, "0");
const A = makeId("chg", ulid(1));
const B = makeId("chg", ulid(2));
const hash = (n: number) => ContentHash.make(`sha256:${String(n).padStart(64, "0")}`);
const sha = (n: number) => CommitSha.make(String(n).padStart(40, "0"));
const evaluation = SubjectKey.make("authz.permission-evaluation");
const proposition = (
  relation: Proposition["relation"],
  value: string,
  anchors?: Proposition["anchors"],
): Proposition => ({
  subject: evaluation,
  predicate: "freshness",
  relation,
  value,
  ...(anchors === undefined ? {} : { anchors }),
});
const PARTIES: ProbeParties = {
  A,
  B,
  premise: { holder: A, proposition: proposition("at-most", "per-request") },
  effect: { changeId: B, proposition: proposition("is", "per-session") },
};

/** A full matrix: every world on every run, as the draft ran it. */
const CELLS: readonly MatrixCell[] = [1, 2, 3].flatMap((run) =>
  MATRIX_WORLDS.map((world) => ({
    world,
    run,
    outcome: "pass" as const,
    reason: "",
    observations: [],
  })),
);
const FILES = [{ path: "probe.test.ts", text: "// probe" }];

/** What a draft's report says failed it, or the report's tag when it did not fail. */
const failed = (outcome: DraftOutcome) => {
  const report = reportsOf(outcome);
  return report._tag === "DraftFailed" ? report.reason : report._tag;
};
const at = (path: string, symbol?: string) => ({
  path,
  commit: sha(3),
  ...(symbol === undefined ? {} : { symbol }),
});
/** The submission each Change shape reads as: an oracle written from the ruling, not from the code. */
const expectedSubmission = (
  state: ChangeState,
  commitSha: CommitSha | undefined,
  baseSha: CommitSha | undefined,
  landedCommit: CommitSha | undefined,
) => {
  if (state === "withdrawn" || state === "superseded") return { _tag: "Gone", state };
  if (state === "landed")
    return landedCommit === undefined
      ? { _tag: "Gone", state }
      : { _tag: "Landed", landing: landedCommit };
  return commitSha !== undefined &&
    baseSha !== undefined &&
    state !== "declared" &&
    state !== "working" &&
    state !== "bounced"
    ? { _tag: "Submitted", head: commitSha, base: baseSha }
    : { _tag: "Unsubmitted" };
};

describe("probe-conflict", () => {
  it("[probe-conflict.parties] A holds the premise and B makes the effect, and a conflict missing either is never guessed", () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), (hasPremise, hasEffect) => {
        const conflict = {
          ...(hasPremise ? { premise: PARTIES.premise } : {}),
          ...(hasEffect ? { effect: PARTIES.effect } : {}),
        };
        expect(partiesOf(conflict)).toEqual(
          hasPremise && hasEffect
            ? Result.succeed({ A, B, premise: PARTIES.premise, effect: PARTIES.effect })
            : Result.fail("no-propositions"),
        );
      }),
    );
  });

  it("[probe-conflict.submission] a party's world is the commit it last submitted, or the one it landed as, never one it has not submitted since a rebase", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ChangeState.literals),
        fc.option(fc.constant(sha(1)), { nil: undefined }),
        fc.option(fc.constant(sha(2)), { nil: undefined }),
        fc.option(fc.constant(sha(3)), { nil: undefined }),
        (state, commitSha, baseSha, landedCommit) => {
          expect(submissionStateOf({ state, commitSha, baseSha, landedCommit })).toEqual(
            expectedSubmission(state, commitSha, baseSha, landedCommit),
          );
        },
      ),
    );
  });

  it("[probe-conflict.proposal-unapproved] a proposal is no party's world until a maintainer approves the commit it carries: before that the Probe waits, and Keel drafts, builds and runs nothing of it", () => {
    const proposal = { fork: makeId("prj", ulid(9)), proposer: userActor(makeId("usr", ulid(8))) };
    fc.assert(
      fc.property(
        fc.constantFrom(...ChangeState.literals),
        fc.constantFrom(undefined, sha(1), sha(4)),
        (state, approved) => {
          const change = { state, commitSha: sha(1), baseSha: sha(2), landedCommit: sha(3) };
          const asAgents = submissionStateOf(change);
          expect(
            submissionStateOf({
              ...change,
              proposal: { ...proposal, ...(approved === undefined ? {} : { approved }) },
            }),
          ).toEqual(
            asAgents._tag === "Submitted" && approved !== sha(1)
              ? { _tag: "Unsubmitted" }
              : asAgents,
          );
        },
      ),
    );
  });

  it("[probe-conflict.plan-state] a change's plan is still to come exactly while its Precheck runs, and an earlier submission's plan is never this one's", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ChangeState.literals),
        fc.option(fc.constant(hash(7)), { nil: undefined }),
        (state, planHash) => {
          const prechecking = state === "submitted" || state === "deriving";
          expect(planStateOf({ state, planHash })).toEqual(
            prechecking
              ? { _tag: "Pending" }
              : planHash === undefined
                ? { _tag: "None", state }
                : { _tag: "Compiled", planHash },
          );
        },
      ),
    );
    // The live S-1 run's case: read a second after ChangeSubmitted, before Precheck compiled.
    expect(planStateOf({ state: "submitted", planHash: undefined })).toEqual({ _tag: "Pending" });
    // A resubmission keeps the hash of the plan before it until its own PlanCompiled.
    expect(planStateOf({ state: "deriving", planHash: hash(7) })).toEqual({ _tag: "Pending" });
    // A Precheck that refused left no plan, and none is coming.
    expect(planStateOf({ state: "bounced", planHash: undefined })).toEqual({
      _tag: "None",
      state: "bounced",
    });
    expect(planStateOf({ state: "landed", planHash: hash(7) })).toEqual({
      _tag: "Compiled",
      planHash: hash(7),
    });
  });

  it("[probe-conflict.landed-worlds] a landed side is its commit on trunk, over its first parent, and the other side composes onto it", () => {
    const trunkRepo = { namespace: "keel-core", name: "prj-trunk" };
    const wsA = { namespace: "keel-ws-00", name: "a" };
    const wsB = { namespace: "keel-ws-00", name: "b" };
    const trunk = { repo: trunkRepo, commit: sha(100) };
    const subA = { _tag: "Submitted", repo: wsA, head: sha(11), base: sha(10) } as const;
    const subB = { _tag: "Submitted", repo: wsB, head: sha(21), base: sha(20) } as const;
    const landA = { _tag: "Landed", landing: sha(31), parent: sha(30) } as const;
    const landB = { _tag: "Landed", landing: sha(41), parent: sha(40) } as const;

    expect(probeWorldPlan(subA, subB, trunk)).toEqual(
      Result.succeed({
        trunk,
        A: { repo: wsA, commit: sha(11) },
        B: { repo: wsB, commit: sha(21) },
        AB: { onto: sha(100), members: ["A", "B"] },
        hunks: {
          A: { repo: wsA, base: sha(10), head: sha(11) },
          B: { repo: wsB, base: sha(20), head: sha(21) },
        },
        source: trunk,
      }),
    );
    expect(probeWorldPlan(landA, subB, trunk)).toEqual(
      Result.succeed({
        trunk: { repo: trunkRepo, commit: sha(30) },
        A: { repo: trunkRepo, commit: sha(31) },
        B: { repo: wsB, commit: sha(21) },
        AB: { onto: sha(31), members: ["B"] },
        hunks: {
          A: { repo: trunkRepo, base: sha(30), head: sha(31) },
          B: { repo: wsB, base: sha(20), head: sha(21) },
        },
        source: { repo: trunkRepo, commit: sha(30) },
      }),
    );
    expect(probeWorldPlan(subA, landB, trunk)).toEqual(
      Result.succeed({
        trunk: { repo: trunkRepo, commit: sha(40) },
        A: { repo: wsA, commit: sha(11) },
        B: { repo: trunkRepo, commit: sha(41) },
        AB: { onto: sha(41), members: ["A"] },
        hunks: {
          A: { repo: wsA, base: sha(10), head: sha(11) },
          B: { repo: trunkRepo, base: sha(40), head: sha(41) },
        },
        source: { repo: trunkRepo, commit: sha(40) },
      }),
    );
    expect(probeWorldPlan(landA, landB, trunk)).toEqual(Result.fail("party-gone"));
  });

  it("[probe-conflict.reports] an admitted draft is drafted with every cell and the files its guard commits", () => {
    const outcome: DraftOutcome = {
      _tag: "Admitted",
      probe: hash(1),
      files: FILES,
      cells: CELLS,
      attempts: 2,
    };
    expect(reportsOf(outcome)).toEqual({
      _tag: "Drafted",
      attempts: 2,
      probe: hash(1),
      cells: CELLS,
      files: FILES,
    });
  });

  it("[probe-conflict.reports] a probe that ran clean and was not admitted is still drafted with every cell and its files, for the domain to decide", () => {
    for (const reason of ["non-discriminating", "unstable"] as const) {
      const outcome: DraftOutcome = {
        _tag: "Discarded",
        reason,
        attempts: 1,
        feedback: [],
        ran: { probe: hash(2), files: FILES, cells: CELLS },
      };
      expect(reportsOf(outcome)).toEqual({
        _tag: "Drafted",
        attempts: 1,
        probe: hash(2),
        cells: CELLS,
        files: FILES,
      });
    }
  });

  it("[probe-conflict.reports] a draft that ended with no probe to run fails with why", () => {
    expect(failed({ _tag: "Abstained", reason: "refused", attempts: 1, feedback: [] })).toBe(
      "abstained",
    );
    expect(failed({ _tag: "Discarded", reason: "incomplete", attempts: 1, feedback: [] })).toBe(
      "incomplete",
    );
    expect(
      failed({ _tag: "Discarded", reason: "repairs-exhausted", attempts: 4, feedback: [] }),
    ).toBe("repairs-exhausted");
  });

  it("[probe-conflict.reports] A and B that do not compose leave the conflict unprobed, and no world stands in for AB", () => {
    expect(draftWorlds({ trunk: hash(10), A: hash(11), B: hash(12) })).toEqual(
      Result.fail("worlds-unbuildable"),
    );
    expect(draftWorlds({ trunk: hash(10), A: hash(11), B: hash(12), AB: hash(13) })).toEqual(
      Result.succeed({ trunk: hash(10), A: hash(11), B: hash(12), AB: hash(13) }),
    );
  });

  it("[probe-conflict.guard] only an admitted probe becomes a guard, guarding the premise it was drafted for", () => {
    const probe = (state: Probe["state"], guardId?: Probe["guardId"]): Probe => ({
      id: makeId("prb", ulid(1)),
      conflictId: makeId("cfl", ulid(1)),
      state,
      attempts: 1,
      bundleHash: hash(1),
      cells: [],
      ...(guardId === undefined ? {} : { guardId }),
      createdAt: Instant(0),
    });
    const GUARD = makeId("grd", ulid(1));
    expect(guardOf(undefined, PARTIES)).toBeUndefined();
    expect(guardOf(probe("calibrating"), PARTIES)).toBeUndefined();
    expect(guardOf(probe("discarded"), PARTIES)).toBeUndefined();
    expect(guardOf(probe("admitted", GUARD), PARTIES)).toEqual({
      guardId: GUARD,
      probe: hash(1),
      proposition: PARTIES.premise.proposition,
    });
  });

  it("[probe-conflict.anchors] a draft names the code the premise and the effect anchor, premise first, each once", () => {
    const parties: ProbeParties = {
      ...PARTIES,
      premise: {
        holder: A,
        proposition: proposition("at-most", "per-request", [at("src/a.ts", "f"), at("src/b.ts")]),
      },
      effect: {
        changeId: B,
        proposition: proposition("is", "per-session", [at("src/b.ts"), at("src/c.ts", "g")]),
      },
    };
    expect(anchorsOf(parties)).toEqual(["src/a.ts f", "src/b.ts", "src/c.ts g"]);
  });

  it("[probe-conflict.world-checks] each party's suite runs in its own world and both run in AB, and trunk's on trunk", () => {
    expect(worldChecks(PARTIES)).toEqual([
      { world: "trunk", check: "suite:trunk" },
      { world: "A", check: `suite:${A}` },
      { world: "B", check: `suite:${B}` },
      { world: "AB", check: `suite:${A}` },
      { world: "AB", check: `suite:${B}` },
    ]);
  });
});
