import { describe, expect, it } from "@effect/vitest";
import { ChangeId, ConflictId, EventEnvelope, ProbeId, ProjectId } from "@keeltown/core/kernel";
import { ProjectViews } from "@keeltown/core/ports";
import { Effect, type Layer, Schema } from "effect";

/**
 * What the `ProjectViews` suite needs beside the port: a way to make an event
 * arrive, as a committing object's outbox delivers it to the Projector. A real
 * Projector is shared, so every case works in a project of its own.
 */
export interface ProjectViewsHarness {
  readonly layer: Layer.Layer<ProjectViews>;
  readonly arrive: (event: EventEnvelope) => Effect.Effect<void>;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ulid = () =>
  [...crypto.getRandomValues(new Uint8Array(26))].map((b) => CROCKFORD[b % 32] ?? "0").join("");
const id = (prefix: string) => `${prefix}_${ulid()}`;
const sha = (n: number) => n.toString(16).padStart(40, "c");
const changeRef = (changeId: string) => ({ kind: "change", id: changeId });
const SUBJECT = "authz.permission-evaluation";
const BUNDLE = `sha256:${"a".repeat(64)}`;
/** One discriminating run of a probe: it passes on trunk and in the holder's world, and fails combined and against the control. */
const DISCRIMINATING = [
  ["trunk", "pass"],
  ["A", "pass"],
  ["AB", "fail"],
  ["A-noop", "fail"],
] as const;

/** Builds envelopes for one project, as their emitters would commit them. */
export function projectEvents(project: string = id("prj")) {
  const seqs = new Map<string, number>();
  let clock = Date.UTC(2026, 9, 11, 9);
  const envelope = (entity: { kind: string; id: string }, payload: { _tag: string }) => {
    const seq = (seqs.get(entity.id) ?? 0) + 1;
    seqs.set(entity.id, seq);
    const eventId = id("evt");
    clock += 1_000;
    return Schema.decodeUnknownSync(EventEnvelope)({
      eventId,
      type: payload._tag,
      entity,
      seq,
      at: clock,
      dedupeKey: `${entity.kind}:${entity.id}/${eventId}/${payload._tag}#1`,
      affected: [],
      notified: [],
      project,
      payload,
    });
  };
  /** Precheck's derivation of a change's diff, touching `paths`. */
  const derived = (changeId: string, paths: readonly string[]) =>
    envelope(changeRef(changeId), {
      _tag: "EffectsDerived",
      changeId,
      revision: 1,
      effects: [],
      derivationRef: `sha256:${"d".repeat(64)}`,
      paths,
    } as { _tag: string });
  return {
    project: ProjectId.make(project),
    derived,
    declared: (changeId: string, agentId: string, goal: string) =>
      envelope(changeRef(changeId), {
        _tag: "IntentDeclared",
        changeId,
        agentId,
        origin: "agent",
        revision: 1,
        goal,
        footprint: [],
        premises: [],
        leaseId: id("lse"),
      } as { _tag: string }),
    started: (changeId: string) =>
      envelope(changeRef(changeId), {
        _tag: "ChangeStarted",
        changeId,
        workspaceId: id("wsp"),
        baseSha: sha(1),
      } as { _tag: string }),
    /**
     * A started change's way from its submission to trunk, landing as
     * `commit`, as its Change object commits it; with `paths`, Precheck's
     * derivation says its diff touched them.
     */
    landing: (changeId: string, commit: string, paths?: readonly string[]) => [
      envelope(changeRef(changeId), {
        _tag: "ChangeSubmitted",
        changeId,
        revision: 1,
        commitSha: commit,
        workspaceId: id("wsp"),
      } as { _tag: string }),
      envelope(changeRef(changeId), {
        _tag: "PrecheckStarted",
        changeId,
        revision: 1,
        instanceId: id("wfi"),
      } as { _tag: string }),
      ...(paths === undefined ? [] : [derived(changeId, paths)]),
      envelope(changeRef(changeId), {
        _tag: "PlanCompiled",
        changeId,
        revision: 1,
        planHash: BUNDLE,
        steps: 1,
        costEstimate: 0,
      } as { _tag: string }),
      envelope(changeRef(changeId), {
        _tag: "ChangeQueued",
        changeId,
        laneId: "main",
      } as { _tag: string }),
      envelope(changeRef(changeId), {
        _tag: "ChangeBatched",
        changeId,
        batchId: id("bat"),
      } as { _tag: string }),
      envelope(changeRef(changeId), {
        _tag: "ChangeLanded",
        changeId,
        commitSha: commit,
        trunkSha: commit,
        candidateId: id("cnd"),
        proofId: id("prf"),
      } as { _tag: string }),
    ],
    withdrawn: (changeId: string) =>
      envelope(changeRef(changeId), {
        _tag: "ChangeWithdrawn",
        changeId,
        by: "contract",
      } as { _tag: string }),
    /** A proposal of `fork`'s `commit` by `proposer`, as its Change object commits it: submitted, no agent holding it. */
    proposed: (changeId: string, fork: string, commit: string, proposer: string) => [
      envelope(changeRef(changeId), {
        _tag: "IntentDeclared",
        changeId,
        origin: "proposal",
        revision: 1,
        goal: "a proposal",
        footprint: [],
        premises: [],
      } as { _tag: string }),
      envelope(changeRef(changeId), {
        _tag: "ChangeProposed",
        changeId,
        fork,
        commit,
        proposer,
      } as { _tag: string }),
      envelope(changeRef(changeId), {
        _tag: "ChangeStarted",
        changeId,
        workspaceId: id("wsp"),
        baseSha: sha(1),
      } as { _tag: string }),
      envelope(changeRef(changeId), {
        _tag: "ChangeSubmitted",
        changeId,
        revision: 1,
        commitSha: commit,
        workspaceId: id("wsp"),
      } as { _tag: string }),
    ],
    trunkInitialized: (head: string) =>
      envelope({ kind: "trunk", id: project }, {
        _tag: "TrunkInitialized",
        projectId: project,
        head,
        by: "contract",
      } as { _tag: string }),
    /** Any event of this project on `entity`, as its emitter would commit it. */
    of: (entity: { kind: string; id: string }, payload: { _tag: string }) =>
      envelope(entity, payload),
    /** A semantic conflict suspected between `holder`'s premise and `other`'s effect on one subject. */
    suspected: (
      conflictId: string,
      holder: string,
      other: string,
      evidence?: { declared: boolean; method?: string; evidenceClass: string },
      subject: string = SUBJECT,
    ) =>
      envelope({ kind: "conflict", id: conflictId }, {
        _tag: "ConflictSuspected",
        conflictId,
        kind: "semantic",
        parties: [holder, other],
        subjectKey: subject,
        predicate: "freshness",
        origin: "fallout",
        premise: {
          holder,
          proposition: {
            subject,
            predicate: "freshness",
            relation: "at-most",
            value: "per-request",
            strength: "must",
          },
        },
        effect: {
          changeId: other,
          proposition: {
            subject,
            predicate: "freshness",
            relation: "is",
            value: "per-session",
          },
          ...(evidence === undefined ? {} : { evidence }),
        },
      } as { _tag: string }),
    probeDrafted: (conflictId: string, probeId: string, bundleHash: string = BUNDLE) =>
      envelope({ kind: "probe", id: probeId }, {
        _tag: "ProbeDrafted",
        probeId,
        conflictId,
        attempts: 2,
        bundleHash,
      } as { _tag: string }),
    /** A probe none of whose drafts compiled: it begins discarded, with no bundle. */
    probeDraftFailed: (conflictId: string, probeId: string) =>
      envelope({ kind: "probe", id: probeId }, {
        _tag: "ProbeDiscarded",
        probeId,
        conflictId,
        reason: "draft-failed",
        detail: "no-propositions",
      } as { _tag: string }),
    probeRan: (conflictId: string, probeId: string, world: string, run: number, outcome: string) =>
      envelope({ kind: "probe", id: probeId }, {
        _tag: "ProbeRan",
        probeId,
        conflictId,
        world,
        run,
        outcome,
        resultRef: `result:${world}:${run}`,
      } as { _tag: string }),
    guardAdmitted: (conflictId: string, probeId: string, guardId: string) =>
      envelope({ kind: "probe", id: probeId }, {
        _tag: "GuardAdmitted",
        guardId,
        probeId,
        conflictId,
        runs: 3,
      } as { _tag: string }),
    proven: (conflictId: string, probeId: string) =>
      envelope({ kind: "conflict", id: conflictId }, {
        _tag: "ConflictProven",
        conflictId,
        evidence: { _tag: "probe", probeId },
      } as { _tag: string }),
    dismissed: (conflictId: string, evidence = "lattice:compatible") =>
      envelope({ kind: "conflict", id: conflictId }, {
        _tag: "ConflictDismissed",
        conflictId,
        evidence,
      } as { _tag: string }),
    worldCheckRan: (
      conflictId: string,
      world: string,
      check: string,
      run: number,
      outcome: string,
      counts?: { passed: number; failed: number; skipped: number },
    ) =>
      envelope({ kind: "conflict", id: conflictId }, {
        _tag: "WorldCheckRan",
        conflictId,
        world,
        check,
        run,
        outcome,
        ...(counts === undefined ? {} : { counts }),
        ...(outcome === "n/a" ? { reason: "the suite has no test under the change" } : {}),
      } as { _tag: string }),
    /** The change bounced over a conflict proven against it. */
    bounced: (changeId: string, conflictId: string) =>
      envelope(changeRef(changeId), {
        _tag: "ChangeBounced",
        changeId,
        conflictId,
        reasons: [`conflict ${conflictId} is proven against this change`],
        nextActions: [
          { kind: "read", title: "Read the conflict", operationId: "Conflicts_getConflict" },
        ],
      } as { _tag: string }),
    trunkAdvanced: (from: string, to: string, height?: number) =>
      envelope({ kind: "trunk", id: project }, {
        _tag: "TrunkAdvanced",
        projectId: project,
        from,
        to,
        groupId: id("grp"),
        landings: [],
        ...(height === undefined ? {} : { height }),
      } as { _tag: string }),
  };
}

export function describeProjectViewsContract(adapter: string, make: () => ProjectViewsHarness) {
  describe(`ProjectViews contract: ${adapter}`, () => {
    it.live(
      "[b12.change-list] lists a project's changes newest #n first, with state, goal and agent, and none of another project's",
      () => {
        const harness = make();
        const mine = projectEvents();
        const theirs = projectEvents();
        const [a, b, other] = [id("chg"), id("chg"), id("chg")];
        const agent = id("agt");
        return Effect.gen(function* () {
          for (const event of [
            mine.declared(a, agent, "Cache sessions"),
            theirs.declared(other, agent, "Another project's change"),
            mine.declared(b, agent, "Revoke tokens"),
            mine.started(a),
          ])
            yield* harness.arrive(event);
          const page = yield* (yield* ProjectViews).changes({ project: mine.project });

          expect(page.items).toMatchObject([
            { changeId: b, number: 2, state: "declared", goal: "Revoke tokens", agentId: agent },
            { changeId: a, number: 1, state: "working", goal: "Cache sessions", agentId: agent },
          ]);
          expect(page.nextCursor).toBeUndefined();
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live("[b12.change-list] pages by #n below the cursor, in one state when asked", () => {
      const harness = make();
      const events = projectEvents();
      const changes = [id("chg"), id("chg"), id("chg"), id("chg")];
      const agent = id("agt");
      return Effect.gen(function* () {
        for (const changeId of changes)
          yield* harness.arrive(events.declared(changeId, agent, "g"));
        yield* harness.arrive(events.started(changes[0] ?? ""));
        yield* harness.arrive(events.started(changes[2] ?? ""));
        const views = yield* ProjectViews;
        const first = yield* views.changes({ project: events.project, limit: 3 });
        const second = yield* views.changes({
          project: events.project,
          limit: 3,
          cursor: first.nextCursor,
        });
        const working = yield* views.changes({ project: events.project, state: "working" });

        expect(first.items.map((item) => item.number)).toEqual([4, 3, 2]);
        expect(first.nextCursor).toBe(2);
        expect(second.items.map((item) => item.number)).toEqual([1]);
        expect(second.nextCursor).toBeUndefined();
        expect(working.items.map((item) => item.number)).toEqual([3, 1]);
      }).pipe(Effect.provide(harness.layer));
    });

    it.live(
      "[b12.snapshot] answers the project's changes and trunk at a feed position, and a later one holds what arrived since",
      () => {
        const harness = make();
        const events = projectEvents();
        const change = id("chg");
        return Effect.gen(function* () {
          const views = yield* ProjectViews;
          const empty = yield* views.snapshot(events.project);
          yield* harness.arrive(events.declared(change, id("agt"), "g"));
          yield* harness.arrive(events.trunkInitialized(sha(10)));
          yield* harness.arrive(events.trunkAdvanced(sha(10), sha(11)));
          const before = yield* views.snapshot(events.project);
          yield* harness.arrive(events.withdrawn(change));
          yield* harness.arrive(events.trunkAdvanced(sha(11), sha(12), 7));
          const after = yield* views.snapshot(events.project);

          expect(empty.changes).toEqual([]);
          expect(empty.trunk).toBeUndefined();
          expect(before.cursor).toMatch(/^\d{12}$/);
          expect(before.changes.map((c) => c.state)).toEqual(["declared"]);
          expect(before.trunk).toEqual({ head: sha(11), height: 1 });
          expect(after.cursor > before.cursor).toBe(true);
          expect(after.changes.map((c) => c.state)).toEqual(["withdrawn"]);
          expect(after.trunk).toEqual({ head: sha(12), height: 7 });
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live(
      "[b23.conflict-views] folds a conflict from its own events: probing, each run and suite cell, the guard, proven, with the labels the feed gave",
      () => {
        const harness = make();
        const mine = projectEvents();
        const theirs = projectEvents();
        const [conflictId, probeId, guardId] = [id("cfl"), id("prb"), id("grd")];
        const [holder, other] = [id("chg"), id("chg")];
        const foreign = id("cfl");
        const counts = { passed: 41, failed: 1, skipped: 2 };
        return Effect.gen(function* () {
          const views = yield* ProjectViews;
          yield* harness.arrive(theirs.suspected(foreign, id("chg"), id("chg")));
          yield* harness.arrive(mine.suspected(conflictId, holder, other));
          const suspected = yield* views.conflict(mine.project, ConflictId.make(conflictId));
          yield* harness.arrive(mine.probeDrafted(conflictId, probeId));
          for (const run of [1, 2, 3])
            for (const [world, outcome] of DISCRIMINATING)
              yield* harness.arrive(mine.probeRan(conflictId, probeId, world, run, outcome));
          yield* harness.arrive(
            mine.worldCheckRan(conflictId, "AB", `suite:${holder}`, 1, "fail", counts),
          );
          yield* harness.arrive(mine.worldCheckRan(conflictId, "B", `suite:${holder}`, 1, "n/a"));
          yield* harness.arrive(mine.guardAdmitted(conflictId, probeId, guardId));
          yield* harness.arrive(mine.proven(conflictId, probeId));
          const record = yield* views.conflict(mine.project, ConflictId.make(conflictId));
          const page = yield* views.conflicts({ project: mine.project });
          const missing = [
            yield* Effect.flip(views.conflict(mine.project, ConflictId.make(foreign))),
            yield* Effect.flip(views.conflict(mine.project, ConflictId.make(id("cfl")))),
          ];

          expect(suspected).toMatchObject({
            number: 1,
            conflict: { state: "suspected", parties: [holder, other], predicate: "freshness" },
            runs: [],
            checks: [],
            labels: { conflict: "C-1" },
          });
          expect(suspected.probe).toBeUndefined();
          expect(record).toMatchObject({
            number: 1,
            conflict: {
              id: conflictId,
              state: "proven",
              probeId,
              premise: { holder },
              effect: { changeId: other },
            },
            probe: { id: probeId, state: "admitted", attempts: 2, guardId },
            guard: { id: guardId, probeId, runs: 3 },
            proven: { _tag: "probe", probeId },
            labels: { conflict: "C-1", probe: "P-1", guard: "G-1" },
          });
          expect(record.settledAt).toBeUndefined();
          expect(record.runs).toHaveLength(12);
          expect(record.runs.filter((run) => run.world === "AB")).toMatchObject([
            { run: 1, outcome: "fail", resultRef: "result:AB:1" },
            { run: 2, outcome: "fail", resultRef: "result:AB:2" },
            { run: 3, outcome: "fail", resultRef: "result:AB:3" },
          ]);
          expect(record.checks).toMatchObject([
            { world: "AB", check: `suite:${holder}`, run: 1, outcome: "fail", counts },
            { world: "B", check: `suite:${holder}`, run: 1, outcome: "n/a" },
          ]);
          expect(record.checks.map((check) => check.reason === undefined)).toEqual([true, false]);
          expect(page.items.map((item) => item.conflict.id)).toEqual([conflictId]);
          expect(page.totals).toEqual({ open: 1, settled: 0 });
          expect(missing.map((error) => error._tag)).toEqual([
            "ConflictNotFound",
            "ConflictNotFound",
          ]);
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live(
      "[b23.conflict-views] lists a project's conflicts newest C-n first, open or settled when asked, of one change when asked, with both totals on every page",
      () => {
        const harness = make();
        const events = projectEvents();
        const conflicts = [id("cfl"), id("cfl"), id("cfl"), id("cfl")];
        const [holder, other, third] = [id("chg"), id("chg"), id("chg")];
        return Effect.gen(function* () {
          const views = yield* ProjectViews;
          for (const [n, conflictId] of conflicts.entries())
            yield* harness.arrive(events.suspected(conflictId, holder, n === 3 ? third : other));
          yield* harness.arrive(events.dismissed(conflicts[1] ?? ""));
          const first = yield* views.conflicts({ project: events.project, limit: 3 });
          const second = yield* views.conflicts({
            project: events.project,
            limit: 3,
            cursor: first.nextCursor,
          });
          const open = yield* views.conflicts({ project: events.project, open: true });
          const settled = yield* views.conflicts({ project: events.project, open: false });
          const ofThird = yield* views.conflicts({
            project: events.project,
            changeId: ChangeId.make(third),
          });
          const dismissed = yield* views.conflicts({ project: events.project, state: "dismissed" });

          expect(first.items.map((item) => item.number)).toEqual([4, 3, 2]);
          expect(first.nextCursor).toBe(2);
          expect(second.items.map((item) => item.number)).toEqual([1]);
          expect(second.nextCursor).toBeUndefined();
          expect(open.items.map((item) => item.number)).toEqual([4, 3, 1]);
          expect(settled.items.map((item) => item.number)).toEqual([2]);
          expect(settled.items[0]?.dismissed).toBe("lattice:compatible");
          expect(settled.items[0]?.settledAt).toBeDefined();
          expect(dismissed.items.map((item) => item.number)).toEqual([2]);
          for (const page of [first, second, open, settled, dismissed])
            expect(page.totals).toEqual({ open: 3, settled: 1 });
          expect(ofThird.items.map((item) => item.number)).toEqual([4]);
          expect(ofThird.totals).toEqual({ open: 1, settled: 0 });
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live(
      "[b23.conflict-views] keeps what a party was told whichever arrives first, and leaves the view as it was for an event that cannot apply",
      () => {
        const harness = make();
        const events = projectEvents();
        const [conflictId, probeId, unseen] = [id("cfl"), id("prb"), id("cfl")];
        const [holder, other] = [id("chg"), id("chg")];
        return Effect.gen(function* () {
          const views = yield* ProjectViews;
          // The bounce reaches the Projector ahead of the conflict it cites: another object committed it.
          yield* harness.arrive(events.bounced(other, conflictId));
          yield* harness.arrive(events.bounced(holder, unseen));
          // A run with no conflict to belong to, and one for a probe never drafted.
          yield* harness.arrive(events.probeRan(unseen, id("prb"), "AB", 1, "fail"));
          yield* harness.arrive(events.suspected(conflictId, holder, other));
          yield* harness.arrive(events.probeRan(conflictId, probeId, "AB", 1, "fail"));
          const record = yield* views.conflict(events.project, ConflictId.make(conflictId));
          const page = yield* views.conflicts({ project: events.project });

          expect(record.told).toMatchObject([
            { changeId: other, how: "bounced", nextActions: [{ kind: "read" }] },
          ]);
          expect(record.conflict.state).toBe("suspected");
          expect(record.runs).toEqual([]);
          expect(page.items.map((item) => item.conflict.id)).toEqual([conflictId]);
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live(
      "[b23.probe-conflict] answers the conflict a probe belongs to, with the bundle its draft was kept under, in the probe's own project only",
      () => {
        const harness = make();
        const mine = projectEvents();
        const theirs = projectEvents();
        const [conflictId, probeId] = [id("cfl"), ProbeId.make(id("prb"))];
        const [failed, undrafted] = [id("cfl"), ProbeId.make(id("prb"))];
        const unknown = ProbeId.make(id("prb"));
        return Effect.gen(function* () {
          const views = yield* ProjectViews;
          yield* harness.arrive(theirs.suspected(id("cfl"), id("chg"), id("chg")));
          yield* harness.arrive(mine.suspected(conflictId, id("chg"), id("chg")));
          yield* harness.arrive(mine.probeDrafted(conflictId, probeId));
          yield* harness.arrive(mine.suspected(failed, id("chg"), id("chg")));
          yield* harness.arrive(mine.probeDraftFailed(failed, undrafted));

          const drafted = yield* views.probeConflict(mine.project, probeId);
          expect([
            drafted.conflict.id,
            drafted.labels.conflict,
            drafted.probe?.id,
            drafted.probe?.bundleHash,
          ]).toEqual([conflictId, "C-1", probeId, BUNDLE]);
          expect(drafted).toEqual(yield* views.conflict(mine.project, ConflictId.make(conflictId)));
          // A probe that began discarded is found too, and names no bundle.
          const discarded = yield* views.probeConflict(mine.project, undrafted);
          expect([
            discarded.conflict.id,
            discarded.probe?.id,
            discarded.probe?.state,
            discarded.probe?.bundleHash,
          ]).toEqual([failed, undrafted, "discarded", undefined]);
          // Another project's feed has no such probe, and nor has this one for an id it never saw.
          expect(yield* Effect.flip(views.probeConflict(theirs.project, probeId))).toMatchObject({
            _tag: "ProbeNotFound",
            probeId,
          });
          expect(yield* Effect.flip(views.probeConflict(mine.project, unknown))).toMatchObject({
            _tag: "ProbeNotFound",
            probeId: unknown,
          });
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live(
      "[b12.change-view-tolerant] leaves the views as they were for a change event that cannot apply",
      () => {
        const harness = make();
        const events = projectEvents();
        const [undeclared, change] = [id("chg"), id("chg")];
        return Effect.gen(function* () {
          yield* harness.arrive(events.started(undeclared));
          yield* harness.arrive(events.declared(change, id("agt"), "g"));
          yield* harness.arrive(events.withdrawn(change));
          // Withdrawn is terminal: a start after it is illegal.
          yield* harness.arrive(events.started(change));
          const page = yield* (yield* ProjectViews).changes({ project: events.project });

          expect(page.items.map((item) => [item.changeId, item.state])).toEqual([
            [change, "withdrawn"],
          ]);
        }).pipe(Effect.provide(harness.layer));
      },
    );
  });
}
