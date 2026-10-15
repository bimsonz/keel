import { Cause, Effect, Result } from "effect";
import type { SubjectKey } from "../../domain/coordination/index.ts";
import type {
  CandidateId,
  ChangeId,
  CommitSha,
  ConflictId,
  ContentHash,
  GuardId,
  Instant,
  NamespaceId,
  ProbeId,
  ProjectId,
} from "../../domain/kernel/index.ts";
import type {
  Conflict,
  ConflictState,
  DraftFailure,
  FlowWorld,
  Probe,
  World,
} from "../../domain/verification/index.ts";
import {
  AdmittedGuards,
  CandidateBundles,
  CandidateComposer,
  Clock,
  CodeHost,
  type ConflictView,
  Ids,
  type LedgerRefusal,
  NoopWorlds,
  ProbeChanges,
  ProbeLedger,
  ProbeRunner,
  ProbeSources,
  type RepoRef,
  type SubjectRef,
  type Subscriber,
  Trunks,
  WorldChecks,
} from "../ports/index.ts";
import { type DraftOutcome, draftProbe } from "./draft-probe.ts";
import {
  type BuiltWorlds,
  draftContextOf,
  draftWorlds,
  guardOf,
  type PartyWorld,
  PROBE_SUBMISSION_WAIT_MS,
  type ProbeParties,
  type ProbeWorldPlan,
  partiesOf,
  probeWorldPlan,
  type RepoCommit,
  reportsOf,
} from "./probe-conflict.ts";
import { FRESHNESS_TEMPLATE } from "./probe-templates/freshness.ts";
import { type MatrixCell, storeCell } from "./run-matrix.ts";
import { trunkCheckPlan, worldCheckInstanceId, worldCheckJobs } from "./world-check.ts";

/** The conflict a Probe instance is drafting for, and where it reports. */
export interface ProbeCall {
  /** The namespace the project belongs to, as the instance's `namespace` step read it: every bundle, probe, plan and evidence document of this conflict is kept under it. */
  readonly namespace: NamespaceId;
  readonly projectId: ProjectId;
  /** The subject whose Subject DO hosts the conflict. */
  readonly key: SubjectKey;
  readonly conflictId: ConflictId;
  /** The Workflow instance: `probe-<conflictId>`. */
  readonly instanceId: string;
  /** The project's staging repo: every trunk-side world is read from it, and AB's ref goes to it. */
  readonly staging: RepoRef;
}

/** How a step is run: a read or a write retries quickly; a draft is long and costly, so it retries little. */
export type StepPolicy = "quick" | "draft";

/**
 * The Workflow's durable steps, as the Probe program uses them. `step` runs
 * its effect once and keeps its value, so a replay answers the kept value
 * without running it again; a defect throws, and the step is tried again.
 * `waitFor` waits for one event of `type`, answering false once `timeoutMs`
 * passes without one; an event sent before the wait began still counts.
 * `sleep` waits `ms` once, durably: a replay does not wait again.
 */
export interface ProbeSteps {
  readonly step: <A, R>(
    name: string,
    effect: Effect.Effect<A, never, R>,
    policy?: StepPolicy,
  ) => Effect.Effect<A, never, R>;
  readonly waitFor: (name: string, type: string, timeoutMs: number) => Effect.Effect<boolean>;
  readonly sleep: (name: string, ms: number) => Effect.Effect<void>;
}

/** The address a waiting party's next submission is sent to: this instance. */
export const probeSubscriber = (instanceId: string): Subscriber => `workflow:Probe/${instanceId}`;

/** The event a party's next submission, withdrawal or supersession reaches this instance as. */
export const partyEventType = (changeId: ChangeId): string => `change-${changeId}`;

/** Where AB's composed tip goes in staging: never a `cand/` ref, since AB is no batch. */
export const abRef = (conflictId: ConflictId): string => `refs/heads/probe/${conflictId}/ab`;

