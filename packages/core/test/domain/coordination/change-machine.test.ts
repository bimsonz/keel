import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  type Blockers,
  Change,
  type ChangeCommand,
  ChangeBounced,
  ChangeEvent,
  ChangeParked,
  ChangeResumed,
  decideChange,
  type DerivedEffect,
  evolveChange,
  type Preflight,
  type Proposition,
  renew,
  replayChange,
  SubjectKey,
} from "../../../src/domain/coordination/index.ts";
import {
  canonicalJson,
  type ChangeId,
  CommitSha,
  type Committed,
  ContentHash,
  type DecisionId,
  type EscalationId,
  IllegalTransition,
  Instant,
  type Json,
  type LeaseId,
  makeId,
} from "../../../src/domain/kernel/index.ts";
import { propositionArb } from "../../arbitraries/coordination.ts";
import { fc } from "../../support/fast-check.ts";
import { assertReaching } from "../../support/reach.ts";
import { foldsOf, offChart, uncovered, type View } from "../../charts/conformance.ts";
import { changeChart, leaseChart } from "../../charts/charts.ts";
import { type Fold, type Machine, memo, tour } from "../../support/machine.ts";

// The lease TTL as the docs state it (state-machines.md § Lease), typed here rather than imported.
const TTL = 15 * 60 * 1000;
const T0 = Instant(1_760_000_000_000);

const ulid = (n: number): string => String(n).padStart(26, "0");
const CHANGE = makeId("chg", ulid(1));
const AGENT = makeId("agt", ulid(1));
const MAINTAINER = makeId("usr", ulid(1));
const NEVER_ISSUED = makeId("lse", "Z".repeat(26));
const SHA = CommitSha.make("c".repeat(40));
const BASE = CommitSha.make("b".repeat(40));
const PLAN_HASH = ContentHash.make(`sha256:${"0".repeat(64)}`);
/** The member's commit on trunk, as TrunkAdvanced's landing carries it: never the submitted one. */
const ON_TRUNK = CommitSha.make("e".repeat(40));
/** The commits a workspace is rebased onto, and a base the change never had. */
const REBASED = CommitSha.make("f".repeat(40));
const NEVER_BASE = CommitSha.make("9".repeat(40));
/** What an extractor read in the submitted commit: a ruling, anchored where it read it. */
const DERIVED: DerivedEffect = {
  proposition: {
    subject: SubjectKey.make("authz.permission-evaluation"),
    predicate: "freshness",
    relation: "is",
    value: "per-session",
  },
  anchors: [{ path: "src/authz/cache.ts", symbol: "RoleCache.get", commit: SHA }],
  declared: false,
  method: "extractor",
  evidenceClass: "ruling",
};
const preflight: Preflight = {
  neighbours: [],
  contradictions: [],
  precedents: [],
  suggestedMove: "proceed",
};

type Kind = ChangeCommand["_tag"] | "Renew";
type Key =
  | "none"
  | Exclude<Change["state"], "parked">
  | "parked:awaiting-ruling"
  | "parked:lease-lapsed";
type Decision = ReturnType<typeof decideChange>;

const ALL: readonly Kind[] = [
  "Declare",
  "Start",
  "Revise",
  "Rely",
  "Rebase",
  "Submit",
  "StartPrecheck",
  "DeriveEffects",
  "Drift",
  "CompilePlan",
  "Queue",
  "Park",
  "Batch",
  "Requeue",
  "Bounce",
  "Land",
  "Resume",
  "Adopt",
  "Lapse",
  "Withdraw",
  "Supersede",
  "NoteConflict",
  "Renew",
];

/** Per state, the command that moves a change along the happy path, from state-machines.md. */
const PROGRESS: Readonly<Record<Key, readonly Kind[]>> = {
  none: ["Declare"],
  declared: ["Start"],
  working: ["Submit"],
  submitted: ["StartPrecheck"],
  // One pass in three records what it derived before it compiles.
  deriving: ["CompilePlan", "CompilePlan", "DeriveEffects"],
  drifted: ["Revise"],
  verifying: ["Queue"],
  queued: ["Batch"],
  integrating: ["Land"],
  bounced: ["Submit"],
  "parked:awaiting-ruling": ["Resume"],
  "parked:lease-lapsed": ["Adopt"],
  landed: ALL,
  withdrawn: ALL,
  superseded: ALL,
};

/** Per state, the table's other exits, and the lease's own commands. */
const SIDE: Readonly<Record<Key, readonly Kind[]>> = {
  none: ["Declare"],
  declared: ["Lapse", "Adopt", "Renew"],
  working: ["Revise", "Rely", "Rebase", "Lapse", "Adopt", "Renew"],
  submitted: ["Lapse", "Adopt", "Renew"],
  deriving: ["Drift", "Bounce", "Lapse", "Adopt"],
  drifted: ["Lapse", "Adopt", "Renew"],
  verifying: ["Park", "Bounce", "Lapse", "Adopt"],
  queued: ["Park", "Bounce", "Lapse", "Supersede"],
  integrating: ["Requeue", "Bounce", "Lapse", "Adopt"],
  bounced: ["Revise", "Rebase", "Lapse", "Adopt", "Renew"],
  "parked:awaiting-ruling": ["Bounce", "Adopt", "Lapse", "Supersede"],
  "parked:lease-lapsed": ["Withdraw", "Supersede"],
  landed: ALL,
  withdrawn: ALL,
  superseded: ALL,
};

const keyOf = (c: Change | undefined): Key =>
  c === undefined
    ? "none"
    : c.state === "parked"
      ? `parked:${c.parkReason ?? "awaiting-ruling"}`
      : c.state;
const terminal = (k: Key): boolean => k === "landed" || k === "withdrawn" || k === "superseded";
const agentOwned = (k: Key): boolean =>
  k === "declared" || k === "working" || k === "drifted" || k === "bounced";
const lapsedAt = (c: Change, now: number): boolean =>
  c.lease.state === "lapsed" || (c.lease.state === "active" && now - c.lease.renewedAt >= TTL);

interface Step {
  /** Steer the run along the happy path, down a side exit, or anywhere at all. */
  readonly mode: "progress" | "side" | "any";
  readonly pick: number;
  readonly dt: number;
  readonly stale: boolean;
  readonly blocked: boolean;
  /** A person has yet to rule on one of the change's conflicts when this step's blockers are read. */
  readonly awaited: boolean;
  readonly flag: boolean;
  readonly operator: boolean;
}

const weighted = (yes: number, no: number): fc.Arbitrary<boolean> =>
  fc.oneof(
    { weight: yes, arbitrary: fc.constant(true) },
    { weight: no, arbitrary: fc.constant(false) },
  );

const stepArb: fc.Arbitrary<Step> = fc.record({
  mode: fc.oneof(
    { weight: 6, arbitrary: fc.constant("progress" as const) },
    { weight: 3, arbitrary: fc.constant("side" as const) },
    { weight: 1, arbitrary: fc.constant("any" as const) },
  ),
  pick: fc.nat(),
  dt: fc.oneof(
    { weight: 10, arbitrary: fc.integer({ min: 0, max: 120_000 }) },
    { weight: 1, arbitrary: fc.integer({ min: TTL - 60_000, max: TTL + 60_000 }) },
  ),
  stale: weighted(1, 7),
  blocked: weighted(1, 3),
  awaited: weighted(1, 4),
  flag: weighted(7, 1),
  operator: weighted(1, 1),
});

interface Plan {
  readonly premises: readonly Proposition[];
  readonly steps: readonly Step[];
}

const planArb: fc.Arbitrary<Plan> = fc.record({
  premises: fc.array(propositionArb(), { minLength: 1, maxLength: 3 }),
  steps: fc.array(stepArb, { minLength: 8, maxLength: 48 }),
});

/** A command tried on a state without being applied: what decide said, and the state its events lead to. */
interface Probe {
  readonly command: ChangeCommand;
  readonly result: Decision;
  readonly key: Key | "threw" | undefined;
}

interface Played {
  readonly kind: Kind;
  /** Every command kind, tried on `before` with this step's parameters. */
  readonly probes: readonly Probe[];
  readonly before: Change | undefined;
  readonly now: Instant;
  readonly step: Step;
  readonly command?: ChangeCommand;
  readonly result?: Decision;
  readonly after: Change | undefined;
  readonly threw: boolean;
  /**
   * While `before` is parked awaiting a ruling: the change as it stood just
   * before that park, kept by the harness as it happened and never read back
   * from the change.
   */
  readonly held: Change | undefined;
}

interface Trace {
  readonly records: readonly Played[];
  readonly log: readonly Committed<ChangeEvent>[];
  readonly final: Change | undefined;
}

/** Mints ids for one run, so adoption and batching always get fresh ones. */
class Mint {
  private n = 100;
  next<
    P extends "lse" | "agt" | "bat" | "cfl" | "grd" | "vrd" | "esc" | "dec" | "chg" | "cnd" | "wsp",
  >(prefix: P) {
    this.n += 1;
    return makeId(prefix, ulid(this.n));
  }
}

const tokenFor = (state: Change | undefined, step: Step, issued: readonly LeaseId[]): LeaseId => {
  if (state === undefined || !step.stale) return state?.lease.id ?? NEVER_ISSUED;
  const old = issued.filter((l) => l !== state.lease.id);
  return old[step.pick % (old.length + 1)] ?? NEVER_ISSUED;
};

const blockersFor = (step: Step, mint: Mint) => {
  const which = step.pick % 3;
  return {
    openProvenConflicts: step.blocked && which === 0 ? [mint.next("cfl")] : [],
    failingGuards: step.blocked && which === 1 ? [mint.next("grd")] : [],
    unresolvedHighDrift:
      step.blocked && which === 2
        ? [
            {
              class: "silent-retraction" as const,
              severity: "high" as const,
              detail: "retracts a must premise",
            },
          ]
        : [],
    awaitingRuling: step.awaited ? [mint.next("esc")] : [],
  };
};

