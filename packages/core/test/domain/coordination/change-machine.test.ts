import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  type Blockers,
  Change,
  type ChangeCommand,
  ChangeEvent,
  decideChange,
  evolveChange,
  type Preflight,
  type Proposition,
  renew,
  replayChange,
} from "../../../src/domain/coordination/index.ts";
import {
  canonicalJson,
  CommitSha,
  type Committed,
  ContentHash,
  IllegalTransition,
  Instant,
  type Json,
  type LeaseId,
  makeId,
} from "../../../src/domain/kernel/index.ts";
import { propositionArb } from "../../arbitraries/coordination.ts";
import { fc } from "../../support/fast-check.ts";

// The lease TTL as the docs state it (state-machines.md § Lease), typed here rather than imported.
const TTL = 15 * 60 * 1000;
const T0 = Instant(1_760_000_000_000);

const ulid = (n: number): string => String(n).padStart(26, "0");
const CHANGE = makeId("chg", ulid(1));
const AGENT = makeId("agt", ulid(1));
const NEVER_ISSUED = makeId("lse", "Z".repeat(26));
const SHA = CommitSha.make("c".repeat(40));
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
  "Submit",
  "StartPrecheck",
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
  "Renew",
];

/** Per state, the command that moves a change along the happy path, from state-machines.md. */
const PROGRESS: Readonly<Record<Key, readonly Kind[]>> = {
  none: ["Declare"],
  declared: ["Start"],
  working: ["Submit"],
  submitted: ["StartPrecheck"],
  deriving: ["CompilePlan"],
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
  working: ["Revise", "Rely", "Lapse", "Adopt", "Renew"],
  submitted: ["Lapse", "Adopt", "Renew"],
  deriving: ["Drift", "Bounce", "Lapse", "Adopt"],
  drifted: ["Lapse", "Adopt", "Renew"],
  verifying: ["Park", "Bounce", "Lapse", "Adopt"],
  queued: ["Bounce", "Lapse", "Supersede"],
  integrating: ["Requeue", "Bounce", "Lapse", "Adopt"],
  bounced: ["Revise", "Lapse", "Adopt", "Renew"],
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
      return { _tag: "Start", workspaceId: mint.next("wsp") };
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
    case "Submit":
      return { _tag: "Submit", leaseId: token, commitSha: SHA, inWorkspace: step.flag };
    case "StartPrecheck":
      return { _tag: "StartPrecheck", instanceId: `precheck-${step.pick}` };
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
        ...(step.operator ? { derivation: { effects: [], derivationRef: "mfp:derivation" } } : {}),
        drift: step.flag
          ? []
          : [{ class: "footprint", severity: "low", detail: "outside the footprint" }],
        planHash: ContentHash.make(`sha256:${"0".repeat(64)}`),
        steps: 3,
        costEstimate: 1.5,
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
      return {
        _tag: "Bounce",
        verdictId: mint.next("vrd"),
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
        trunkSha: CommitSha.make("d".repeat(40)),
        candidateId: mint.next("cnd"),
        proofId: "proof",
      };
    case "Resume":
      return { _tag: "Resume", decisionId: mint.next("dec") };
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
          ? { _tag: "Operator", by: "operator:zb" }
          : { _tag: "Lease", leaseId: token },
      };
    case "Supersede":
      return { _tag: "Supersede", by: mint.next("chg") };
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
  command._tag === "Revise" || command._tag === "Rely" || command._tag === "Submit"
    ? command.leaseId
    : command._tag === "Withdraw" && command.authority._tag === "Lease"
      ? command.authority.leaseId
      : undefined;

/** Plays a plan the way the Change DO would: decide, commit each event through evolve, renew the lease on an authorised call. */
const play = (plan: Plan): Trace => {
  const mint = new Mint();
  const records: Played[] = [];
  const log: Committed<ChangeEvent>[] = [];
  const issued: LeaseId[] = [];
  let state: Change | undefined;
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
    const probes = ALL.flatMap((k) =>
      k === "Renew" ? [] : [attempt(before, build(k, before, step, plan, mint, issued), now)],
    );
    const kind = choices[step.pick % choices.length] ?? "Lapse";
    if (kind === "Renew") {
      const renewed =
        state === undefined ? undefined : renew(state, tokenFor(state, step, issued), now);
      const after = renewed !== undefined && Result.isSuccess(renewed) ? renewed.success : state;
      records.push({ kind, probes, before: state, now, step, after, threw: false });
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
    records.push({ kind, probes, before: state, now, step, command, result, after, threw });
    if (threw) break;
    state = after;
  }
  return { records, log, final: state };
};