/**
 * How many times the worlds are read again after a party's workspace went
 * away under the read (it landed or left): each time, the parties are read
 * afresh and the worlds planned again.
 */
export const PROBE_WORLD_ROUNDS = 3;

/**
 * How long the program waits before it drafts again, after the first draft
 * and after the second: a runner that could not run, or a model that was
 * rate-limited, is given time to come back. Each is one bounded wait between
 * two tries, never a poll.
 */
export const PROBE_DRAFT_WAITS_MS = [30_000, 120_000] as const;

/** The most drafts a conflict is given: the first, and one after each wait. */
export const PROBE_DRAFTS = 1 + PROBE_DRAFT_WAITS_MS.length;

/**
 * How a Probe instance ended. Only `unreadable` and `errored` are failures:
 * the Workflow ends errored with the reason, loudly. Once the conflict was
 * read as suspected, each of them first records why it has no probe, so it
 * is never left suspected in silence; only `errored` at the first read of the
 * conflict reports no fact.
 */
export type ProbeEnd =
  | {
      readonly outcome: "admitted";
      readonly probeId: ProbeId;
      readonly guardId: GuardId;
      readonly guardCommit: CommitSha;
    }
  /**
   * Drafted with its cells, and no guard: the domain discarded the probe, or
   * no cell decided it and its run was recorded as failed.
   */
  | { readonly outcome: "drafted"; readonly probeId: ProbeId; readonly state: Probe["state"] }
  | { readonly outcome: "draft-failed"; readonly reason: DraftFailure; readonly attempts: number }
  /** The conflict is no longer suspected: nothing to draft. */
  | { readonly outcome: "moved-on"; readonly state: ConflictState }
  /**
   * The ledger refused a fact: the conflict moved on while this instance ran,
   * or it refused a cell of a probe still calibrating, whose run was then
   * recorded as failed.
   */
  | { readonly outcome: "stale"; readonly step: string; readonly reason: string }
  /** A world's commit could not be read where it must be: a harness error, never a cell. */
  | {
      readonly outcome: "unreadable";
      readonly world: World;
      readonly repo: string;
      readonly commit: string;
      readonly reason: string;
    }
  | { readonly outcome: "errored"; readonly step: string; readonly reason: string };

/** A step's value, done or refused. Plain data, so it keeps across a replay. */
type Answer<A> =
  | { readonly _tag: "Ok"; readonly value: A }
  | { readonly _tag: "Refused"; readonly reason: string };

/** Runs `effect`, keeping a typed failure as a value the program reads. */
const answer = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  reason: (e: E) => string,
): Effect.Effect<Answer<A>, never, R> =>
  effect.pipe(
    Effect.map((value): Answer<A> => ({ _tag: "Ok", value })),
    Effect.catch((e) => Effect.succeed<Answer<A>>({ _tag: "Refused", reason: reason(e) })),
  );

const describeRefusal = (e: LedgerRefusal): string =>
  "reason" in e && typeof e.reason === "string" ? `${e._tag}: ${e.reason}` : e._tag;

const repoName = (repo: RepoRef) => `${repo.namespace}/${repo.name}`;

const sameRepo = (a: RepoRef, b: RepoRef) => a.namespace === b.namespace && a.name === b.name;

/** A read of a world's commit that missed: in staging, a harness error; in a workspace, its party moved on. */
export interface Unread {
  readonly _tag: "Unread";
  readonly world: World;
  readonly repo: RepoRef;
  readonly commit: CommitSha;
  readonly reason: string;
}

const unread =
  (world: World, repo: RepoRef, commit: CommitSha) =>
  (e: { readonly _tag: string }): Unread => ({
    _tag: "Unread",
    world,
    repo,
    commit,
    reason: e._tag,
  });

/** Each party's hunks, read with its worlds, so the draft never reads a workspace that landing collects. */
export interface DraftHunks {
  readonly A: string;
  readonly B: string;
}

/** Every world built and both sides' hunks, or the first read that missed. */
export type WorldsAnswer =
  | { readonly _tag: "Built"; readonly built: BuiltWorlds; readonly hunks: DraftHunks }
  | Unread;

