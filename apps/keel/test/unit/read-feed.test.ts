import { describe, expect, it } from "@effect/vitest";
import { type FeedScope, readEvents } from "@keeltown/core/application/coordination";
import type { Audience } from "@keeltown/core/domain/identity";
import { EventEnvelope, makeId, type ProjectId } from "@keeltown/core/kernel";
import { makeEventFeedMemory, ulidOf } from "@keeltown/testing";
import { Effect, Schema } from "effect";

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
      }).pipe(Effect.provide(memory.layer));
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
      }).pipe(Effect.provide(memory.layer));
    },
  );
});
