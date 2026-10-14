import { describe, expect, it } from "@effect/vitest";
import { type FeedScope, readEvents } from "@keeltown/core/application/coordination";
import {
  type Audience,
  authorize,
  type Principal,
  type ProjectResource,
} from "@keeltown/core/domain/identity";
import { EventEnvelope, makeId, type ProjectId } from "@keeltown/core/kernel";
import { makeEventFeedMemory, makeManualClock, ulidOf } from "@keeltown/testing";
import { Effect, Layer, Result, Schema } from "effect";

const MEMBERS_OF = makeId("prj", ulidOf(1));
const PUBLIC = makeId("prj", ulidOf(2));
const UNREADABLE = makeId("prj", ulidOf(3));

/** An event of `type` on `project` (none when absent): only its type and project matter to a read. */
const event = (seq: number, type: string, project?: ProjectId) =>
  Schema.decodeUnknownSync(EventEnvelope)({
    eventId: makeId("evt", ulidOf(seq)),
    type,
    entity: { kind: "change", id: makeId("chg", ulidOf(seq)) },
    seq,
    at: 1_760_000_000_000 + seq,
    dedupeKey: `change/cause-${seq}`,
    ...(project === undefined ? {} : { project }),
    affected: [],
    notified: [],
    payload: { _tag: type },
  });

/** A members-only and a public event on each project, and one event no project owns. */
function feed() {
  const memory = makeEventFeedMemory();
  let seq = 0;
  for (const project of [MEMBERS_OF, PUBLIC, UNREADABLE]) {
    memory.append(event((seq += 1), "AgentEnrolled", project));
    memory.append(event((seq += 1), "ChangeStarted", project));
  }
  memory.append(event((seq += 1), "UserSignedUp"));
  return memory;
}

const seen = (page: { readonly events: readonly EventEnvelope[] }) =>
  page.events.map((e) => [e.project, e.type]);

/** A project of an org no reader here belongs to. */
const projectOf = (projectId: ProjectId, visibility: "public" | "private"): ProjectResource => ({
  _tag: "Project",
  namespace: makeId("org", ulidOf(9)),
  projectId,
  visibility,
  namespaceSuspended: false,
  personOwned: false,
});

/** How `principal` reads `project`'s events, as the doorway decides it: undefined where it is refused. */
const audienceFor = (principal: Principal, project: ProjectResource): Audience | undefined => {
  const decision = authorize(principal, "Inbox_listEvents", project);
  return Result.isSuccess(decision) ? (decision.success.audience ?? "public") : undefined;
};

describe("readEvents", () => {
  it.effect(
    "[feed.project] one project's read keeps its events alone, and only the public ones for a public reader",
    () => {
      const memory = feed();
      return Effect.gen(function* () {
        const asMember = yield* readEvents(
          { _tag: "Project", project: MEMBERS_OF, audience: "members" },
          {},
        );
        expect(seen(asMember)).toEqual([
          [MEMBERS_OF, "AgentEnrolled"],
          [MEMBERS_OF, "ChangeStarted"],
        ]);
        const asPublic = yield* readEvents(
          { _tag: "Project", project: PUBLIC, audience: "public" },
          {},
        );
        expect(seen(asPublic)).toEqual([[PUBLIC, "ChangeStarted"]]);
        expect(asPublic.cursor).toBe(asMember.cursor);
      }).pipe(Effect.provide(Layer.merge(memory.layer, makeManualClock().layer)));
    },
  );

  it.effect(
    "[feed.readable] a read naming no project keeps each readable project's events as its reader sees that project, asking once per project, and drops the rest",
    () => {
      const memory = feed();
      const asked: ProjectId[] = [];
      const audiences = new Map<ProjectId, Audience>([
        [MEMBERS_OF, "members"],
        [PUBLIC, "public"],
      ]);
      const scope: FeedScope = {
        _tag: "Readable",
        audienceOf: (project) =>
          Effect.sync(() => {
            asked.push(project);
            return audiences.get(project);
          }),
      };
      return Effect.gen(function* () {
        const page = yield* readEvents(scope, { limit: 100 });
        expect(seen(page)).toEqual([
          [MEMBERS_OF, "AgentEnrolled"],
          [MEMBERS_OF, "ChangeStarted"],
          [PUBLIC, "ChangeStarted"],
        ]);
        expect(asked.toSorted()).toEqual([MEMBERS_OF, PUBLIC, UNREADABLE].toSorted());
        expect(page.cursor).toBe("000000000007");
      }).pipe(Effect.provide(Layer.merge(memory.layer, makeManualClock().layer)));
    },
  );

  it.effect(
    "[feed.preview-public] a preview's notice reads to anyone on a public project, as a code host shows its deployments, and to no one outside a private one",
    () => {
      const memory = makeEventFeedMemory();
      const projects = [projectOf(PUBLIC, "public"), projectOf(UNREADABLE, "private")];
      let seq = 0;
      for (const { projectId } of projects) {
        memory.append(event((seq += 1), "PreviewDeployed", projectId));
        // The target's record names the account and its credential: members only, beside it.
        memory.append(event((seq += 1), "DeployTargetSet", projectId));
      }
      const visitor: Principal = { _tag: "Anonymous" };
      const outsider: Principal = {
        _tag: "User",
        userId: makeId("usr", ulidOf(8)),
        handle: "ada",
        suspended: false,
        memberships: [],
      };
      const readAs = (principal: Principal) =>
        Effect.forEach(projects, (project) => {
          const audience = audienceFor(principal, project);
          return audience === undefined
            ? Effect.succeed([])
            : Effect.map(
                readEvents({ _tag: "Project", project: project.projectId, audience }, {}),
                seen,
              );
        }).pipe(Effect.map((pages) => pages.flat()));
      const across: FeedScope = {
        _tag: "Readable",
        audienceOf: (id) =>
          Effect.sync(() => {
            const project = projects.find((p) => p.projectId === id);
            return project === undefined ? undefined : audienceFor(outsider, project);
          }),
      };
      return Effect.gen(function* () {
        expect(projects.map((project) => audienceFor(visitor, project))).toEqual([
          "public",
          undefined,
        ]);
        expect(yield* readAs(visitor)).toEqual([[PUBLIC, "PreviewDeployed"]]);
        expect(yield* readAs(outsider)).toEqual([[PUBLIC, "PreviewDeployed"]]);
        expect(seen(yield* readEvents(across, { limit: 100 }))).toEqual([
          [PUBLIC, "PreviewDeployed"],
        ]);
      }).pipe(Effect.provide(Layer.merge(memory.layer, makeManualClock().layer)));
    },
  );
});