/**
 * Reads every world a draft runs in, in one step: both sides' hunks, the
 * bundles of trunk, A and B, and AB composed onto `plan.AB.onto` and pushed
 * to `abRef` in staging, last, after every other read of a workspace. Each
 * commit is checked present first, so a missing one is named, never bundled
 * as something else. AB that will not compose is absent, which leaves the
 * conflict unprobed.
 */
export const readProbeWorlds = (
  call: ProbeCall,
  parties: ProbeParties,
  plan: ProbeWorldPlan,
  ab: { readonly candidateId: CandidateId; readonly at: Instant },
): Effect.Effect<
  WorldsAnswer,
  never,
  CodeHost | CandidateBundles | CandidateComposer | ProbeSources
> =>
  Effect.gen(function* () {
    const host = yield* CodeHost;
    const bundles = yield* CandidateBundles;
    const sources = yield* ProbeSources;
    const composer = yield* CandidateComposer;
    const present = (world: World, at: RepoCommit) =>
      host.hasCommit(at.repo, at.commit).pipe(
        Effect.mapError(unread(world, at.repo, at.commit)),
        Effect.flatMap((has) =>
          has
            ? Effect.void
            : Effect.fail(unread(world, at.repo, at.commit)({ _tag: "ObjectNotFound" })),
        ),
      );
    const bundle = (world: World, at: RepoCommit) =>
      bundles.bundle(call.namespace, at.repo, at.commit).pipe(
        Effect.mapError((e): Unread => ({
          ...unread(world, at.repo, at.commit)(e),
          reason: e.reason,
        })),
      );
    const hunks = (side: "A" | "B") => {
      const range = plan.hunks[side];
      return sources
        .hunks(range.repo, range.base, range.head)
        .pipe(Effect.mapError(unread(side, range.repo, range.head)));
    };
    return yield* Effect.gen(function* () {
      yield* present("trunk", plan.trunk);
      yield* present("A", plan.A);
      yield* present("B", plan.B);
      yield* present("AB", { repo: call.staging, commit: plan.AB.onto });
      const read: DraftHunks = { A: yield* hunks("A"), B: yield* hunks("B") };
      const trunk = yield* bundle("trunk", plan.trunk);
      const A = yield* bundle("A", plan.A);
      const B = yield* bundle("B", plan.B);
      const composed = yield* Effect.result(
        composer.compose({
          candidateId: ab.candidateId,
          staging: call.staging,
          base: plan.AB.onto,
          at: ab.at,
          ref: abRef(call.conflictId),
          members: plan.AB.members.map((side) => ({
            changeId: parties[side],
            repo: plan[side].repo,
            base: plan.hunks[side].base,
            head: plan[side].commit,
            title: `probe ${call.conflictId}: ${side}`,
          })),
        }),
      );
      const AB = Result.isSuccess(composed)
        ? yield* bundle("AB", { repo: call.staging, commit: composed.success.commitSha })
        : undefined;
      return { _tag: "Built", built: { trunk, A, B, AB }, hunks: read } satisfies WorldsAnswer;
    }).pipe(Effect.catchTag("Unread", (u) => Effect.succeed(u)));
  });

/** A draft's outcome, the world it could not read, or why the runner could not run its matrix. */
export type DraftAnswer =
  | { readonly _tag: "Drafted"; readonly outcome: DraftOutcome }
  | { readonly _tag: "RunnerUnavailable"; readonly reason: string }
  | Unread;

/**
 * Drafts the conflict's probe from its predicate's template: the project's
 * source at the trunk world (in staging), each side's hunks as read with the
 * worlds, and A-noop built from A's world bundle, so no attempt reads a
 * workspace. A predicate with no template has no recipe: its matrix could
 * never be complete, so the draft is incomplete. A runner that could not run
 * the matrix is answered as a value, never a defect: the program waits and
 * drafts afresh, where a step that died would be tried again at once and
 * then end the instance.
 */