const build = (
  kind: Exclude<Kind, "Renew">,
  state: Change | undefined,
  step: Step,
  plan: Plan,
  mint: Mint,
  issued: readonly LeaseId[],
): ChangeCommand => {
  const token = tokenFor(state, step, issued);
  const premise = plan.premises[step.pick % plan.premises.length] ?? plan.premises[0];
  const revision = state?.intent.revision ?? 1;
  switch (kind) {
    case "Declare":
      return {
        _tag: "Declare",
        changeId: CHANGE,
        agentId: AGENT,
        origin: "agent",
        goal: "cache the session",
        footprint: [],
        premises: plan.premises,
        leaseId: mint.next("lse"),
        preflight,
      };
    case "Start":
      return { _tag: "Start", workspaceId: mint.next("wsp"), baseSha: BASE };
    case "Revise":
      return {
        _tag: "Revise",
        leaseId: token,
        ifMatchRevision: step.flag ? revision : revision + 1,
        premisesAdded: step.operator && premise !== undefined ? [premise] : [],
        premisesRetracted: !step.operator && premise !== undefined ? [premise] : [],
        preflight,
      };
    case "Rely":
      return premise === undefined
        ? { _tag: "Lapse", leaseId: token }
        : { _tag: "Rely", leaseId: token, premise, preflight };
    case "Rebase": {
      // From the current base or one it never had; onto the other rebase target, or back onto itself.
      const from = step.flag ? (state?.baseSha ?? BASE) : NEVER_BASE;
      const onto = step.blocked ? from : from === REBASED ? BASE : REBASED;
      return { _tag: "Rebase", leaseId: token, from, onto };
    }
    case "Submit":
      return { _tag: "Submit", leaseId: token, commitSha: SHA, inWorkspace: step.flag };
    case "StartPrecheck":
      return { _tag: "StartPrecheck", instanceId: `precheck-${step.pick}` };
    case "DeriveEffects":
      return {
        _tag: "DeriveEffects",
        effects: step.flag ? [] : [DERIVED],
        derivationRef: `mfp:derivation:${step.pick}`,
      };
    case "Drift":
      return {
        _tag: "Drift",
        blocking: [
          {
            class: "undeclared-effect",
            severity: "medium",
            detail: "undeclared proof-class effect",
          },
        ],
      };
    case "CompilePlan":
      return {
        _tag: "CompilePlan",
        drift: step.flag
          ? []
          : [{ class: "footprint", severity: "low", detail: "outside the footprint" }],
        planHash: PLAN_HASH,
        steps: 3,
        costEstimate: 1.5,
        ...(step.operator ? { predicatePolicy: { freshness: "block" } } : {}),
      };
    case "Queue":
      return { _tag: "Queue", laneId: "lane:default", blockers: blockersFor(step, mint) };
    case "Park":
      return { _tag: "Park", escalationId: mint.next("esc") };
    case "Batch":
      return { _tag: "Batch", batchId: mint.next("bat"), blockers: blockersFor(step, mint) };
    case "Requeue":
      return {
        _tag: "Requeue",
        batchId: step.flag && state?.batchId !== undefined ? state.batchId : mint.next("bat"),
        reason: "infra-failure",
      };
    case "Bounce":
      // Now and then promotion declined the change's batch: its own batch, or one it was never in.
      if (step.pick % 4 === 3)
        return {
          _tag: "Bounce",
          declined: {
            batchId: step.flag && state?.batchId !== undefined ? state.batchId : mint.next("bat"),
            reason: step.operator ? "repo-bytes-quota" : "pack-too-large",
          },
          reasons: ["the promotion's push was refused"],
          nextActions: step.blocked
            ? [{ kind: "call", title: "Submit a smaller commit", operationId: "submit" }]
            : [],
        };
      return {
        _tag: "Bounce",
        // A conflict proven under block half the time, else the verdict that failed it.
        ...(step.operator ? { conflictId: mint.next("cfl") } : { verdictId: mint.next("vrd") }),
        reasons: ["a guard failed"],
        nextActions: step.flag
          ? [{ kind: "call", title: "Revise and resubmit", operationId: "revise" }]
          : [],
        ...(state?.batchId === undefined
          ? {}
          : { batchId: step.flag ? state.batchId : mint.next("bat") }),
      };
    case "Land":
      return {
        _tag: "Land",
        commitSha: ON_TRUNK,
        trunkSha: CommitSha.make("d".repeat(40)),
        candidateId: mint.next("cnd"),
        proofId: "proof",
      };
    case "Resume":
      return {
        _tag: "Resume",
        decisionId: mint.next("dec"),
        // Another of its conflicts is still with a person as often as a batch's blockers say one is.
        awaitingRuling: step.awaited ? [mint.next("esc")] : [],
      };
    case "Adopt":
      return {
        _tag: "Adopt",
        agentId: mint.next("agt"),
        leaseId: mint.next("lse"),
        briefRef: "brief",
      };
    case "Lapse":
      return { _tag: "Lapse", leaseId: token };
    case "Withdraw":
      return {
        _tag: "Withdraw",
        authority: step.operator
          ? { _tag: "Maintainer", by: MAINTAINER }
          : { _tag: "Lease", leaseId: token },
      };
    case "Supersede":
      return { _tag: "Supersede", by: mint.next("chg") };
    case "NoteConflict":
      return {
        _tag: "NoteConflict",
        conflictId: mint.next("cfl"),
        predicate: "freshness",
        policy: step.operator ? "advise" : "annotate",
        ...(step.flag ? { evidenceRef: `probe:${makeId("prb", ulid(step.pick % 1000))}` } : {}),
      };
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
};

const attempt = (state: Change | undefined, command: ChangeCommand, now: Instant): Probe => {
  const result = decideChange(state, command, { now, changeId: CHANGE });
  if (Result.isFailure(result)) return { command, result, key: undefined };
  try {
    return {
      command,
      result,
      key: keyOf(
        result.success.reduce<Change | undefined>(
          (s, payload) => evolveChange(s, { at: now, payload }),
          state,
        ),
      ),
    };
  } catch (error) {
    if (!(error instanceof IllegalTransition)) throw error;
    return { command, result, key: "threw" };
  }
};

const leaseCarried = (command: ChangeCommand): LeaseId | undefined =>
  command._tag === "Revise" ||
  command._tag === "Rely" ||
  command._tag === "Rebase" ||
  command._tag === "Submit"
    ? command.leaseId
    : command._tag === "Withdraw" && command.authority._tag === "Lease"
      ? command.authority.leaseId
      : undefined;

/** What the harness holds once a step is played: the change before a park that just happened, what it held while the wait goes on, nothing after it. */
const heldAfter = (
  held: Change | undefined,
  before: Change | undefined,
  after: Change | undefined,
  events: readonly ChangeEvent[],
): Change | undefined => {
  if (keyOf(after) !== "parked:awaiting-ruling") return undefined;
  // A park that finds it already waiting moves the question it waits on, never where it waits from.
  return keyOf(before) !== "parked:awaiting-ruling" &&
    events.some((e) => e._tag === "ChangeParked" && e.reason === "awaiting-ruling")
    ? before
    : held;
};

/** The decision of a ruling that goes against the change. */
const RULING = makeId("dec", ulid(77));
/** The ruling a change was parked for went against it. No step of a plan draws it, so every step tries it. */
const ruledAgainst: ChangeCommand = {
  _tag: "Bounce",
  decisionId: RULING,
  reasons: ["the ruling let the other side stand"],
  nextActions: [],
};

/** The question a park names for a change that waits on none. */
const QUESTION = makeId("esc", ulid(78));
/** A park under the question the change already waits on. `build` mints a new question every time, so every step tries this one. */
const parkedAgain = (change: Change | undefined): ChangeCommand => ({
  _tag: "Park",
  escalationId: change?.escalationId ?? QUESTION,
});

/** A park under one question, and a resume on a decision with the questions still open beside it. */
const parkUnder = (escalationId: EscalationId): ChangeCommand => ({ _tag: "Park", escalationId });
const resumeOn = (
  decisionId: DecisionId,
  ...awaitingRuling: readonly EscalationId[]
): ChangeCommand => ({ _tag: "Resume", decisionId, awaitingRuling });

/** Plays a plan the way the Change DO would: decide, commit each event through evolve, renew the lease on an authorised call. */
const play = (plan: Plan): Trace => {
  const mint = new Mint();
  const records: Played[] = [];
  const log: Committed<ChangeEvent>[] = [];
  const issued: LeaseId[] = [];
  let state: Change | undefined;
  let held: Change | undefined;
  let now = T0;
  for (const step of plan.steps) {
    now = Instant(now + step.dt);
    const choices =
      step.mode === "progress"
        ? PROGRESS[keyOf(state)]
        : step.mode === "side"
          ? SIDE[keyOf(state)]
          : ALL;
    const before = state;
    const probes = [
      ...ALL.flatMap((k) =>
        k === "Renew" ? [] : [attempt(before, build(k, before, step, plan, mint, issued), now)],
      ),
      attempt(before, ruledAgainst, now),
      attempt(before, parkedAgain(before), now),
    ];
    const kind = choices[step.pick % choices.length] ?? "Lapse";
    if (kind === "Renew") {
      const renewed =
        state === undefined ? undefined : renew(state, tokenFor(state, step, issued), now);
      const after = renewed !== undefined && Result.isSuccess(renewed) ? renewed.success : state;
      records.push({ kind, probes, before: state, now, step, after, threw: false, held });
      state = after;
      continue;
    }
    const command = build(kind, state, step, plan, mint, issued);
    const result = decideChange(state, command, { now, changeId: CHANGE });
    let after = state;
    let threw = false;
    if (Result.isSuccess(result)) {
      try {
        for (const payload of result.success) {
          const committed = { at: now, payload };
          after = evolveChange(after, committed);
          log.push(committed);
        }
      } catch (error) {
        if (!(error instanceof IllegalTransition)) throw error;
        threw = true;
      }
      if (command._tag === "Declare" || command._tag === "Adopt") issued.push(command.leaseId);
      const carried = leaseCarried(command);
      if (!threw && after !== undefined && carried !== undefined) {
        const renewed = renew(after, carried, now);
        if (Result.isSuccess(renewed)) after = renewed.success;
      }
    }
    records.push({ kind, probes, before: state, now, step, command, result, after, threw, held });
    if (threw) break;
    held = heldAfter(held, state, after, Result.isSuccess(result) ? result.success : []);
    state = after;
  }
  return { records, log, final: state };
};

const run = memo(play);

/** What stops a queueing. An awaited ruling is not one of them: it holds a change out of a batch only. */
const anyBlocker = (b: Blockers): boolean =>
  b.openProvenConflicts.length + b.failingGuards.length + b.unresolvedHighDrift.length > 0;

/**
 * The docs' table, typed independently of `decideChange`: the state a command
 * leads to, `"refused"`, or `"noop"` for an alarm with nothing to do.
 */
const oracle = (
  before: Change | undefined,
  command: ChangeCommand,
  now: number,
  /** The state a change parked awaiting a ruling was parked from, as the harness saw it. */
  parkedFrom: Key,
): Key | "refused" | "noop" => {
  const key = keyOf(before);
  if (before === undefined) return command._tag === "Declare" ? "declared" : "refused";
  if (terminal(key) || command._tag === "Declare") return "refused";
  const carried = leaseCarried(command);
  if (carried !== undefined && (carried !== before.lease.id || lapsedAt(before, now)))
    return "refused";
  const intoAgent = (k: Key): Key => (lapsedAt(before, now) ? "parked:lease-lapsed" : k);
  const batchMatches = (batchId: string | undefined) =>
    batchId !== undefined && batchId === before.batchId;
  switch (command._tag) {
    case "Start":
      return key === "declared" ? "working" : "refused";
    case "Revise":
      return (key === "working" || key === "drifted" || key === "bounced") &&
        command.ifMatchRevision === before.intent.revision
        ? "working"
        : "refused";
    case "Rely":
      return key === "working" ? "working" : "refused";
    case "Rebase":
      return (key === "working" || key === "bounced") &&
        before.baseSha !== undefined &&
        command.from === before.baseSha &&
        command.onto !== command.from
        ? key
        : "refused";
    case "Submit":
      return (key === "working" || key === "bounced") && command.inWorkspace
        ? "submitted"
        : "refused";
    case "StartPrecheck":
      return key === "submitted" ? "deriving" : "refused";
    case "DeriveEffects":
      return key === "deriving" && before.derivationRef === undefined ? "deriving" : "refused";
    case "Drift":
      return key === "deriving" ? intoAgent("drifted") : "refused";
    case "CompilePlan":
      return key === "deriving" ? "verifying" : "refused";
    case "Queue":
      return key === "verifying" && !anyBlocker(command.blockers) ? "queued" : "refused";
    case "Park":
      // From the wait itself too, for another question than the one it waits on.
      return key === "verifying" ||
        key === "queued" ||
        (key === "parked:awaiting-ruling" && command.escalationId !== before.escalationId)
        ? "parked:awaiting-ruling"
        : "refused";
    case "Batch":
      return key === "queued" &&
        !anyBlocker(command.blockers) &&
        command.blockers.awaitingRuling.length === 0
        ? "integrating"
        : "refused";
    case "Requeue":
      return key === "integrating" && batchMatches(command.batchId) ? "queued" : "refused";
    case "Bounce":
      // A declined batch bounces only its own members, while they are in it.
      if (command.declined !== undefined)
        return key === "integrating" && batchMatches(command.declined.batchId)
          ? intoAgent("bounced")
          : "refused";
      // A ruling's decision bounces a change only while it is parked for that ruling.
      if (command.decisionId !== undefined)
        return key === "parked:awaiting-ruling" ? intoAgent("bounced") : "refused";
      // A conflict bounces a change only before it is batched; a verdict also from a batch or a ruling.
      return key === "deriving" ||
        key === "verifying" ||
        key === "queued" ||
        (command.conflictId === undefined &&
          (key === "parked:awaiting-ruling" ||
            (key === "integrating" && batchMatches(command.batchId))))
        ? intoAgent("bounced")
        : "refused";
    case "NoteConflict":
      return key;
    case "Land":
      return key === "integrating" ? "landed" : "refused";
    case "Resume":
      // Back to where it was parked from, once no other question holds it.
      return key === "parked:awaiting-ruling" && command.awaitingRuling.length === 0
        ? parkedFrom
        : "refused";
    case "Adopt":
      if (!lapsedAt(before, now)) return "refused";
      return key === "parked:lease-lapsed"
        ? before.workspaceId === undefined
          ? "declared"
          : "working"
        : key;
    case "Lapse":
      if (
        command.leaseId !== before.lease.id ||
        before.lease.state !== "active" ||
        now - before.lease.renewedAt < TTL
      )
        return "noop";
      return agentOwned(key) ? "parked:lease-lapsed" : key;
    case "Withdraw":
      return key === "integrating" ? "refused" : "withdrawn";
    case "Supersede":
      return key === "integrating" ? "refused" : "superseded";
    default: {
      const unreachable: never = command;
      return unreachable;
    }
  }
};

const decided = (
  r: Played,
): r is Played & { readonly command: ChangeCommand; readonly result: Decision } =>
  r.command !== undefined && r.result !== undefined;
const accepted = (r: Played): boolean => r.result !== undefined && Result.isSuccess(r.result);
const eventsOf = (r: Played): readonly ChangeEvent[] =>
  r.result !== undefined && Result.isSuccess(r.result) ? r.result.success : [];
const refusal = (r: Played) =>
  r.result !== undefined && Result.isFailure(r.result) ? r.result.failure : undefined;

const TERMINAL_EVENTS = new Set(["ChangeLanded", "ChangeWithdrawn", "ChangeSuperseded"]);

const asJson = (value: unknown): Json => JSON.parse(JSON.stringify(value));

/** The change as its JSON, without the renewal time a replay cannot know. */
const comparable = (c: Change | undefined): string =>
  c === undefined
    ? "none"
    : canonicalJson(
        asJson(Schema.encodeSync(Change)({ ...c, lease: { ...c.lease, renewedAt: Instant(0) } })),
      );

const Wire = Schema.Array(Schema.Struct({ at: Schema.Number, payload: Schema.Unknown }));

/** The log as the outbox persists it, and back: encoded, serialised, decoded. */
const throughTheWire = (log: readonly Committed<ChangeEvent>[]): Committed<ChangeEvent>[] =>
  Schema.decodeUnknownSync(Wire)(
    asJson(log.map((c) => ({ at: c.at, payload: Schema.encodeSync(ChangeEvent)(c.payload) }))),
  ).map((w) => ({
    at: Instant(w.at),
    payload: Schema.decodeUnknownSync(ChangeEvent)(w.payload),
  }));

/** Drives one explicit scenario: each entry is a command and the time that passed before it. */
const drive = (script: readonly (readonly [ChangeCommand, number])[]) => {
  let state: Change | undefined;
  let now = T0;
  const log: ChangeEvent[] = [];
  const results: Decision[] = [];
  const keys: Key[] = [];
  for (const [command, dt] of script) {
    now = Instant(now + dt);
    const result = decideChange(state, command, { now, changeId: CHANGE });
    results.push(result);
    if (Result.isSuccess(result)) {
      for (const payload of result.success) {
        state = evolveChange(state, { at: now, payload });
        log.push(payload);
      }
    }
    keys.push(keyOf(state));
  }
  return { state, log, results, keys, now };
};

const LEASE = makeId("lse", ulid(2));
const declaring = (answered: Preflight): ChangeCommand => ({
  _tag: "Declare",
  changeId: CHANGE,
  agentId: AGENT,
  origin: "agent",
  goal: "cache the session",
  footprint: [],
  premises: [],
  leaseId: LEASE,
  preflight: answered,
});
const declare = declaring(preflight);
const start: ChangeCommand = { _tag: "Start", workspaceId: makeId("wsp", ulid(3)), baseSha: BASE };
const submit: ChangeCommand = { _tag: "Submit", leaseId: LEASE, commitSha: SHA, inWorkspace: true };
const precheck: ChangeCommand = { _tag: "StartPrecheck", instanceId: "precheck-1" };
const compile: ChangeCommand = {
  _tag: "CompilePlan",
  drift: [],
  planHash: ContentHash.make(`sha256:${"0".repeat(64)}`),
  steps: 3,
  costEstimate: 1,
};
const derive: ChangeCommand = {
  _tag: "DeriveEffects",
  effects: [DERIVED],
  derivationRef: "derivation-1",
};
const drifts: ChangeCommand = {
  _tag: "Drift",
  blocking: [
    { class: "undeclared-effect", severity: "medium", detail: "undeclared proof-class effect" },
  ],
};
const tagsOf = (log: readonly ChangeEvent[]): readonly string[] => log.map((e) => e._tag);
const clear = {
  openProvenConflicts: [],
  failingGuards: [],
  unresolvedHighDrift: [],
  awaitingRuling: [],
};
const queue: ChangeCommand = { _tag: "Queue", laneId: "lane:default", blockers: clear };
const BATCH = makeId("bat", ulid(4));
const batch: ChangeCommand = { _tag: "Batch", batchId: BATCH, blockers: clear };
const land: ChangeCommand = {
  _tag: "Land",
  commitSha: ON_TRUNK,
  trunkSha: CommitSha.make("d".repeat(40)),
  candidateId: makeId("cnd", ulid(5)),
  proofId: "proof",
};
const bounce: ChangeCommand = {
  _tag: "Bounce",
  verdictId: makeId("vrd", ulid(6)),
  reasons: ["a conflict was proven"],
  nextActions: [],
};
const lapse: ChangeCommand = { _tag: "Lapse", leaseId: LEASE };
const ADOPTED = makeId("lse", ulid(7));
const adopt: ChangeCommand = {
  _tag: "Adopt",
  agentId: makeId("agt", ulid(8)),
  leaseId: ADOPTED,
  briefRef: "brief",
};
const revise = (leaseId: LeaseId, ifMatchRevision: number): ChangeCommand => ({
  _tag: "Revise",
  leaseId,
  ifMatchRevision,
  premisesAdded: [],
  premisesRetracted: [],
  preflight,
});
/** The preflight an agent is answered when exposure found these alternatives. */
const seeing = (alternatives: readonly ChangeId[]): Preflight =>
  alternatives.length === 0 ? preflight : { ...preflight, alternatives };

/**
 * The PreflightIssued events of a declare, a revise and a rely, each answered
 * a preflight naming its own list of alternatives, as the outbox stores them.
 */
const preflightsIssued = (lists: readonly (readonly ChangeId[])[], premise: Proposition) => {
  const [atDeclare = [], atRevise = [], atRely = []] = lists;
  const { log } = drive([
    [declaring(seeing(atDeclare)), 0],
    [start, 0],
    [
      {
        _tag: "Revise",
        leaseId: LEASE,
        ifMatchRevision: 1,
        premisesAdded: [],
        premisesRetracted: [],
        preflight: seeing(atRevise),
      },
      0,
    ],
    [{ _tag: "Rely", leaseId: LEASE, premise, preflight: seeing(atRely) }, 0],
  ]);
  return throughTheWire(log.map((payload) => ({ at: T0, payload })))
    .map((e) => e.payload)
    .flatMap((e) => (e._tag === "PreflightIssued" ? [e] : []));
};
const declinedBounce = (
  batchId: typeof BATCH,
  reason: "pack-too-large" | "repo-bytes-quota",
): ChangeCommand => ({
  _tag: "Bounce",
  declined: { batchId, reason },
  reasons: ["the promotion's push was refused"],
  nextActions: [],
});
const note = (policy: "advise" | "annotate"): ChangeCommand => ({
  _tag: "NoteConflict",
  conflictId: makeId("cfl", ulid(9)),
  predicate: "freshness",
  policy,
});
const withdrawByMaintainer: ChangeCommand = {
  _tag: "Withdraw",
  authority: { _tag: "Maintainer", by: MAINTAINER },
};
const tags = (log: readonly ChangeEvent[]): string[] => log.map((e) => e._tag);
/** A refusal as plain data: its tag, its reason if it has one, and what its next actions point at. */
const brief = (r: Decision | undefined) => {
  if (r === undefined || Result.isSuccess(r)) return undefined;
  const f = r.failure;
  return {
    tag: f._tag,
    reason: "reason" in f ? f.reason : undefined,
    next: (f.nextActions ?? []).map((a) => a.operationId ?? a.kind),
  };
};
const succeeded = (r: Decision | undefined): boolean => r !== undefined && Result.isSuccess(r);
const failureTag = (r: Decision | undefined): string | undefined =>
  r !== undefined && Result.isFailure(r) ? r.failure._tag : undefined;

/**
 * Each property plays hundreds of seeded runs through decide and evolve. Run
 * alone one takes about 1.5 s; inside the full unit suite on a busy runner it
 * has passed vitest's 5 s default, so it gets the arch tests' limit instead of
 * fewer runs (fewer runs would weaken every mutant's proof).
 */
const PROPERTY_TIMEOUT = 60_000;

describe("the Change machine", { timeout: PROPERTY_TIMEOUT }, () => {
  it("[change.transitions] in every state a run reaches, every command lands where the docs' table says, or is refused", () => {
    fc.assert(
      fc.property(planArb, (plan) =>
        run(plan).records.every((r) =>
          r.probes.every((probe) => {
            const expected = oracle(r.before, probe.command, r.now, keyOf(r.held));
            if (expected === "refused") return Result.isFailure(probe.result);
            if (expected === "noop")
              return Result.isSuccess(probe.result) && probe.result.success.length === 0;
            return Result.isSuccess(probe.result) && probe.key === expected;
          }),
        ),
      ),
    );
    // The S-0 walking skeleton: declare → granted → submit → precheck → plan compiled → queued → batched → trunk advanced → landed.
    const s0 = drive(
      [declare, start, submit, precheck, compile, queue, batch, land].map(
        (c) => [c, 1_000] as const,
      ),
    );
    expect(s0.keys).toEqual([
      "declared",
      "working",
      "submitted",
      "deriving",
      "verifying",
      "queued",
      "integrating",
      "landed",
    ]);
    // Precheck diffs against the base the workspace was granted at.
    expect(s0.state).toMatchObject({ baseSha: BASE, commitSha: SHA });
    expect(tags(s0.log)).toEqual([
      "IntentDeclared",
      "PreflightIssued",
      "ChangeStarted",
      "ChangeSubmitted",
      "PrecheckStarted",
      "PlanCompiled",
      "ChangeQueued",
      "ChangeBatched",
      "ChangeLanded",
    ]);
  });

  it("[change.one-terminal] a run reaches at most one terminal state, last, and a terminal state takes no command", () => {
    let terminals = 0;
    fc.assert(
      fc.property(planArb, (plan) => {
        const trace = run(plan);
        const ends = trace.log.filter((c) => TERMINAL_EVENTS.has(c.payload._tag));
        terminals += ends.length;
        const last = trace.log.at(-1);
        const absorbs = trace.records
          .filter((r) => terminal(keyOf(r.before)))
          .every((r) => !accepted(r) && r.after === r.before);
        return ends.length <= 1 && (ends.length === 0 || ends[0] === last) && absorbs;
      }),
    );
    expect(terminals).toBeGreaterThan(0);
    const landed = drive([
      ...[declare, start, submit, precheck, compile, queue, batch, land].map(
        (c) => [c, 1] as const,
      ),
      [withdrawByMaintainer, 1],
    ]);
    expect(landed.keys.at(-1)).toBe("landed");
    expect(failureTag(landed.results.at(-1))).toBe("ChangeStateRefused");
  });

  it("[change.replay] the events, encoded, serialised and decoded, replay to the same change", () => {
    fc.assert(
      fc.property(planArb, (plan) => {
        const trace = run(plan);
        const replayed = replayChange(throughTheWire(trace.log));
        const renewalBehind =
          trace.final === undefined ||
          replayed === undefined ||
          replayed.lease.renewedAt <= trace.final.lease.renewedAt;
        return comparable(replayed) === comparable(trace.final) && renewalBehind;
      }),
    );
    const relied = drive(
      [
        declare,
        start,
        ...fc
          .sample(propositionArb(), { numRuns: 1, seed: 7 })
          .map((premise): ChangeCommand => ({ _tag: "Rely", leaseId: LEASE, premise, preflight })),
      ].map((c) => [c, 1] as const),
    );
    expect(relied.state?.intent.revision).toBe(2);
    expect(
      comparable(replayChange(throughTheWire(relied.log.map((payload) => ({ at: T0, payload }))))),
    ).toBe(comparable(relied.state === undefined ? undefined : { ...relied.state, createdAt: T0 }));
  });

  it("[change.decide-evolvable] evolve takes every event decide emits, for every command tried in every state a run reaches", () => {
    fc.assert(
      fc.property(planArb, (plan) =>
        run(plan).records.every((r) => !r.threw && r.probes.every((p) => p.key !== "threw")),
      ),
    );
    // evolve keeps its own table: an event out of turn is a corrupt log.
    expect(() =>
      evolveChange(undefined, {
        at: T0,
        payload: { _tag: "ChangeQueued", changeId: CHANGE, laneId: "lane" },
      }),
    ).toThrow(IllegalTransition);
  });

  it("[change.no-orphan] an agent-owned change always holds an Active lease; a lapse under the platform parks it on the way back", () => {
    let lapsedHandBacks = 0;
    assertReaching(
      fc.property(planArb, (plan) =>
        run(plan).records.every((r) => {
          const owned =
            r.after === undefined ||
            !agentOwned(keyOf(r.after)) ||
            r.after.lease.state === "active";
          const handBack =
            r.before !== undefined &&
            !agentOwned(keyOf(r.before)) &&
            !terminal(keyOf(r.before)) &&
            r.after !== undefined &&
            keyOf(r.after) !== keyOf(r.before);
          const intoAgent =
            handBack &&
            r.after !== undefined &&
            (agentOwned(keyOf(r.after)) || keyOf(r.after) === "parked:lease-lapsed") &&
            r.kind !== "Adopt";
          if (!(intoAgent && r.before !== undefined && lapsedAt(r.before, r.now))) return owned;
          lapsedHandBacks++;
          return owned && keyOf(r.after) === "parked:lease-lapsed";
        }),
      ),
    );
    expect(lapsedHandBacks).toBeGreaterThan(0);
    // The alarm fires while Verifying (platform-owned): the change stays put. The bounce then hands it back parked.
    const verifying = drive([
      ...[declare, start, submit, precheck, compile].map((c) => [c, 1] as const),
      [lapse, TTL],
      [bounce, 1],
    ]);
    expect(verifying.keys.slice(-2)).toEqual(["verifying", "parked:lease-lapsed"]);
    expect(tags(verifying.log).slice(-3)).toEqual(["LeaseLapsed", "ChangeBounced", "ChangeParked"]);
    // No alarm yet, but the lease lapsed on read: the bounce still parks it.
    const unalarmed = drive([
      ...[declare, start, submit, precheck, compile].map((c) => [c, 1] as const),
      [bounce, TTL],
    ]);
    expect(unalarmed.keys.at(-1)).toBe("parked:lease-lapsed");
  });

  it("[change.lapse-parks-agent-owned-only] the lease alarm parks agent-owned states and leaves platform-owned ones where they are", () => {
    let parkedByAlarm = 0;
    let keptByAlarm = 0;
    assertReaching(
      fc.property(planArb, (plan) =>
        run(plan)
          .records.filter((r) => r.kind === "Lapse" && eventsOf(r).length > 0)
          .every((r) => {
            const from = keyOf(r.before);
            if (agentOwned(from)) {
              parkedByAlarm++;
              return keyOf(r.after) === "parked:lease-lapsed";
            }
            keptByAlarm++;
            return !r.threw && keyOf(r.after) === from && r.after?.lease.state === "lapsed";
          }),
      ),
    );
    expect(parkedByAlarm).toBeGreaterThan(0);
    expect(keptByAlarm).toBeGreaterThan(0);
    // In Integrating the change belongs to its batch: the lapse is recorded, nothing moves.
    const integrating = drive([
      ...[declare, start, submit, precheck, compile, queue, batch].map((c) => [c, 1] as const),
      [lapse, TTL],
    ]);
    expect(integrating.keys.at(-1)).toBe("integrating");
    expect(tags(integrating.log).at(-1)).toBe("LeaseLapsed");
    const working = drive([...[declare, start].map((c) => [c, 1] as const), [lapse, TTL]]);
    expect(working.keys.at(-1)).toBe("parked:lease-lapsed");
  });

  it("[change.cannot-queue-blocked] a change is never queued with a Proven conflict open, a failing guard or unresolved high drift", () => {
    let refused = 0;
    assertReaching(
      fc.property(planArb, (plan) =>
        run(plan)
          .records.filter(
            (r) =>
              r.command?._tag === "Queue" &&
              r.command.blockers !== undefined &&
              keyOf(r.before) === "verifying" &&
              r.step.blocked,
          )
          .every((r) => {
            refused++;
            return failureTag(r.result) === "ChangeBlocked" && r.after === r.before;
          }),
      ),
    );
    expect(refused).toBeGreaterThan(0);
    const proven = { ...clear, openProvenConflicts: [makeId("cfl", ulid(9))] };
    const blocked = drive([
      ...[declare, start, submit, precheck, compile].map((c) => [c, 1] as const),
      [{ _tag: "Queue", laneId: "lane:default", blockers: proven }, 1],
    ]);
    expect(failureTag(blocked.results.at(-1))).toBe("ChangeBlocked");
    expect(blocked.keys.at(-1)).toBe("verifying");
  });

  it("[change.blocked-never-batched] from Queued, a proven conflict ends Bounced, never Integrating", () => {
    let pulled = 0;
    assertReaching(
      fc.property(planArb, (plan) =>
        run(plan)
          .records.filter(
            (r) =>
              keyOf(r.before) === "queued" &&
              // A declined batch is no conflict, and bounces no change that is not yet in it.
              ((r.command?._tag === "Bounce" && r.command.declined === undefined) ||
                (r.command?._tag === "Batch" && r.step.blocked)),
          )
          .every((r) => {
            pulled++;
            const k = keyOf(r.after);
            return r.command?._tag === "Batch"
              ? failureTag(r.result) === "ChangeBlocked" && k === "queued"
              : k === "bounced" || k === "parked:lease-lapsed";
          }),
      ),
    );
    expect(pulled).toBeGreaterThan(0);
    const proven = { ...clear, openProvenConflicts: [makeId("cfl", ulid(9))] };
    const queued = [declare, start, submit, precheck, compile, queue].map((c) => [c, 1] as const);
    const refusedBatch = drive([
      ...queued,
      [{ _tag: "Batch", batchId: BATCH, blockers: proven }, 1],
    ]);
    expect(refusedBatch.keys.at(-1)).toBe("queued");
    const bounced = drive([...queued, [bounce, 1]]);
    expect(bounced.keys.at(-1)).toBe("bounced");
  });

  it("[change.no-batch-past-escalation] a change enters no batch while a person has yet to rule on one of its conflicts, and is queued all the same", () => {
    let held = 0;
    let queuedAnyway = 0;
    assertReaching(
      fc.property(planArb, (plan) =>
        run(plan).records.every((r) => {
          const batched = eventsOf(r).some((e) => e._tag === "ChangeBatched");
          const carried = r.command?._tag === "Batch" ? r.command.blockers.awaitingRuling : [];
          // Whatever was played: no batch is joined by a command that carried an awaited ruling.
          if (batched && carried.length > 0) return false;
          return r.probes.every(({ command, result, key }) => {
            if (command._tag === "Queue" && keyOf(r.before) === "verifying") {
              if (anyBlocker(command.blockers)) return true;
              // An awaited ruling never stops the queueing itself.
              if (command.blockers.awaitingRuling.length > 0) queuedAnyway++;
              return key === "queued";
            }
            if (command._tag !== "Batch" || keyOf(r.before) !== "queued") return true;
            const awaited = command.blockers.awaitingRuling;
            if (awaited.length === 0) return anyBlocker(command.blockers) || key === "integrating";
            held++;
            const refused = Result.isFailure(result) ? result.failure : undefined;
            return (
              refused?._tag === "ChangeBlocked" &&
              refused.escalations?.join() === awaited.join() &&
              refused.nextActions.some((a) => a.kind === "wait")
            );
          });
        }),
      ),
    );
    expect(held).toBeGreaterThan(0);
    expect(queuedAnyway).toBeGreaterThan(0);

    const E1 = makeId("esc", ulid(11));
    const E2 = makeId("esc", ulid(12));
    const D1 = makeId("dec", ulid(13));
    const D2 = makeId("dec", ulid(15));
    const B2 = makeId("bat", ulid(14));
    const awaiting = (...escalations: readonly EscalationId[]): Blockers => ({
      ...clear,
      awaitingRuling: escalations,
    });
    const verified = [declare, start, submit, precheck, compile].map((c) => [c, 1] as const);
    const queued = [...verified, [queue, 1] as const];
    // Two escalations: parked for the first, the first ruled while the second is with a person. It is
    // not resumed, so no batch can take it; the second ruling puts it back, and then it is batched.
    const twice = drive([
      ...queued,
      [{ _tag: "Park", escalationId: E1 }, 1],
      [{ _tag: "Resume", decisionId: D1, awaitingRuling: [E2] }, 1],
      [batch, 1],
      [{ _tag: "Resume", decisionId: D2, awaitingRuling: [] }, 1],
      [batch, 1],
    ]);
    expect(twice.keys.slice(-5)).toEqual([
      "parked:awaiting-ruling",
      "parked:awaiting-ruling",
      "parked:awaiting-ruling",
      "queued",
      "integrating",
    ]);
    expect(twice.results.slice(-4).map(failureTag)).toEqual([
      "ChangeBlocked",
      "ChangeStateRefused",
      undefined,
      undefined,
    ]);
    // Escalated while in a batch, which it finishes; the batch fails and it is requeued.
    const requeued = drive([
      ...queued,
      [batch, 1],
      [{ _tag: "Park", escalationId: E1 }, 1],
      [{ _tag: "Requeue", batchId: BATCH, reason: "infra-failure" }, 1],
      [{ _tag: "Batch", batchId: B2, blockers: awaiting(E1) }, 1],
      [{ _tag: "Batch", batchId: B2, blockers: clear }, 1],
    ]);
    expect(requeued.keys.slice(-5)).toEqual([
      "integrating",
      "integrating",
      "queued",
      "queued",
      "integrating",
    ]);
    expect(failureTag(requeued.results.at(-2))).toBe("ChangeBlocked");
    // The refusal names every escalation waited for, beside what else blocks, and says to wait.
    const both = drive([
      ...queued,
      [
        {
          _tag: "Batch",
          batchId: BATCH,
          blockers: { ...awaiting(E1, E2), openProvenConflicts: [makeId("cfl", ulid(9))] },
        },
        1,
      ],
    ]).results.at(-1);
    expect(both !== undefined && Result.isFailure(both) ? both.failure : undefined).toMatchObject({
      _tag: "ChangeBlocked",
      escalations: [E1, E2],
      conflicts: [makeId("cfl", ulid(9))],
      nextActions: [{ kind: "wait", args: { escalations: [E1, E2] } }, { kind: "read" }],
    });
    // A change whose conflict is already with a person is queued, then parked; a blocked one names no escalation.
    const asked = drive([
      ...verified,
      [{ _tag: "Queue", laneId: "lane:default", blockers: awaiting(E1) }, 1],
      [{ _tag: "Park", escalationId: E1 }, 0],
    ]);
    expect(asked.keys.slice(-2)).toEqual(["queued", "parked:awaiting-ruling"]);
    const proven = drive([
      ...queued,
      [
        {
          _tag: "Batch",
          batchId: BATCH,
          blockers: { ...clear, openProvenConflicts: [makeId("cfl", ulid(9))] },
        },
        1,
      ],
    ]).results.at(-1);
    expect(
      proven !== undefined && Result.isFailure(proven) && "escalations" in proven.failure,
    ).toBe(false);
  });

  it("[change.resume-returns] a resumed change is the change that was parked: back in the state it was parked from, in its lane and under its plan", () => {
    let fromQueued = 0;
    let fromVerifying = 0;
    assertReaching(
      fc.property(planArb, (plan) =>
        run(plan).records.every((r) => {
          if (keyOf(r.before) !== "parked:awaiting-ruling") return r.held === undefined;
          const { held } = r;
          if (held === undefined) return false;
          // Wherever it waits, a resume tried there leads back to where the harness saw it first parked,
          // unless another question holds it: then it leads nowhere.
          const landsBack = r.probes.every(
            (probe) =>
              probe.command._tag !== "Resume" ||
              probe.key === (probe.command.awaitingRuling.length === 0 ? keyOf(held) : undefined),
          );
          if (r.command?._tag !== "Resume" || !accepted(r) || r.after === undefined)
            return landsBack;
          if (held.state === "queued") fromQueued++;
          else fromVerifying++;
          // Only its lease may have moved while it waited: an adoption, a lapse, a renewal.
          const waited = { ...r.after, lease: held.lease, agentId: held.agentId };
          return landsBack && comparable(waited) === comparable(held);
        }),
      ),
    );
    expect(fromQueued).toBeGreaterThan(0);
    expect(fromVerifying).toBeGreaterThan(0);

    const park: ChangeCommand = { _tag: "Park", escalationId: makeId("esc", ulid(11)) };
    const resume: ChangeCommand = {
      _tag: "Resume",
      decisionId: makeId("dec", ulid(13)),
      awaitingRuling: [],
    };
    const verified = [declare, start, submit, precheck, compile].map((c) => [c, 1] as const);
    const queued = [...verified, [queue, 1] as const];
    const inQueue = drive(queued).state;
    const backInQueue = drive([...queued, [park, 1], [resume, 1]]);
    expect(backInQueue.keys.slice(-2)).toEqual(["parked:awaiting-ruling", "queued"]);
    expect(backInQueue.state).toEqual(inQueue);
    expect(backInQueue.state).toMatchObject({ laneId: "lane:default", planHash: PLAN_HASH });
    const atVerifying = drive(verified).state;
    const backAtVerifying = drive([...verified, [park, 1], [resume, 1]]);
    expect(backAtVerifying.keys.slice(-2)).toEqual(["parked:awaiting-ruling", "verifying"]);
    expect(backAtVerifying.state).toEqual(atVerifying);
    // A park for another question while it waits moves none of that: it resumes to where it first parked.
    const other: ChangeCommand = { _tag: "Park", escalationId: makeId("esc", ulid(12)) };
    expect(drive([...queued, [park, 1], [other, 1], [resume, 1]]).state).toEqual(inQueue);
    expect(drive([...verified, [park, 1], [other, 1], [resume, 1]]).state).toEqual(atVerifying);
    // A change parked before the origin was recorded has none: it resumes to Verifying, as it always did.
    const { parkedFrom: _unrecorded, ...older } = drive([...queued, [park, 1]]).state ?? {};
    expect(
      keyOf(
        evolveChange(Schema.decodeUnknownSync(Change)(Schema.encodeUnknownSync(Change)(older)), {
          at: T0,
          payload: ChangeResumed.make({ changeId: CHANGE, decisionId: makeId("dec", ulid(13)) }),
        }),
      ),
    ).toBe("verifying");
  });

  it("[change.no-resume-past-escalation] the ruling on one question never resumes a change another question still holds: the resume is refused naming what it waits for, and it stays parked until the last ruling", () => {
    let heldBack = 0;
    let released = 0;
    assertReaching(
      fc.property(planArb, (plan) =>
        run(plan).records.every((r) => {
          const carried = r.command?._tag === "Resume" ? r.command.awaitingRuling : [];
          // Whatever was played: a resume that carried an awaited ruling commits nothing.
          if (carried.length > 0 && eventsOf(r).length > 0) return false;
          return r.probes.every(({ command, result, key }) => {
            if (command._tag !== "Resume") return true;
            const refused = Result.isFailure(result) ? result.failure : undefined;
            // Anywhere but the wait it is the state that refuses it, whatever it carries.
            if (keyOf(r.before) !== "parked:awaiting-ruling")
              return refused !== undefined && refused._tag !== "ChangeBlocked";
            const awaited = command.awaitingRuling;
            if (awaited.length === 0) {
              released++;
              return key === keyOf(r.held);
            }
            heldBack++;
            return (
              refused?._tag === "ChangeBlocked" &&
              refused.escalations?.join() === awaited.join() &&
              refused.conflicts.length + refused.guards.length + refused.drift.length === 0 &&
              refused.nextActions[0]?.kind === "wait"
            );
          });
        }),
      ),
    );
    expect(heldBack).toBeGreaterThan(0);
    expect(released).toBeGreaterThan(0);

    const E1 = makeId("esc", ulid(11));
    const E2 = makeId("esc", ulid(12));
    const D1 = makeId("dec", ulid(13));
    const D2 = makeId("dec", ulid(15));
    const waiting = "parked:awaiting-ruling";
    const verified = [declare, start, submit, precheck, compile].map((c) => [c, 1] as const);
    const queued = [...verified, [queue, 1] as const];
    const inQueue = drive(queued).state;
    // Two questions, the first ruled for the change: it is held back and no batch takes it; it waits on
    // the second from there, and that ruling resumes it as the change that was first parked.
    const firstThenSecond = drive([
      ...queued,
      [parkUnder(E1), 1],
      [resumeOn(D1, E2), 1],
      [batch, 1],
      [parkUnder(E2), 1],
      [resumeOn(D2), 1],
    ]);
    expect(firstThenSecond.keys.slice(-5)).toEqual([waiting, waiting, waiting, waiting, "queued"]);
    expect(firstThenSecond.results.slice(-4).map(failureTag)).toEqual([
      "ChangeBlocked",
      "ChangeStateRefused",
      undefined,
      undefined,
    ]);
    expect(tags(firstThenSecond.log).slice(-3)).toEqual([
      "ChangeParked",
      "ChangeParked",
      "ChangeResumed",
    ]);
    expect(firstThenSecond.state).toEqual(inQueue);
    // The second ruled first: the change still waits on the first, a park under that question moves
    // nothing, and the first ruling then finds no other open and resumes it.
    const secondThenFirst = drive([
      ...queued,
      [parkUnder(E1), 1],
      [resumeOn(D2, E1), 1],
      [parkUnder(E1), 1],
      [resumeOn(D1), 1],
    ]);
    expect(secondThenFirst.keys.slice(-4)).toEqual([waiting, waiting, waiting, "queued"]);
    expect(secondThenFirst.results.slice(-3).map(failureTag)).toEqual([
      "ChangeBlocked",
      "ChangeStateRefused",
      undefined,
    ]);
    expect(secondThenFirst.state).toEqual(inQueue);
    // The first ruled for it and the second against it: the second finds it still waiting, and bounces it.
    const thenAgainst = drive([
      ...queued,
      [parkUnder(E1), 1],
      [resumeOn(D1, E2), 1],
      [{ ...ruledAgainst, decisionId: D2 }, 1],
    ]);
    expect(thenAgainst.keys.slice(-2)).toEqual([waiting, "bounced"]);
    expect(thenAgainst.log.at(-1)).toMatchObject({ _tag: "ChangeBounced", decisionId: D2 });
    // The refusal names every question still open, blocks on nothing else, and says what the wait is for.
    const heldFor = drive([...verified, [parkUnder(E1), 1], [resumeOn(D1, E2, E1), 1]]).results.at(
      -1,
    );
    expect(
      heldFor !== undefined && Result.isFailure(heldFor) ? heldFor.failure : undefined,
    ).toMatchObject({
      _tag: "ChangeBlocked",
      escalations: [E2, E1],
      conflicts: [],
      guards: [],
      drift: [],
      nextActions: [
        {
          kind: "wait",
          title: expect.stringContaining("resumes once they rule"),
          args: { escalations: [E2, E1] },
        },
        { kind: "read" },
      ],
    });
  });

  it("[change.park-follows-question] a change that waits for a ruling takes the park for another question and waits on that one, from where it first parked; the question it already waits on parks it no further, and a change parked for a lapsed lease takes neither", () => {
    let moved = 0;
    let same = 0;
    assertReaching(
      fc.property(planArb, (plan) =>
        run(plan).records.every((r) =>
          r.probes.every(({ command, result }) => {
            const { before } = r;
            if (command._tag !== "Park" || before === undefined) return true;
            // A change parked for a lapsed lease waits for an adopter, not for a ruling.
            if (keyOf(before) === "parked:lease-lapsed") return Result.isFailure(result);
            if (keyOf(before) !== "parked:awaiting-ruling") return true;
            if (command.escalationId === before.escalationId) {
              same++;
              return failureTag(result) === "ChangeStateRefused";
            }
            moved++;
            if (Result.isFailure(result) || result.success.length !== 1) return false;
            const after = result.success.reduce<Change | undefined>(
              (s, payload) => evolveChange(s, { at: r.now, payload }),
              before,
            );
            // Only the question moved: where it parked from, its lane, its plan and its lease are as they were.
            return (
              comparable(after) === comparable({ ...before, escalationId: command.escalationId })
            );
          }),
        ),
      ),
    );
    expect(moved).toBeGreaterThan(0);
    expect(same).toBeGreaterThan(0);

    const E1 = makeId("esc", ulid(11));
    const E2 = makeId("esc", ulid(12));
    const queued = [declare, start, submit, precheck, compile, queue].map((c) => [c, 1] as const);
    const waiting = drive([...queued, [{ _tag: "Park", escalationId: E1 }, 1]]);
    const parkedFor = (escalationId?: EscalationId): Committed<ChangeEvent> => ({
      at: waiting.now,
      payload: ChangeParked.make({
        changeId: CHANGE,
        reason: "awaiting-ruling",
        ...(escalationId === undefined ? {} : { escalationId }),
      }),
    });
    expect(evolveChange(waiting.state, parkedFor(E2))).toEqual({
      ...waiting.state,
      escalationId: E2,
    });
    // The fold takes no park under the question already waited on, and none that names no question.
    expect(() => evolveChange(waiting.state, parkedFor(E1))).toThrow(IllegalTransition);
    expect(() => evolveChange(waiting.state, parkedFor())).toThrow(IllegalTransition);
    // A change parked for a lapsed lease is parked for no ruling, by decide or by the fold.
    const lapsed = drive([
      [declare, 1],
      [{ _tag: "Lapse", leaseId: LEASE }, TTL],
      [{ _tag: "Park", escalationId: E1 }, 1],
    ]);
    expect(lapsed.keys.slice(-2)).toEqual(["parked:lease-lapsed", "parked:lease-lapsed"]);
    expect(failureTag(lapsed.results.at(-1))).toBe("ChangeStateRefused");
    expect(() => evolveChange(lapsed.state, parkedFor(E1))).toThrow(IllegalTransition);
  });

  it("[change.refusals-guide] every refusal and every bounce tells the agent what to do next", () => {
    let refusals = 0;
    fc.assert(
      fc.property(planArb, (plan) =>
        run(plan).records.every((r) => {
          const failure = refusal(r);
          if (failure !== undefined) refusals++;
          const guided = failure === undefined || (failure.nextActions?.length ?? 0) > 0;
          const bounces = eventsOf(r).filter((e) => e._tag === "ChangeBounced");
          return guided && bounces.every((e) => (e.nextActions?.length ?? 0) > 0);
        }),
      ),
    );
    expect(refusals).toBeGreaterThan(0);
    // A bounce whose verdict suggests nothing still carries a way forward.
    const bounced = drive([
      ...[declare, start, submit, precheck, compile].map((c) => [c, 1] as const),
      [bounce, 1],
    ]);
    expect(bounced.log.at(-1)).toMatchObject({
      _tag: "ChangeBounced",
      nextActions: [{ operationId: "submit" }],
    });
    expect(brief(drive([[start, 1]]).results[0])).toEqual({
      tag: "ChangeNotFound",
      reason: undefined,
      next: ["declare"],
    });
  });

  it("[change.landed-from-landing] a change lands as TrunkAdvanced's landing says: its commit on trunk, the trunk head, its candidate and its proof", () => {
    let landed = 0;
    fc.assert(
      fc.property(planArb, (plan) =>
        run(plan).records.every((r) =>
          r.probes.every((probe) => {
            const c = probe.command;
            if (c._tag !== "Land" || !Result.isSuccess(probe.result)) return true;
            landed++;
            const [e, ...rest] = probe.result.success;
            return (
              rest.length === 0 &&
              e?._tag === "ChangeLanded" &&
              e.changeId === r.before?.id &&
              e.commitSha === c.commitSha &&
              e.trunkSha === c.trunkSha &&
              e.candidateId === c.candidateId &&
              e.proofId === c.proofId
            );
          }),
        ),
      ),
    );
    expect(landed).toBeGreaterThan(0);
    const s0 = drive(
      [declare, start, submit, precheck, compile, queue, batch, land].map((c) => [c, 1] as const),
    );
    // Submitted as SHA, landed as the restacked commit with its trailers.
    expect(s0.log.at(-1)).toMatchObject({ _tag: "ChangeLanded", commitSha: ON_TRUNK });
  });
});

const rebase = (from: CommitSha, onto: CommitSha, leaseId: LeaseId = LEASE): ChangeCommand => ({
  _tag: "Rebase",
  leaseId,
  from,
  onto,
});

/** Every rebase a run tried, with the change it was tried on and when. */
const rebasesTried = (trace: Trace) =>
  trace.records.flatMap((r) =>
    r.probes.flatMap((probe) =>
      probe.command._tag === "Rebase"
        ? [{ before: r.before, now: r.now, command: probe.command, result: probe.result }]
        : [],
    ),
  );

describe("rebasing a change", { timeout: PROPERTY_TIMEOUT }, () => {
  it("[change.rebase-moves-base] an accepted rebase commits exactly ChangeRebased, and the change after differs from the change before only in its base", () => {
    let rebased = 0;
    fc.assert(
      fc.property(planArb, (plan) =>
        rebasesTried(run(plan)).every(({ before, now, command, result }) => {
          if (before === undefined || Result.isFailure(result)) return true;
          rebased++;
          const [event, ...rest] = result.success;
          const after = result.success.reduce<Change>(
            (s, payload) => evolveChange(s, { at: now, payload }),
            before,
          );
          return (
            rest.length === 0 &&
            event?._tag === "ChangeRebased" &&
            event.from === before.baseSha &&
            event.to === command.onto &&
            comparable(after) === comparable({ ...before, baseSha: command.onto })
          );
        }),
      ),
    );
    expect(rebased).toBeGreaterThan(0);
    const bounced = drive(
      [declare, start, submit, precheck, compile, bounce, rebase(BASE, REBASED)].map(
        (c) => [c, 1] as const,
      ),
    );
    expect(bounced.state?.state).toBe("bounced");
    expect(bounced.state?.baseSha).toBe(REBASED);
  });

  it("[change.rebase-only-agent-owned-work] a rebase is refused in every state but Working and Bounced, and commits nothing", () => {
    let elsewhere = 0;
    fc.assert(
      fc.property(planArb, (plan) =>
        rebasesTried(run(plan)).every(({ before, result }) => {
          const key = keyOf(before);
          if (key === "working" || key === "bounced") return true;
          elsewhere++;
          return Result.isFailure(result);
        }),
      ),
    );
    expect(elsewhere).toBeGreaterThan(0);
    const queued = drive(
      [declare, start, submit, precheck, compile, queue, rebase(BASE, REBASED)].map(
        (c) => [c, 1] as const,
      ),
    );
    expect(failureTag(queued.results[6])).toBe("ChangeStateRefused");
  });

  it("[change.rebase-stale-from] a rebase from anything but the change's base, or onto that base itself, is refused with a read of the change", () => {
    let stale = 0;
    let onto = 0;
    assertReaching(
      fc.property(planArb, (plan) =>
        rebasesTried(run(plan)).every(({ before, now, command, result }) => {
          const key = keyOf(before);
          if (before === undefined || (key !== "working" && key !== "bounced")) return true;
          if (command.leaseId !== before.lease.id || lapsedAt(before, now)) return true;
          if (command.from !== before.baseSha) stale++;
          else if (command.onto === command.from) onto++;
          else return true;
          const failure = Result.isFailure(result) ? result.failure : undefined;
          return (
            failure?._tag === "ChangeStateRefused" &&
            (failure.nextActions ?? []).some((a) => a.kind === "read")
          );
        }),
      ),
    );
    expect(stale).toBeGreaterThan(0);
    expect(onto).toBeGreaterThan(0);
    const working = [declare, start].map((c) => [c, 1] as const);
    expect(brief(drive([...working, [rebase(REBASED, BASE), 1]]).results[2])).toEqual({
      tag: "ChangeStateRefused",
      reason: undefined,
      next: ["change"],
    });
    expect(failureTag(drive([...working, [rebase(BASE, BASE), 1]]).results[2])).toBe(
      "ChangeStateRefused",
    );
  });

  it("[change.submit-after-rebase] every submission carries the change's base at that moment, so a submit after a rebase is judged against the new base", () => {
    let afterRebase = 0;
    assertReaching(
      fc.property(planArb, (plan) => {
        let base: CommitSha | undefined;
        let rebased = false;
        return run(plan).log.every(({ payload }) => {
          if (payload._tag === "ChangeStarted") base = payload.baseSha;
          if (payload._tag === "ChangeRebased") {
            base = payload.to;
            rebased = true;
          }
          if (payload._tag !== "ChangeSubmitted") return true;
          if (rebased) afterRebase++;
          return payload.baseSha === base;
        });
      }),
    );
    expect(afterRebase).toBeGreaterThan(0);
    const submitted = drive(
      [declare, start, rebase(BASE, REBASED), submit].map((c) => [c, 1] as const),
    ).log.find((e) => e._tag === "ChangeSubmitted");
    expect(submitted?._tag === "ChangeSubmitted" ? submitted.baseSha : undefined).toBe(REBASED);
  });
});

describe("the Lease", { timeout: PROPERTY_TIMEOUT }, () => {
  it("[lease.stale-refused] a call carrying any token but the current one is refused, with next actions", () => {
    let stale = 0;
    fc.assert(
      fc.property(planArb, (plan) =>
        run(plan)
          .records.filter(decided)
          .filter((r) => {
            const carried = leaseCarried(r.command);
            return (
              r.before !== undefined &&
              !terminal(keyOf(r.before)) &&
              carried !== undefined &&
              carried !== r.before.lease.id
            );
          })
          .every((r) => {
            stale++;
            const failure = refusal(r);
            return (
              failure?._tag === "LeaseStale" &&
              failure.reason === "stale" &&
              (failure.nextActions?.length ?? 0) > 0 &&
              r.after === r.before
            );
          }),
      ),
    );
    expect(stale).toBeGreaterThan(0);
    const adopted = drive([
      [declare, 1],
      [start, 1],
      [lapse, TTL],
      [adopt, 1],
      [revise(LEASE, 1), 1],
      [revise(ADOPTED, 1), 1],
    ]);
    expect(brief(adopted.results[4])).toEqual({
      tag: "LeaseStale",
      reason: "stale",
      next: ["change"],
    });
    expect(succeeded(adopted.results[5])).toBe(true);
  });

  it("[lease.lapse-computed-on-read] the current token works until 15 minutes after renewal, then is refused, alarm or no alarm", () => {
    let lapsedCalls = 0;
    fc.assert(
      fc.property(planArb, (plan) =>
        run(plan)
          .records.filter(decided)
          .filter(
            (r) =>
              r.before !== undefined &&
              !terminal(keyOf(r.before)) &&
              leaseCarried(r.command) === r.before.lease.id,
          )
          .every((r) => {
            const failure = refusal(r);
            if (r.before === undefined) return false;
            if (!lapsedAt(r.before, r.now)) return failure?._tag !== "LeaseStale";
            lapsedCalls++;
            return (
              failure?._tag === "LeaseStale" &&
              failure.reason === "lapsed" &&
              failure.nextActions !== undefined &&
              failure.nextActions.length > 0
            );
          }),
      ),
    );
    expect(lapsedCalls).toBeGreaterThan(0);
    const justInTime = drive([
      [declare, 0],
      [start, 0],
      [revise(LEASE, 1), TTL - 1],
    ]);
    expect(succeeded(justInTime.results[2])).toBe(true);
    const tooLate = drive([
      [declare, 0],
      [start, 0],
      [revise(LEASE, 1), TTL],
    ]);
    expect(brief(tooLate.results[2])).toEqual({
      tag: "LeaseStale",
      reason: "lapsed",
      next: ["adopt"],
    });
  });

  it("[lease.adopt-iff-lapsed] adoption succeeds exactly when the lease is Lapsed, and fences the old token", () => {
    let adoptions = 0;
    fc.assert(
      fc.property(planArb, (plan) =>
        run(plan)
          .records.filter(
            (r) =>
              r.command?._tag === "Adopt" && r.before !== undefined && !terminal(keyOf(r.before)),
          )
          .every((r) => {
            const { before, command } = r;
            if (before === undefined || command?._tag !== "Adopt") return false;
            if (!lapsedAt(before, r.now))
              return failureTag(r.result) === "LeaseNotLapsed" && r.after === r.before;
            adoptions++;
            return (
              accepted(r) &&
              r.after?.lease.id === command.leaseId &&
              r.after.lease.state === "active" &&
              r.after.agentId === command.agentId
            );
          }),
      ),
    );
    expect(adoptions).toBeGreaterThan(0);
    expect(
      failureTag(
        drive([
          [declare, 1],
          [start, 1],
          [adopt, TTL - 2],
        ]).results[2],
      ),
    ).toBe("LeaseNotLapsed");
    const parked = drive([
      [declare, 1],
      [start, 1],
      [lapse, TTL],
      [adopt, 1],
    ]);
    expect(parked.keys.slice(-2)).toEqual(["parked:lease-lapsed", "working"]);
    expect(parked.state?.lease).toMatchObject({ id: ADOPTED, state: "active" });
    // Waiting on a ruling, the change keeps waiting, now under the new lease.
    const ruling = drive([
      ...[declare, start, submit, precheck, compile].map((c) => [c, 1] as const),
      [{ _tag: "Park", escalationId: makeId("esc", ulid(10)) }, 1],
      [adopt, TTL],
    ]);
    expect(ruling.keys.at(-1)).toBe("parked:awaiting-ruling");
    expect(ruling.state?.lease.id).toBe(ADOPTED);
    // Parked before a workspace was granted, it goes back to waiting for one.
    expect(
      drive([
        [declare, 1],
        [lapse, TTL],
        [adopt, 1],
      ]).keys.at(-1),
    ).toBe("declared");
  });

  it("[lease.one-terminal] each lease ends Superseded or Released, never both, and a finished change's lease is Released", () => {
    let finished = 0;
    fc.assert(
      fc.property(planArb, (plan) =>
        run(plan).records.every((r) => {
          if (r.after === undefined) return true;
          const k = keyOf(r.after);
          if (!terminal(k))
            return r.after.lease.state === "active" || r.after.lease.state === "lapsed";
          finished++;
          return r.after.lease.state === "released";
        }),
      ),
    );
    expect(finished).toBeGreaterThan(0);
    const withdrawn = drive([
      [declare, 1],
      [start, 1],
      [{ _tag: "Withdraw", authority: { _tag: "Lease", leaseId: LEASE } }, 1],
    ]);
    expect(withdrawn.state?.lease.state).toBe("released");
    expect(
      failureTag(
        drive([
          [declare, 1],
          [start, 1],
          [{ _tag: "Withdraw", authority: { _tag: "Lease", leaseId: LEASE } }, 1],
          [adopt, TTL],
        ]).results[3],
      ),
    ).toBe("ChangeStateRefused");
  });
});

// Charts: the docs' statecharts check the machine; they never drive it.

const changeMachine: Machine<
  Change,
  ChangeCommand,
  ChangeEvent,
  { readonly now: Instant; readonly changeId: typeof CHANGE }
> = {
  decide: decideChange,
  evolve: evolveChange,
};

/** Where a change is, as the chart names it: a parked change is in one of Parked's two sub-states. */
const chartKey = (c: Change): string =>
  c.state === "parked"
    ? c.parkReason === "lease-lapsed"
      ? "parked.leaseLapsed"
      : "parked.awaitingRuling"
    : c.state;

/** Where one lease is: adoption supersedes the old lease, whatever state it was in. */
const leaseFrom = (f: Fold<Change, ChangeEvent>): string => f.before?.lease.state ?? "none";
const leaseTo = (f: Fold<Change, ChangeEvent>): string =>
  f.before !== undefined && f.after.lease.id !== f.before.lease.id
    ? "superseded"
    : f.after.lease.state;

/** Every event a run committed or tried, folded one at a time. */
const foldsIn = (r: Played): readonly Fold<Change, ChangeEvent>[] =>
  foldsOf(changeMachine, r.before, [r.result, ...r.probes.map((p) => p.result)], r.now);

const TOUR_PLAN: Plan = {
  premises: fc.sample(propositionArb(), { numRuns: 1, seed: 7 }),
  steps: [],
};
const KINDS = ALL.filter((k): k is Exclude<Kind, "Renew"> => k !== "Renew");

/** The machine walked breadth-first: every command, a moment later and a full TTL later, by lease and by operator. */
let walkedTour: readonly Fold<Change, ChangeEvent>[] | undefined;
const changeTour = (): readonly Fold<Change, ChangeEvent>[] => {
  if (walkedTour !== undefined) return walkedTour;
  const mint = new Mint();
  walkedTour = tour(changeMachine, {
    start: T0,
    facts: (now) => ({ now, changeId: CHANGE }),
    moves: (state) => [
      ...KINDS.flatMap((kind) =>
        [1, TTL].flatMap((dt) =>
          [false, true].map((operator) => ({
            command: build(
              kind,
              state,
              {
                mode: "progress",
                pick: 0,
                dt,
                stale: false,
                blocked: false,
                awaited: false,
                flag: true,
                operator,
              },
              TOUR_PLAN,
              mint,
              [],
            ),
            dt,
          })),
        ),
      ),
      // A ruling against the change, which `build` never draws.
      ...[1, TTL].map((dt) => ({ command: ruledAgainst, dt })),
    ],
    signature: (c) =>
      c === undefined
        ? "none"
        : `${chartKey(c)}|${c.parkedFrom ?? ""}|${c.workspaceId !== undefined}|${c.lease.state}`,
  });
  return walkedTour;
};

const changeView: View<Change, ChangeEvent> = {
  from: (f) => (f.before === undefined ? "none" : chartKey(f.before)),
  to: (f) => chartKey(f.after),
};
const leaseView: View<Change, ChangeEvent> = { from: leaseFrom, to: leaseTo };

describe("the Change and Lease charts", { timeout: PROPERTY_TIMEOUT }, () => {
  it("[change.bounce-conflict-cause] a conflict bounces a change only before it is batched, and the bounce names that conflict and no verdict", () => {
    fc.assert(
      fc.property(planArb, (plan) =>
        run(plan).records.every((r) =>
          r.probes.every((p) => {
            if (p.command._tag !== "Bounce") return true;
            const command = p.command;
            const bounces = Result.isSuccess(p.result)
              ? p.result.success.filter((e) => e._tag === "ChangeBounced")
              : [];
            if (command.conflictId === undefined)
              return bounces.every(
                (e) => e.verdictId === command.verdictId && e.conflictId === undefined,
              );
            const k = keyOf(r.before);
            const beforeBatch = k === "deriving" || k === "verifying" || k === "queued";
            return Result.isSuccess(p.result)
              ? beforeBatch &&
                  bounces.length === 1 &&
                  bounces.every(
                    (e) => e.conflictId === command.conflictId && e.verdictId === undefined,
                  )
              : !beforeBatch;
          }),
        ),
      ),
    );
    const CONFLICT = makeId("cfl", ulid(9));
    const proven: ChangeCommand = {
      _tag: "Bounce",
      conflictId: CONFLICT,
      reasons: ["a must premise is contradicted under block"],
      nextActions: [],
    };
    const queued = drive([
      [declare, 0],
      [start, 0],
      [submit, 0],
      [precheck, 0],
      [compile, 0],
      [queue, 0],
      [proven, 0],
    ]);
    expect(queued.keys.at(-1)).toBe("bounced");
    expect(queued.log.at(-1)).toMatchObject({ _tag: "ChangeBounced", conflictId: CONFLICT });
    // With no next actions given, the bounce names the conflict's ways forward.
    const bounced = queued.log.at(-1);
    expect(
      bounced?._tag === "ChangeBounced" && bounced.nextActions?.map((a) => a.operationId),
    ).toEqual(["Conflicts_getConflict", "revise", "resolve"]);
    // Once batched, a conflict no longer bounces the change: the batch's verdict does.
    const batched = drive([
      [declare, 0],
      [start, 0],
      [submit, 0],
      [precheck, 0],
      [compile, 0],
      [queue, 0],
      [batch, 0],
      [{ ...proven, batchId: BATCH }, 0],
    ]);
    expect(failureTag(batched.results.at(-1))).toBe("ChangeStateRefused");
  });

  it("[change.bounce-declined] promotion's declined batch bounces a change only while it is integrating in that batch, and the bounce names that batch and its reason, no verdict and no conflict, with the way forward for that reason", () => {
    let bounced = 0;
    assertReaching(
      fc.property(planArb, (plan) =>
        run(plan).records.every((r) =>
          r.probes.every((p) => {
            if (p.command._tag !== "Bounce" || p.command.declined === undefined) return true;
            const { declined } = p.command;
            const inBatch =
              keyOf(r.before) === "integrating" && r.before?.batchId === declined.batchId;
            if (!Result.isSuccess(p.result)) return !inBatch;
            const bounces = p.result.success.filter((e) => e._tag === "ChangeBounced");
            bounced += bounces.length;
            return (
              inBatch &&
              bounces.length === 1 &&
              bounces.every(
                (e) =>
                  e.verdictId === undefined &&
                  e.conflictId === undefined &&
                  JSON.stringify(e.declined) === JSON.stringify(declined) &&
                  (e.nextActions ?? []).length > 0,
              )
            );
          }),
        ),
      ),
    );
    expect(bounced).toBeGreaterThan(0);
    const queued = [declare, start, submit, precheck, compile, queue].map((c) => [c, 0] as const);
    const integrating = [...queued, [batch, 0] as const];
    const large = drive([...integrating, [declinedBounce(BATCH, "pack-too-large"), 0]]);
    expect(large.state?.state).toBe("bounced");
    expect(large.state).not.toHaveProperty("batchId");
    const event = large.log.at(-1);
    expect(event).toMatchObject({
      _tag: "ChangeBounced",
      declined: { batchId: BATCH, reason: "pack-too-large" },
    });
    expect(event).not.toHaveProperty("verdictId");
    expect(event).not.toHaveProperty("conflictId");
    // Too large a pack is the change's to split; a full repo is a person's to make room in.
    expect(
      event?._tag === "ChangeBounced" && event.nextActions?.map((a) => [a.kind, a.operationId]),
    ).toEqual([
      ["call", "declare"],
      ["call", "submit"],
    ]);
    const full = drive([...integrating, [declinedBounce(BATCH, "repo-bytes-quota"), 0]]).log.at(-1);
    expect(
      full?._tag === "ChangeBounced" && full.nextActions?.map((a) => [a.kind, a.operationId]),
    ).toEqual([
      ["escalate", undefined],
      ["call", "submit"],
    ]);
    // Not before the batch, and not for a batch the change is not in.
    const early = drive([...queued, [declinedBounce(BATCH, "pack-too-large"), 0]]);
    expect(failureTag(early.results.at(-1))).toBe("ChangeStateRefused");
    expect(early.state?.state).toBe("queued");
    const other = drive([
      ...integrating,
      [declinedBounce(makeId("bat", ulid(44)), "pack-too-large"), 0],
    ]);
    expect(failureTag(other.results.at(-1))).toBe("ChangeStateRefused");
    expect(other.state?.state).toBe("integrating");
    // A bounce names exactly one cause: two, or none, do not decode.
    const decode = Schema.decodeUnknownSync(ChangeEvent);
    const base = { _tag: "ChangeBounced", changeId: CHANGE, reasons: [] };
    const cause = { declined: { batchId: BATCH, reason: "pack-too-large" } };
    expect(decode({ ...base, ...cause })).toMatchObject(cause);
    expect(() => decode({ ...base, ...cause, verdictId: makeId("vrd", ulid(6)) })).toThrow(
      /exactly one cause/,
    );
    expect(() => decode(base)).toThrow(/exactly one cause/);
  });

  it("[change.ruling-bounces] a ruling's decision bounces a change exactly while it is parked for a ruling, as the bounce's one cause and with a way forward; decide and the fold refuse it in every other state a run reaches", () => {
    let bounced = 0;
    const bounceByRuling = ChangeBounced.make({
      changeId: CHANGE,
      decisionId: RULING,
      reasons: [],
      nextActions: [{ kind: "call", title: "Revise", operationId: "revise" }],
    });
    /** Whether the fold takes a bounce by a decision from this state. */
    const folds = (state: Change | undefined, now: Instant): boolean => {
      try {
        evolveChange(state, { at: now, payload: bounceByRuling });
        return true;
      } catch (error) {
        if (!(error instanceof IllegalTransition)) throw error;
        return false;
      }
    };
    assertReaching(
      fc.property(planArb, (plan) =>
        run(plan).records.every((r) => {
          const tried = r.probes.filter(
            (p) => p.command._tag === "Bounce" && p.command.decisionId !== undefined,
          );
          const parked = keyOf(r.before) === "parked:awaiting-ruling";
          return (
            tried.length === 1 &&
            folds(r.before, r.now) === parked &&
            tried.every((p) => {
              if (!parked || r.before === undefined) return Result.isFailure(p.result);
              if (!Result.isSuccess(p.result)) return false;
              const [first, ...rest] = p.result.success;
              const lapsed = lapsedAt(r.before, r.now);
              bounced++;
              return (
                first?._tag === "ChangeBounced" &&
                first.decisionId === RULING &&
                first.verdictId === undefined &&
                first.conflictId === undefined &&
                first.declined === undefined &&
                (first.nextActions ?? []).length > 0 &&
                // Handed back under a lapsed lease, it parks for adoption as any bounce does.
                JSON.stringify(rest.map((e) => e._tag)) ===
                  JSON.stringify(lapsed ? ["ChangeParked"] : []) &&
                p.key === (lapsed ? "parked:lease-lapsed" : "bounced")
              );
            })
          );
        }),
      ),
    );
    expect(bounced).toBeGreaterThan(0);
    const verifying = [declare, start, submit, precheck, compile].map((c) => [c, 0] as const);
    const park: ChangeCommand = { _tag: "Park", escalationId: makeId("esc", ulid(12)) };
    const fromVerifying = drive([...verifying, [park, 0], [ruledAgainst, 0]]);
    expect(fromVerifying.keys.slice(-2)).toEqual(["parked:awaiting-ruling", "bounced"]);
    // Parked from its lane, it leaves as any bounce does: out of the lane, with nothing left of the wait.
    const fromQueued = drive([...verifying, [queue, 0], [park, 0], [ruledAgainst, 0]]);
    expect(fromQueued.keys.slice(-2)).toEqual(["parked:awaiting-ruling", "bounced"]);
    for (const key of ["parkReason", "escalationId", "parkedFrom", "laneId"])
      expect(fromQueued.state).not.toHaveProperty(key);
    // The decision is the bounce's one cause, and with no actions given it names the two ways forward.
    const event = fromQueued.log.at(-1);
    expect(event).toMatchObject({ _tag: "ChangeBounced", decisionId: RULING });
    for (const cause of ["verdictId", "conflictId", "declined"])
      expect(event).not.toHaveProperty(cause);
    // Through the wire it is the same bounce.
    expect(
      throughTheWire(fromQueued.log.map((payload) => ({ at: T0, payload }))).at(-1)?.payload,
    ).toEqual(event);
    expect(
      event?._tag === "ChangeBounced" && event.nextActions?.map((a) => [a.kind, a.operationId]),
    ).toEqual([
      ["call", "revise"],
      ["call", "abandon"],
    ]);
    // The actions a caller gives are the ones the agent reads.
    const given = drive([
      ...verifying,
      [park, 0],
      [{ ...ruledAgainst, nextActions: [{ kind: "wait", title: "Wait for the other change" }] }, 0],
    ]).log.at(-1);
    expect(given?._tag === "ChangeBounced" && given.nextActions).toEqual([
      { kind: "wait", title: "Wait for the other change" },
    ]);
    // Queued and not parked, the change is not waiting for the ruling: refused, and it stays queued.
    const queued = drive([...verifying, [queue, 0], [ruledAgainst, 0]]);
    expect(failureTag(queued.results.at(-1))).toBe("ChangeStateRefused");
    expect(queued.keys.at(-1)).toBe("queued");
    // Parked for a lapsed lease is another park: refused, and it stays parked for adoption.
    const orphaned = drive([
      [declare, 0],
      [start, 0],
      [lapse, TTL],
      [ruledAgainst, 0],
    ]);
    expect(failureTag(orphaned.results.at(-1))).toBe("ChangeStateRefused");
    expect(orphaned.keys.slice(-2)).toEqual(["parked:lease-lapsed", "parked:lease-lapsed"]);
    // The lease lapsed while the change waited: the ruling bounces it, and it parks for adoption.
    const stale = drive([...verifying, [park, 0], [ruledAgainst, TTL]]);
    expect(tags(stale.log).slice(-2)).toEqual(["ChangeBounced", "ChangeParked"]);
    expect(stale.keys.at(-1)).toBe("parked:lease-lapsed");
    // The decision is one cause among four: alone it decodes, beside another it does not.
    const decode = Schema.decodeUnknownSync(ChangeEvent);
    const base = { _tag: "ChangeBounced", changeId: CHANGE, reasons: [] };
    expect(decode({ ...base, decisionId: RULING })).toMatchObject({ decisionId: RULING });
    expect(() =>
      decode({ ...base, decisionId: RULING, verdictId: makeId("vrd", ulid(6)) }),
    ).toThrow(/exactly one cause/);
  });

  it("[change.conflict-noted] a conflict noted under advise or annotate is recorded in every non-terminal state and moves nothing; advise names the ways forward, annotate none", () => {
    fc.assert(
      fc.property(planArb, (plan) =>
        run(plan).records.every((r) =>
          r.probes.every((p) => {
            if (p.command._tag !== "NoteConflict") return true;
            const command = p.command;
            const before = r.before;
            if (before === undefined || terminal(keyOf(before))) return Result.isFailure(p.result);
            if (!Result.isSuccess(p.result) || p.result.success.length !== 1) return false;
            const [noted] = p.result.success;
            return (
              noted?._tag === "ConflictNoted" &&
              noted.changeId === CHANGE &&
              noted.conflictId === command.conflictId &&
              noted.predicate === command.predicate &&
              noted.policy === command.policy &&
              noted.evidenceRef === command.evidenceRef &&
              (command.policy === "advise"
                ? noted.nextActions?.map((a) => a.operationId).join() ===
                  "Conflicts_getConflict,revise,resolve"
                : noted.nextActions === undefined) &&
              comparable(evolveChange(before, { at: r.now, payload: noted })) === comparable(before)
            );
          }),
        ),
      ),
    );
    const verifying = drive([
      [declare, 0],
      [start, 0],
      [submit, 0],
      [precheck, 0],
      [compile, 0],
      [note("annotate"), 0],
      [note("advise"), 0],
    ]);
    expect(verifying.keys.slice(-3)).toEqual(["verifying", "verifying", "verifying"]);
    expect(tags(verifying.log).slice(-2)).toEqual(["ConflictNoted", "ConflictNoted"]);
    const landed = drive([
      [declare, 0],
      [start, 0],
      [submit, 0],
      [precheck, 0],
      [compile, 0],
      [queue, 0],
      [batch, 0],
      [land, 0],
      [note("advise"), 0],
    ]);
    expect(failureTag(landed.results.at(-1))).toBe("ChangeStateRefused");
  });

  it("[change.plan-policy] a compiled plan's predicate policy reaches PlanCompiled unchanged, and an absent one stays absent", () => {
    fc.assert(
      fc.property(planArb, (plan) =>
        run(plan).records.every((r) =>
          r.probes.every((p) => {
            if (p.command._tag !== "CompilePlan" || !Result.isSuccess(p.result)) return true;
            const compiled = p.result.success.find((e) => e._tag === "PlanCompiled");
            return (
              compiled?._tag === "PlanCompiled" &&
              JSON.stringify(compiled.predicatePolicy) === JSON.stringify(p.command.predicatePolicy)
            );
          }),
        ),
      ),
    );
    const compiled = drive([
      [declare, 0],
      [start, 0],
      [submit, 0],
      [precheck, 0],
      [{ ...compile, predicatePolicy: { freshness: "block" } }, 0],
    ]);
    expect(compiled.log.at(-1)).toMatchObject({
      _tag: "PlanCompiled",
      predicatePolicy: { freshness: "block" },
    });
  });

  it("[change.plan-policy-folded] a change carries the predicate policy of the plan it was last compiled to: none before any plan, and none once a plan is compiled without one", () => {
    fc.assert(
      fc.property(planArb, (plan) => {
        let latest: string | undefined;
        return run(plan).records.every((r) => {
          if (r.threw) return true;
          if (r.result !== undefined && Result.isSuccess(r.result)) {
            for (const e of r.result.success) {
              if (e._tag === "PlanCompiled") latest = JSON.stringify(e.predicatePolicy);
            }
          }
          return JSON.stringify(r.after?.predicatePolicy) === latest;
        });
      }),
    );
    const policy = { freshness: "block" } as const;
    const compiled = [
      [declare, 0],
      [start, 0],
      [submit, 0],
      [precheck, 0],
      [{ ...compile, predicatePolicy: policy }, 0],
    ] as const;
    expect(drive(compiled).state?.predicatePolicy).toEqual(policy);
    // It stays with the change to the end, as the plan's hash does.
    expect(drive([...compiled, [queue, 0], [batch, 0], [land, 0]]).state).toMatchObject({
      state: "landed",
      predicatePolicy: policy,
    });
    // A plan compiled with no policy leaves none: the earlier plan's is gone.
    const recompiled = drive([
      ...compiled,
      [bounce, 0],
      [submit, 0],
      [precheck, 0],
      [compile, 0],
    ]).state;
    expect(recompiled?.state).toBe("verifying");
    expect(recompiled).not.toHaveProperty("predicatePolicy");
  });

  it("[change.derive-effects] a Precheck pass records what it derived at most once, while Deriving: one EffectsDerived alone, at the change's revision; a second is refused and commits nothing, the plan and the drift never carry one, and the next pass derives again", () => {
    let recorded = 0;
    let second = 0;
    fc.assert(
      fc.property(planArb, (plan) => {
        // Read from the log, not the change: has this pass, since its PrecheckStarted, recorded a derivation?
        let derived = false;
        return run(plan).records.every((r) => {
          const deriving = keyOf(r.before) === "deriving";
          const tried = r.probes.every((p) => {
            const events = Result.isSuccess(p.result) ? p.result.success : [];
            if (p.command._tag !== "DeriveEffects")
              return events.every((e) => e._tag !== "EffectsDerived");
            if (!deriving || derived) {
              if (deriving) second++;
              return Result.isFailure(p.result);
            }
            const [only] = events;
            return (
              events.length === 1 &&
              only?._tag === "EffectsDerived" &&
              only.revision === r.before?.intent.revision &&
              only.derivationRef === p.command.derivationRef &&
              JSON.stringify(only.effects) === JSON.stringify(p.command.effects) &&
              p.key === "deriving"
            );
          });
          if (!r.threw) {
            for (const e of eventsOf(r)) {
              if (e._tag === "PrecheckStarted") derived = false;
              if (e._tag === "EffectsDerived") {
                derived = true;
                recorded++;
              }
            }
          }
          return tried;
        });
      }),
    );
    expect(recorded).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(0);
    const deriving = [
      [declare, 0],
      [start, 0],
      [submit, 0],
      [precheck, 0],
    ] as const;
    // Alone and first; then the drift is classified and the plan compiled, neither carrying a derivation.
    const compiled = drive([
      ...deriving,
      [derive, 0],
      [derive, 0],
      [{ ...compile, drift: [{ class: "footprint", severity: "low", detail: "outside" }] }, 0],
      [derive, 0],
    ]);
    expect(tagsOf(compiled.log).slice(-4)).toEqual([
      "PrecheckStarted",
      "EffectsDerived",
      "DriftDetected",
      "PlanCompiled",
    ]);
    expect(compiled.results.slice(-4).map(failureTag)).toEqual([
      undefined,
      "ChangeStateRefused",
      undefined,
      "ChangeStateRefused",
    ]);
    expect(compiled.state).toMatchObject({ state: "verifying", derivationRef: "derivation-1" });
    // Without a derivation the plan compiles as before, and records none.
    const plain = drive([...deriving, [compile, 0]]);
    expect(tagsOf(plain.log).slice(-2)).toEqual(["PrecheckStarted", "PlanCompiled"]);
    expect(plain.state).not.toHaveProperty("derivationRef");
    // Before the pass starts there is nothing to derive from.
    const early = drive([
      [declare, 0],
      [start, 0],
      [submit, 0],
      [derive, 0],
    ]);
    expect(failureTag(early.results.at(-1))).toBe("ChangeStateRefused");
    expect(tagsOf(early.log)).not.toContain("EffectsDerived");
    // The derivation is on the log when the drift sends the change back to its agent.
    const drifted = drive([...deriving, [derive, 0], [drifts, 0]]);
    expect(tagsOf(drifted.log).slice(-2)).toEqual(["EffectsDerived", "ChangeDrifted"]);
    expect(drifted.state?.state).toBe("drifted");
    // A bounced change resubmitted without a revision is a new pass over a new commit: it derives again.
    const again = drive([
      ...deriving,
      [derive, 0],
      [bounce, 0],
      [submit, 0],
      [precheck, 0],
      [{ ...derive, derivationRef: "derivation-2" }, 0],
    ]);
    expect(failureTag(again.results.at(-1))).toBeUndefined();
    expect(again.state).toMatchObject({ state: "deriving", derivationRef: "derivation-2" });
    expect(
      again.log.flatMap((e) =>
        e._tag === "EffectsDerived" ? [[e.revision, e.derivationRef]] : [],
      ),
    ).toEqual([
      [1, "derivation-1"],
      [1, "derivation-2"],
    ]);
  });

  it("[change.landed-commit] a change carries its commit on trunk from the moment it lands, and never before", () => {
    let landings = 0;
    assertReaching(
      fc.property(planArb, (plan) => {
        let onTrunk: string | undefined;
        return run(plan).records.every((r) => {
          if (r.threw) return true;
          if (r.result !== undefined && Result.isSuccess(r.result)) {
            for (const e of r.result.success) {
              if (e._tag === "ChangeLanded") {
                onTrunk = e.commitSha;
                landings++;
              }
            }
          }
          return (
            r.after?.landedCommit === onTrunk &&
            (r.after === undefined || "landedCommit" in r.after === (r.after.state === "landed"))
          );
        });
      }),
    );
    expect(landings).toBeGreaterThan(0);
    const queued = [declare, start, submit, precheck, compile, queue, batch].map(
      (c) => [c, 1] as const,
    );
    const integrating = drive(queued).state;
    expect(integrating?.state).toBe("integrating");
    expect(integrating).not.toHaveProperty("landedCommit");
    // Landed as the restacked commit, which is not the commit it submitted.
    const landed = drive([...queued, [land, 1]]).state;
    expect(landed).toMatchObject({ state: "landed", landedCommit: ON_TRUNK });
    expect(landed?.commitSha).not.toBe(ON_TRUNK);
  });

  it("[change.preflight-alternatives] PreflightIssued carries the preflight's alternatives as they were given, on declare, revise and rely, and none when the preflight names none", () => {
    const others = [31, 32, 33].map((n) => makeId("chg", ulid(n)));
    fc.assert(
      fc.property(
        fc.array(fc.shuffledSubarray(others), { minLength: 3, maxLength: 3 }),
        propositionArb(),
        (lists, premise) => {
          const events = preflightsIssued(lists, premise);
          return (
            events.length === 3 &&
            lists.every((given, i) => {
              const event = events[i];
              return (
                event !== undefined &&
                (given.length === 0
                  ? !("alternatives" in event)
                  : JSON.stringify(event.alternatives) === JSON.stringify(given))
              );
            })
          );
        },
      ),
    );
    const [first, second, third] = others;
    if (first === undefined || second === undefined || third === undefined) throw new Error("ids");
    const events = preflightsIssued([[third, first], [], [second]], {
      subject: SubjectKey.make("authz.permission-evaluation"),
      predicate: "freshness",
      relation: "at-most",
      value: "per-request",
    });
    expect(events.map((e) => e.alternatives)).toEqual([[third, first], undefined, [second]]);
    expect(events[1]).not.toHaveProperty("alternatives");
  });

  it("[change.queued-plan-hash] every enqueue, first or after a requeue, carries the hash of the plan the change was last compiled to", () => {
    fc.assert(
      fc.property(planArb, (plan) => {
        let compiled: ContentHash | undefined;
        return run(plan).log.every(({ payload }) => {
          if (payload._tag === "PlanCompiled") compiled = payload.planHash;
          return payload._tag === "ChangeQueued" || payload._tag === "ChangeRequeued"
            ? compiled !== undefined && payload.planHash === compiled
            : true;
        });
      }),
    );
    const requeued = drive([
      [declare, 0],
      [start, 0],
      [submit, 0],
      [precheck, 0],
      [compile, 0],
      [queue, 0],
      [batch, 0],
      [{ _tag: "Requeue", batchId: BATCH, reason: "infra-failure" }, 0],
    ]);
    expect(
      requeued.log.filter((e) => e._tag === "ChangeQueued" || e._tag === "ChangeRequeued"),
    ).toMatchObject([{ planHash: PLAN_HASH }, { planHash: PLAN_HASH }]);
  });

  it("[change.chart] every state change a run makes is an edge of the Change chart, and a tour of the machine exercises every edge", () => {
    fc.assert(
      fc.property(planArb, (plan) =>
        run(plan).records.every((r) => offChart(changeChart, foldsIn(r), changeView).length === 0),
      ),
    );
    const walked = changeTour();
    expect(offChart(changeChart, walked, changeView)).toEqual([]);
    expect(uncovered(changeChart, walked, changeView)).toEqual([]);
    // The edge out of the wait for a ruling is walked by a ruling's decision, and by nothing else a decision causes.
    expect([
      ...new Set(
        walked
          .filter((f) => f.event._tag === "ChangeBounced" && f.event.decisionId !== undefined)
          .map((f) => `${changeView.from(f)} to ${changeView.to(f)}`),
      ),
    ]).toEqual(["parked.awaitingRuling to bounced"]);
  });

  it("[lease.chart] every change a run makes to a lease is an edge of the Lease chart, and a tour of the machine exercises every edge", () => {
    fc.assert(
      fc.property(planArb, (plan) =>
        run(plan).records.every((r) => offChart(leaseChart, foldsIn(r), leaseView).length === 0),
      ),
    );
    const walked = changeTour();
    expect(offChart(leaseChart, walked, leaseView)).toEqual([]);
    expect(uncovered(leaseChart, walked, leaseView)).toEqual([]);
  });
});
