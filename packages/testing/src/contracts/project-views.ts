import { describe, expect, it } from "@effect/vitest";
import { EventEnvelope, ProjectId } from "@keeltown/core/kernel";
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
  return {
    project: ProjectId.make(project),
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
    withdrawn: (changeId: string) =>
      envelope(changeRef(changeId), {
        _tag: "ChangeWithdrawn",
        changeId,
        by: "contract",
      } as { _tag: string }),
    trunkInitialized: (head: string) =>
      envelope({ kind: "trunk", id: project }, {
        _tag: "TrunkInitialized",
        projectId: project,
        head,
        by: "contract",
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