export const draftConflict = (
  namespace: NamespaceId,
  parties: ProbeParties,
  plan: ProbeWorldPlan,
  worlds: Readonly<Record<FlowWorld, ContentHash>>,
  hunks: DraftHunks,
  key: string,
) =>
  Effect.gen(function* () {
    const predicate = parties.premise.proposition.predicate;
    if (predicate !== "freshness")
      return {
        _tag: "Drafted",
        outcome: {
          _tag: "Discarded",
          reason: "incomplete",
          attempts: 0,
          feedback: [`no probe template for ${predicate}`],
        },
      } satisfies DraftAnswer;
    const source = yield* (yield* ProbeSources)
      .source(plan.source.repo, plan.source.commit)
      .pipe(Effect.mapError(unread("trunk", plan.source.repo, plan.source.commit)));
    const noop = yield* NoopWorlds;
    const outcome = yield* draftProbe(
      namespace,
      FRESHNESS_TEMPLATE,
      draftContextOf(parties, source, hunks),
      worlds,
      (recipe) => noop.build(namespace, worlds.A, recipe),
      key,
    );
    return { _tag: "Drafted", outcome } satisfies DraftAnswer;
  }).pipe(
    Effect.catchTag("Unread", (u) => Effect.succeed(u)),
    // The VerifierDOs could not take the matrix: nothing about the probe, so the program drafts again later.
    Effect.catchTag("ProbeRunnerUnavailable", (e) =>
      Effect.succeed({ _tag: "RunnerUnavailable", reason: e.reason } satisfies DraftAnswer),
    ),
  );

/** The worlds a draft runs in besides A-noop, in the order the runner is asked about them. */
const RUNNER_WORLDS: readonly FlowWorld[] = ["trunk", "A", "B", "AB"];

/** Every world a draft runs in can take a probe, or the first that cannot and why. */
export type RunnerAnswer =
  | { readonly _tag: "Ready" }
  | { readonly _tag: "Unready"; readonly world: FlowWorld; readonly reason: string };

/**
 * Asks the runner, before any draft, whether a probe could run against each
 * world as the namespace's store stands. A world whose lockfile has no deps
 * bundle refuses every run of every draft, so drafting for it would spend
 * each model call and each wait to learn what one read tells. A runner that
 * does not answer has said nothing of the world: the drafts meet it, with
 * their waits.
 */
export const probeRunnerReady = (
  namespace: NamespaceId,
  worlds: Readonly<Record<FlowWorld, ContentHash>>,
) =>
  Effect.gen(function* () {
    const runner = yield* ProbeRunner;
    for (const world of RUNNER_WORLDS) {
      const asked = yield* runner
        .ready({ namespace, worldBundle: worlds[world] })
        .pipe(Effect.catchTag("ProbeRunnerUnavailable", () => Effect.succeed(undefined)));
      if (asked?._tag === "Unready")
        return { _tag: "Unready", world, reason: asked.reason } satisfies RunnerAnswer;
    }
    return { _tag: "Ready" } satisfies RunnerAnswer;
  });

/** A draft worth drafting again after a wait: the runner could not run it, or the model's rate limit ended it. */
const draftsAgain = (drafted: DraftAnswer): boolean =>
  drafted._tag === "RunnerUnavailable" ||
  (drafted._tag === "Drafted" &&
    drafted.outcome._tag === "Abstained" &&
    drafted.outcome.reason === "rate-limited");

/** A party as the program left it: its world, or why it has none. */
type PartyEnd =
  | { readonly _tag: "World"; readonly world: PartyWorld }
  | { readonly _tag: "Gone"; readonly state: string }
  | { readonly _tag: "Timeout" }
  | { readonly _tag: "Errored"; readonly step: string; readonly reason: string };

/** B's cells first: B never decides, so every one of them is recorded before the cells that admit or discard. */
const reportOrder = (cells: readonly MatrixCell[]): readonly MatrixCell[] => [
  ...cells.filter((c) => c.world === "B"),
  ...cells.filter((c) => c.world !== "B"),
];