/** Every property draws the same plans from the same seed: play each one once. */
const traces = new Map<string, Trace>();
const run = (plan: Parameters<typeof play>[0]): Trace => {
  const key = JSON.stringify(plan);
  const known = traces.get(key);
  if (known !== undefined) return known;
  const trace = play(plan);
  traces.set(key, trace);
  return trace;
};

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
    case "Submit":
      return (key === "working" || key === "bounced") && command.inWorkspace
        ? "submitted"
        : "refused";
    case "StartPrecheck":
      return key === "submitted" ? "deriving" : "refused";
    case "Drift":
      return key === "deriving" ? intoAgent("drifted") : "refused";
    case "CompilePlan":
      return key === "deriving" ? "verifying" : "refused";
    case "Queue":
      return key === "verifying" && !anyBlocker(command.blockers) ? "queued" : "refused";
    case "Park":
      return key === "verifying" ? "parked:awaiting-ruling" : "refused";
    case "Batch":
      return key === "queued" && !anyBlocker(command.blockers) ? "integrating" : "refused";
    case "Requeue":
      return key === "integrating" && batchMatches(command.batchId) ? "queued" : "refused";
    case "Bounce":
      return key === "deriving" ||
        key === "verifying" ||
        key === "queued" ||
        key === "parked:awaiting-ruling" ||
        (key === "integrating" && batchMatches(command.batchId))
        ? intoAgent("bounced")
        : "refused";
    case "Land":
      return key === "integrating" ? "landed" : "refused";
    case "Resume":
      return key === "parked:awaiting-ruling" ? "verifying" : "refused";
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
const declare: ChangeCommand = {
  _tag: "Declare",
  changeId: CHANGE,
  agentId: AGENT,
  origin: "agent",
  goal: "cache the session",
  footprint: [],
  premises: [],
  leaseId: LEASE,
  preflight,
};
const start: ChangeCommand = { _tag: "Start", workspaceId: makeId("wsp", ulid(3)) };
const submit: ChangeCommand = { _tag: "Submit", leaseId: LEASE, commitSha: SHA, inWorkspace: true };
const precheck: ChangeCommand = { _tag: "StartPrecheck", instanceId: "precheck-1" };
const compile: ChangeCommand = {
  _tag: "CompilePlan",
  drift: [],
  planHash: ContentHash.make(`sha256:${"0".repeat(64)}`),
  steps: 3,
  costEstimate: 1,
};
const clear = { openProvenConflicts: [], failingGuards: [], unresolvedHighDrift: [] };
const queue: ChangeCommand = { _tag: "Queue", laneId: "lane:default", blockers: clear };
const BATCH = makeId("bat", ulid(4));
const batch: ChangeCommand = { _tag: "Batch", batchId: BATCH, blockers: clear };
const land: ChangeCommand = {
  _tag: "Land",
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
const withdrawByOperator: ChangeCommand = {
  _tag: "Withdraw",
  authority: { _tag: "Operator", by: "operator:zb" },
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

describe("the Change machine", () => {
  it("[change.transitions] in every state a run reaches, every command lands where the docs' table says, or is refused", () => {
    fc.assert(
      fc.property(planArb, (plan) =>
        run(plan).records.every((r) =>
          r.probes.every((probe) => {
            const expected = oracle(r.before, probe.command, r.now);
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
      [withdrawByOperator, 1],
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
    fc.assert(
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
    fc.assert(
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
    fc.assert(
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
    fc.assert(
      fc.property(planArb, (plan) =>
        run(plan)
          .records.filter(
            (r) =>
              keyOf(r.before) === "queued" &&
              (r.command?._tag === "Bounce" || (r.command?._tag === "Batch" && r.step.blocked)),
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
});

describe("the Lease", () => {
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
      next: ["Changes_getChange"],
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
      next: ["call"],
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
