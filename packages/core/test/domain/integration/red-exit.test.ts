import { Result } from "effect";
import { describe, expect, it } from "vitest";
import {
  type Change,
  type ChangeCommand,
  decideChange,
  evolveChange,
  type RequeueReason,
} from "../../../src/domain/coordination/index.ts";
import {
  type Batch,
  type BatchAttribution,
  type CandidateCommand,
  decideCandidate,
  evolveCandidate,
  planBatches,
  type RedExit,
  redExit,
  runsAlone,
} from "../../../src/domain/integration/index.ts";
import {
  type ChangeId,
  CommitSha,
  ContentHash,
  Instant,
  makeId,
} from "../../../src/domain/kernel/index.ts";
import { fc } from "../../support/fast-check.ts";

const T0 = Instant(1_760_000_000_000);
const ulid = (n: number): string => String(n).padStart(26, "0");
const BATCH = makeId("bat", ulid(1));
const PROJECT = makeId("prj", ulid(1));
const AGENT = makeId("agt", ulid(1));
const VERDICT = makeId("vrd", ulid(1));
const SHA = CommitSha.make("a".repeat(40));
const PLAN = ContentHash.make(`sha256:${"0".repeat(64)}`);
const A = makeId("chg", ulid(1));
const B = makeId("chg", ulid(2));
const C = makeId("chg", ulid(3));
const POOL: readonly ChangeId[] = [A, B, C, makeId("chg", ulid(4)), makeId("chg", ulid(5))];

const REASONS: readonly RequeueReason[] = [
  "infra-failure",
  "bisection",
  "invalidated",
  "co-member-failed",
  "textual",
  "interaction",
];

const form = (members: readonly ChangeId[]): CandidateCommand => ({
  _tag: "Form",
  laneId: "lane:default",
  projectId: PROJECT,
  members,
  base: SHA,
  predecessors: [],
  attempt: 1,
  chainEpoch: 0,
});
const assemble: CandidateCommand = {
  _tag: "Assemble",
  candidateId: makeId("cnd", ulid(1)),
  treeSha: SHA,
  composer: "gitcore",
  tier: 0,
  tierReason: "clean",
};
const start: CandidateCommand = {
  _tag: "StartVerification",
  instanceId: "verify-1",
  planHash: PLAN,
};
const bisect: CandidateCommand = {
  _tag: "Bisect",
  into: [makeId("bat", ulid(2)), makeId("bat", ulid(3))],
};

/** How the batch goes Red: a refused composition, a refused bundle, or a failed verification. */
type Failure =
  | { readonly via: "compose" }
  | { readonly via: "bundle"; readonly blame: ChangeId | "infra" }
  | { readonly via: "verify"; readonly blame: BatchAttribution };

const failing = (failure: Failure): readonly CandidateCommand[] => {
  switch (failure.via) {
    case "compose":
      return [{ _tag: "RefuseComposition", verdictId: VERDICT }];
    case "bundle":
      return [assemble, { _tag: "RefuseBundle", verdictId: VERDICT, attribution: failure.blame }];
    case "verify":
      return [
        assemble,
        start,
        {
          _tag: "Failed",
          verdictId: VERDICT,
          attribution: failure.blame,
          attempt: 1,
          chainEpoch: 0,
        },
      ];
    default: {
      const unreachable: never = failure;
      return unreachable;
    }
  }
};

/** Plays commands on the real Candidate machine; undefined when any is refused. */
const candidate = (commands: readonly CandidateCommand[]): Batch | undefined => {
  let state: Batch | undefined;
  for (const command of commands) {
    const decided = decideCandidate(state, command, { now: T0, batchId: BATCH });
    if (Result.isFailure(decided)) return undefined;
    state = decided.success.reduce<Batch | undefined>(
      (s, payload) => evolveCandidate(s, { at: T0, payload }),
      state,
    );
  }
  return state;
};

const integrating = (id: ChangeId): Change => ({
  id,
  agentId: AGENT,
  origin: "agent",
  state: "integrating",
  intent: { revision: 1, goal: "cache the session", footprint: [], premises: [] },
  lease: { id: makeId("lse", ulid(1)), agentId: AGENT, renewedAt: T0, state: "active" },
  createdAt: T0,
  workspaceId: makeId("wsp", ulid(1)),
  commitSha: SHA,
  laneId: "lane:default",
  batchId: BATCH,
});

/** The Change command a member's exit becomes; a Bisection waits for CandidateBisected, if the batch can be bisected. */
const commandOf = (exit: RedExit, red: Batch): ChangeCommand | undefined => {
  switch (exit._tag) {
    case "Bounce":
      return {
        _tag: "Bounce",
        verdictId: VERDICT,
        reasons: ["a step failed"],
        nextActions: [],
        batchId: BATCH,
      };
    case "Requeue":
      return { _tag: "Requeue", batchId: BATCH, reason: exit.reason };
    case "Bisection":
      return Result.isSuccess(decideCandidate(red, bisect, { now: T0, batchId: BATCH }))
        ? { _tag: "Requeue", batchId: BATCH, reason: "bisection" }
        : undefined;
    default: {
      const unreachable: never = exit;
      return unreachable;
    }
  }
};

type Outcome = {
  readonly member: ChangeId;
  readonly state: Change["state"];
  readonly reason?: RequeueReason;
};