const subjectOf = (call: ProbeCall): SubjectRef => ({ projectId: call.projectId, key: call.key });

/** The conflict as its ledger holds it, read in the step `name`. */
const conflictStep = (call: ProbeCall, steps: ProbeSteps, name: string) =>
  ProbeLedger.use((ledger) =>
    steps.step(
      name,
      answer(ledger.conflict(subjectOf(call), call.conflictId), (e) => e._tag),
    ),
  );

/** Records, in the step `name`, that the conflict has no probe and why: the ledger's answer, or its refusal. */
const failureStep = (
  call: ProbeCall,
  steps: ProbeSteps,
  name: string,
  reason: DraftFailure,
  attempts: number,
) =>
  ProbeLedger.use((ledger) =>
    steps.step(
      name,
      answer(
        ledger.probeDraftFailed(subjectOf(call), { conflictId: call.conflictId, attempts, reason }),
        describeRefusal,
      ),
    ),
  );

/**
 * Records, in the step `run-failed`, that the conflict's drafted probe will
 * get no more cells: the ledger's answer, or its refusal.
 */
const runFailedStep = (call: ProbeCall, steps: ProbeSteps) =>
  ProbeLedger.use((ledger) =>
    steps.step(
      "run-failed",
      answer(ledger.probeRunFailed(subjectOf(call), call.conflictId), describeRefusal),
    ),
  );

/**
 * The Probe Workflow's program, one durable step at a time: read the conflict and its parties (A holds the
 * premise, B makes the effect); wait for each party's submission, up to
 * PROBE_SUBMISSION_WAIT_MS in all; plan the worlds from trunk's head (a
 * landed party is its commit on trunk over that commit's first parent); read
 * them; ask the runner whether a probe could run in each; draft, at most
 * PROBE_DRAFTS times, waiting before each further draft when the runner
 * could not run or the model was rate-limited; then report
 * the draft to the conflict's ledger, cell by cell, and commit the guard once
 * the ledger admits it. A world that cannot be read in staging is a harness
 * error, never a cell.
 *
 * Once the conflict has been read as suspected, no end leaves it suspected in
 * silence: a harness error records why there is no probe before the instance
 * fails with it, and so, on a best effort, does a step out of tries or a
 * defect, which then fails as it was going to. Nor does such an end leave it
 * probing: once the draft is recorded the ledger refuses that record, and the
 * probe's run is recorded as failed in its place. So is the run of a probe
 * still calibrating when the ledger refuses one of its cells, or when every
 * cell is reported and none decided it. Only a refused first read of the
 * conflict records nothing: there is no conflict to record it on.
 */
export const probeConflict = (call: ProbeCall, steps: ProbeSteps) =>
  Effect.gen(function* () {
    const first = yield* conflictStep(call, steps, "conflict");
    if (first._tag === "Refused")
      return {
        outcome: "errored",
        step: "conflict",
        reason: `conflict ${call.conflictId} is not on ${call.key}: ${first.reason}`,
      } satisfies ProbeEnd;
    if (first.value.conflict.state !== "suspected")
      return { outcome: "moved-on", state: first.value.conflict.state } satisfies ProbeEnd;
    return yield* probeSuspected(call, steps, first.value.conflict).pipe(
      // A step out of tries, or a defect: say why the conflict has no probe, then fail as it was
      // going to. The record is a best effort in a step of its own name, so whatever becomes of
      // it, the first cause is the one that comes out. A conflict that already has its probe
      // refuses it: what failed was that probe's run, which the ledger is told next, and its
      // machine refuses that in turn of a probe already decided or of a conflict with none.
      // An interruption is neither a failure nor a defect, and records nothing.
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          failureStep(call, steps, "incomplete", "incomplete", 0).pipe(
            Effect.flatMap((recorded) =>
              recorded._tag === "Refused" ? runFailedStep(call, steps) : Effect.succeed(recorded),
            ),
            Effect.exit,
            Effect.andThen(Effect.failCause(cause)),
          ),
      ),
    );
  });

/** The program from a conflict read as suspected to its end: what `probeConflict` holds its catch around. */
const probeSuspected = (call: ProbeCall, steps: ProbeSteps, suspected: Conflict) =>
  Effect.gen(function* () {
    const ledger = yield* ProbeLedger;
    const changes = yield* ProbeChanges;
    const clock = yield* Clock;
    const ids = yield* Ids;
    const trunks = yield* Trunks;
    const guards = yield* AdmittedGuards;
    const checks = yield* WorldChecks;
    const at = subjectOf(call);
    const subscriber = probeSubscriber(call.instanceId);

    const readConflict = (name: string) => conflictStep(call, steps, name);
    const failDraft = (reason: DraftFailure, attempts: number) =>
      Effect.map(failureStep(call, steps, "draft-failed", reason, attempts), (r): ProbeEnd =>
        r._tag === "Refused"
          ? { outcome: "stale", step: "draft-failed", reason: r.reason }
          : { outcome: "draft-failed", reason, attempts },
      );
    /**
     * What a harness error records before it ends the instance, so the
     * conflict is not left suspected with no probe and no word. A record the
     * ledger refuses means the conflict moved on, which changes nothing here:
     * the end is still the harness error.
     */
    const recordHarnessError = (reason: DraftFailure) =>
      failureStep(call, steps, "draft-failed", reason, 0);

    const read = partiesOf(suspected);
    if (Result.isFailure(read)) return yield* failDraft("no-propositions", 0);
    const parties = read.success;

    const started = yield* steps.step("started", clock.now);
    const deadline = started + PROBE_SUBMISSION_WAIT_MS;

    /** A party's world, waiting for its submission while it has none; `round` names this read's steps apart. */
    const party = (side: "A" | "B", changeId: ChangeId, round: string) =>
      Effect.gen(function* () {
        for (let n = 1; ; n++) {
          const name = `party ${side}${round} ${n}`;
          const got = yield* steps.step(
            name,
            answer(changes.awaitSubmission(changeId, subscriber), (e) => e._tag),
          );
          if (got._tag === "Refused")
            return {
              _tag: "Errored",
              step: name,
              reason: `${changeId}: ${got.reason}`,
            } satisfies PartyEnd;
          const answered = got.value;
          if (answered._tag === "Submitted" || answered._tag === "Landed")
            return { _tag: "World", world: answered } satisfies PartyEnd;
          if (answered._tag === "Gone")
            return { _tag: "Gone", state: answered.state } satisfies PartyEnd;
          const now = yield* steps.step(`clock ${side}${round} ${n}`, clock.now);
          if (now >= deadline) return { _tag: "Timeout" } satisfies PartyEnd;
          const heard = yield* steps.waitFor(
            `change ${side}${round} ${n}`,
            partyEventType(changeId),
            deadline - now,
          );
          if (!heard) return { _tag: "Timeout" } satisfies PartyEnd;
        }
      });

    /** Both parties' worlds, or how the program ends without them (Q-D: a party gone re-reads the conflict). */
    const bothParties = (round: string) =>
      Effect.gen(function* () {
        const worlds: PartyWorld[] = [];
        for (const side of ["A", "B"] as const) {
          const end = yield* party(side, parties[side], round);
          if (end._tag === "World") {
            worlds.push(end.world);
            continue;
          }
          if (end._tag === "Errored") {
            yield* recordHarnessError("incomplete");
            return { outcome: "errored", step: end.step, reason: end.reason } satisfies ProbeEnd;
          }
          if (end._tag === "Timeout") return yield* failDraft("no-submission", 0);
          const again = yield* readConflict(`conflict ${side}${round} gone`);
          if (again._tag === "Ok" && again.value.conflict.state !== "suspected")
            return { outcome: "moved-on", state: again.value.conflict.state } satisfies ProbeEnd;
          return yield* failDraft("party-gone", 0);
        }
        const [A, B] = worlds;
        if (A === undefined || B === undefined) return yield* Effect.die(new Error("two parties"));
        return { A, B };
      });

    let planned:
      | {
          readonly sides: { readonly A: PartyWorld; readonly B: PartyWorld };
          readonly plan: ProbeWorldPlan;
          readonly built: BuiltWorlds;
          readonly hunks: DraftHunks;
        }
      | undefined;
    for (let round = 1; planned === undefined; round++) {
      const tag = round === 1 ? "" : `#${round}`;
      if (round > PROBE_WORLD_ROUNDS) {
        yield* recordHarnessError("incomplete");
        return {
          outcome: "errored",
          step: `worlds${tag}`,
          reason: `a party's workspace went away under each of ${PROBE_WORLD_ROUNDS} reads of the worlds`,
        } satisfies ProbeEnd;
      }
      const sides = yield* bothParties(tag);
      if ("outcome" in sides) return sides;
      const head = yield* steps.step(`trunk${tag}`, trunks.head(call.projectId));
      const plan = probeWorldPlan(sides.A, sides.B, { repo: call.staging, commit: head });
      if (Result.isFailure(plan)) return yield* failDraft(plan.failure, 0);
      const ab = yield* steps.step(
        `ab${tag}`,
        Effect.all({ candidateId: ids.next("cnd"), at: clock.now }),
      );
      const worlds = yield* steps.step(
        `worlds${tag}`,
        readProbeWorlds(call, parties, plan.success, ab),
      );
      if (worlds._tag === "Built")
        planned = { sides, plan: plan.success, built: worlds.built, hunks: worlds.hunks };
      else if (sameRepo(worlds.repo, call.staging)) {
        yield* recordHarnessError("worlds-unbuildable");
        return {
          outcome: "unreadable",
          world: worlds.world,
          repo: repoName(worlds.repo),
          commit: worlds.commit,
          reason: worlds.reason,
        } satisfies ProbeEnd;
      }
      // Otherwise a workspace went away under the read: its party landed or left, so read the parties again.
    }

    const worlds = draftWorlds(planned.built);
    if (Result.isFailure(worlds)) return yield* failDraft(worlds.failure, 0);
    // Asked before any draft: a world no probe could run against is the namespace's store as it
    // stands, which no later draft changes, so it ends here with no model call and no wait.
    const runner = yield* steps.step("runner", probeRunnerReady(call.namespace, worlds.success));
    if (runner._tag === "Unready") {
      yield* recordHarnessError("incomplete");
      return {
        outcome: "errored",
        step: "runner",
        reason: `the probe runner cannot run in world ${runner.world}: ${runner.reason}`,
      } satisfies ProbeEnd;
    }
    // Each draft is its own step, and so is each wait. A draft the runner could not run, or one the
    // model's rate limit ended, says nothing about the probe, so the conflict is drafted afresh.
    let draft: { readonly step: string; readonly answer: DraftAnswer } | undefined;
    for (let n = 1; draft === undefined; n++) {
      const step = n === 1 ? "draft" : `draft#${n}`;
      const answered = yield* steps.step(
        step,
        // Its model calls are counted under the instance and the step, so a retried step counts none twice.
        draftConflict(
          call.namespace,
          parties,
          planned.plan,
          worlds.success,
          planned.hunks,
          `${call.instanceId}:${step}`,
        ),
        "draft",
      );
      const wait = PROBE_DRAFT_WAITS_MS[n - 1];
      if (n >= PROBE_DRAFTS || wait === undefined || !draftsAgain(answered))
        draft = { step, answer: answered };
      else yield* steps.sleep(`${step} wait`, wait);
    }
    const drafted = draft.answer;
    if (drafted._tag === "Unread") {
      yield* recordHarnessError("worlds-unbuildable");
      return {
        outcome: "unreadable",
        world: drafted.world,
        repo: repoName(drafted.repo),
        commit: drafted.commit,
        reason: drafted.reason,
      } satisfies ProbeEnd;
    }
    if (drafted._tag === "RunnerUnavailable") {
      yield* recordHarnessError("incomplete");
      return {
        outcome: "errored",
        step: draft.step,
        reason: `the probe runner could not run any of ${PROBE_DRAFTS} drafts: ${drafted.reason}`,
      } satisfies ProbeEnd;
    }
    const report = reportsOf(drafted.outcome);
    if (report._tag === "DraftFailed") return yield* failDraft(report.reason, report.attempts);

    const recorded = yield* steps.step(
      "drafted",
      answer(
        ledger.probeDrafted(at, {
          conflictId: call.conflictId,
          attempts: report.attempts,
          bundleHash: report.probe,
        }),
        describeRefusal,
      ),
    );
    if (recorded._tag === "Refused")
      return { outcome: "stale", step: "drafted", reason: recorded.reason } satisfies ProbeEnd;
    const probeId = recorded.value.probe?.id;
    if (probeId === undefined) {
      yield* recordHarnessError("incomplete");
      return {
        outcome: "errored",
        step: "drafted",
        reason: "the ledger recorded the draft but answered no probe",
      } satisfies ProbeEnd;
    }

    // The world checks: started once the probe is drafted, each recording its own checks.
    // They are evidence for people, not for admission, so the cells never wait for them.
    const trunkPlan = yield* steps.step(
      "trunk plan",
      trunkCheckPlan(call.namespace, call.staging, planned.plan.trunk.commit),
    );
    const jobs = worldCheckJobs(
      {
        namespace: call.namespace,
        projectId: call.projectId,
        key: call.key,
        conflictId: call.conflictId,
      },
      parties,
      worlds.success,
      trunkPlan,
    );
    yield* steps.step(
      "world checks",
      Effect.forEach(jobs, (job) => {
        const id = worldCheckInstanceId(call.conflictId, job.world);
        return Effect.as(checks.start(id, job), id);
      }),
    );

    let last: ConflictView = recorded.value;
    for (const cell of reportOrder(report.cells)) {
      const name = `cell ${cell.world}@${cell.run}`;
      const ran = yield* steps.step(
        name,
        storeCell(call.namespace, cell).pipe(
          Effect.flatMap((resultRef) =>
            answer(
              ledger.probeCellRan(at, {
                conflictId: call.conflictId,
                probeId,
                world: cell.world,
                run: cell.run,
                outcome: cell.outcome,
                resultRef,
              }),
              describeRefusal,
            ),
          ),
        ),
      );
      if (ran._tag === "Ok") {
        last = ran.value;
        continue;
      }
      // Refused: once the cells so far decide the probe, the rest have nothing to record.
      const now = yield* readConflict(`decided ${cell.world}@${cell.run}`);
      if (
        now._tag === "Ok" &&
        now.value.probe !== undefined &&
        now.value.probe.state !== "calibrating"
      ) {
        last = now.value;
        break;
      }
      // Still calibrating, and it will get no more cells: the ledger is told its run failed.
      yield* runFailedStep(call, steps);
      return { outcome: "stale", step: name, reason: ran.reason } satisfies ProbeEnd;
    }

    const guard = guardOf(last.probe, parties);
    if (guard === undefined) {
      const state = last.probe?.state ?? "calibrating";
      if (state !== "calibrating") return { outcome: "drafted", probeId, state } satisfies ProbeEnd;
      // Every cell is reported and none decided the probe: the ledger is told its run failed.
      const failed = yield* runFailedStep(call, steps);
      return {
        outcome: "drafted",
        probeId,
        state: failed._tag === "Ok" ? (failed.value.probe?.state ?? state) : state,
      } satisfies ProbeEnd;
    }
    const guardCommit = yield* steps.step(
      "guard",
      guards.admit(call.projectId, guard, report.files),
    );
    return { outcome: "admitted", probeId, guardId: guard.guardId, guardCommit } satisfies ProbeEnd;
  });