/** Every member's exit from a Red batch, played on the real Change machine from Integrating. */
const exits = (red: Batch): readonly Outcome[] => {
  const attribution = red.attribution;
  if (attribution === undefined) throw new Error("a Red batch carries its attribution");
  return red.members.map((member) => {
    const before = integrating(member);
    const command = commandOf(redExit(attribution, member), red);
    if (command === undefined) return { member, state: before.state };
    const decided = decideChange(before, command, { now: T0, changeId: member });
    if (Result.isFailure(decided)) return { member, state: before.state };
    const after = decided.success.reduce(
      (s, payload) => evolveChange(s, { at: T0, payload }),
      before,
    );
    const requeued = decided.success.find((e) => e._tag === "ChangeRequeued");
    return {
      member,
      state: after.state,
      ...(requeued?._tag === "ChangeRequeued" ? { reason: requeued.reason } : {}),
    };
  });
};

const membersArb = fc
  .integer({ min: 1, max: 4 })
  .chain((n) => fc.shuffledSubarray([...POOL], { minLength: n, maxLength: n }));
const failureArb = (members: readonly ChangeId[]): fc.Arbitrary<Failure> =>
  fc.oneof(
    fc.constant({ via: "compose" as const }),
    fc.record({
      via: fc.constant("bundle" as const),
      blame: fc.constantFrom<ChangeId | "infra">("infra", ...members),
    }),
    fc.record({
      via: fc.constant("verify" as const),
      blame: fc.constantFrom<BatchAttribution>(
        "infra",
        "interaction",
        "unattributed",
        "textual",
        ...members,
      ),
    }),
  );

/** A batch the Candidate machine took to Red, or undefined when it refused the failure. */
const redArb: fc.Arbitrary<Batch | undefined> = membersArb.chain((members) =>
  failureArb(members).map((failure) => {
    const red = candidate([form(members), ...failing(failure)]);
    return red?.state === "red" ? red : undefined;
  }),
);

/** What the docs say a Requeue's reason is, by the failure's cause. */
const causeOf = (attribution: BatchAttribution): RequeueReason => {
  switch (attribution) {
    case "infra":
      return "infra-failure";
    case "textual":
      return "textual";
    case "interaction":
      return "interaction";
    case "unattributed":
      return "bisection";
    default:
      return "co-member-failed";
  }
};

const redOf = (members: readonly ChangeId[], failure: Failure): Batch => {
  const red = candidate([form(members), ...failing(failure)]);
  if (red?.state !== "red") throw new Error("the example must go Red");
  return red;
};

describe("a Red batch's members", () => {
  it("[red.every-member-leaves] every member of a Red batch ends Bounced or Queued, never Integrating", () => {
    let multi = 0;
    fc.assert(
      fc.property(redArb, (red) => {
        if (red === undefined) return true;
        if (red.members.length > 1) multi++;
        return exits(red).every((o) => o.state === "bounced" || o.state === "queued");
      }),
    );
    expect(multi).toBeGreaterThan(0);
    expect(exits(redOf([A, B, C], { via: "verify", blame: B })).map((o) => o.state)).toEqual([
      "queued",
      "bounced",
      "queued",
    ]);
    expect(exits(redOf([A, B], { via: "compose" })).map((o) => o.state)).toEqual([
      "queued",
      "queued",
    ]);
  });

  it("[red.only-blamed-bounces] exactly the member the failure names bounces; infra, textual, interaction and unattributed bounce nobody", () => {
    fc.assert(
      fc.property(redArb, (red) => {
        if (red === undefined) return true;
        const bounced = exits(red)
          .filter((o) => o.state === "bounced")
          .map((o) => o.member);
        const named = red.members.filter((m) => m === red.attribution);
        return bounced.length === named.length && bounced.every((m, i) => m === named[i]);
      }),
    );
    expect(
      exits(redOf([A, B], { via: "verify", blame: "infra" })).filter((o) => o.state === "bounced"),
    ).toEqual([]);
    expect(exits(redOf([A], { via: "compose" })).map((o) => o.state)).toEqual(["bounced"]);
  });

  it("[red.reason-names-cause] every requeued member's reason is its failure's cause, never another's", () => {
    const seen = new Set<RequeueReason>();
    fc.assert(
      fc.property(redArb, (red) => {
        if (red === undefined || red.attribution === undefined) return true;
        const cause = causeOf(red.attribution);
        return exits(red).every((o) => {
          if (o.reason !== undefined) seen.add(o.reason);
          return o.state !== "queued" || o.reason === cause;
        });
      }),
    );
    expect([...seen].toSorted()).toEqual([
      "bisection",
      "co-member-failed",
      "infra-failure",
      "interaction",
      "textual",
    ]);
    expect(exits(redOf([A, B], { via: "bundle", blame: "infra" })).map((o) => o.reason)).toEqual([
      "infra-failure",
      "infra-failure",
    ]);
  });

  it("[red.clash-runs-alone] members requeued for a clash run alone in their next batches; the others batch as before", () => {
    fc.assert(
      fc.property(
        redArb,
        fc.uniqueArray(fc.constantFrom(...POOL.map((_, i) => makeId("chg", ulid(100 + i)))), {
          maxLength: 3,
        }),
        (red, others) => {
          if (red === undefined) return true;
          const requeued = exits(red).filter((o) => o.reason !== undefined);
          const queue = [
            ...requeued.map((o) => ({
              id: o.member,
              effects: [],
              risky: o.reason !== undefined && runsAlone(o.reason),
            })),
            ...others.map((id) => ({ id, effects: [], risky: false })),
          ];
          const clashed = new Set(
            requeued
              .filter((o) => o.reason === "textual" || o.reason === "interaction")
              .map((o) => o.member),
          );
          return planBatches(queue, 0.01, [], 16).every(
            (batch) => !batch.some((id) => clashed.has(id)) || batch.length === 1,
          );
        },
      ),
    );
    expect(REASONS.filter(runsAlone)).toEqual(["textual", "interaction"]);
  });
});
