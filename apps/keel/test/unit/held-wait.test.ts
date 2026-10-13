import { describe, expect, it } from "@effect/vitest";
import {
  HOLD_SECONDS,
  MAX_HOLDS,
  MAX_WAIT_SECONDS,
  readEvents,
  readInbox,
  submissionOf,
} from "@keeltown/core/application/coordination";
import type { AgentNotice, AgentToken, InboxPage } from "@keeltown/core/domain/identity";
import {
  AgentId,
  CommitSha,
  EventEnvelope,
  Instant,
  makeId,
  ProjectId,
} from "@keeltown/core/kernel";
import {
  Changes,
  EventFeed,
  type EventFeedPage,
  type EventFeedRead,
  Inbox,
  type SubmissionStatus,
} from "@keeltown/core/ports";
import { makeChangesMemory, makeManualClock, ulidOf } from "@keeltown/testing";
import { Effect, Exit, Layer, Schema } from "effect";

const projectId = Schema.decodeUnknownSync(ProjectId)("prj_01JZ8PT2C4E6G8J0M2N4Q6S8V0");
const token: AgentToken = {
  agentId: Schema.decodeUnknownSync(AgentId)("agt_01JZ8PT2C4E6G8J0M2N4Q6S8V0"),
  projectId,
  scopes: ["agent:read", "agent:work"],
  revocationEpoch: 0,
};

const notice = (n: number): AgentNotice => ({
  id: `evt-${n}`,
  at: Instant(1_760_000_000_000 + n),
  kind: "ChangeBounced",
  title: `notice ${n}`,
});

/**
 * An inbox whose holds are scripted: each read is recorded, moves the clock
 * on by the seconds it was asked to hold when it has nothing to answer, and
 * answers the next page of `script` (an empty page from the cursor asked for
 * once the script runs out).
 */
function scriptedInbox(script: readonly InboxPage[] = []) {
  const clock = makeManualClock();
  const holds: { cursor: string | undefined; seconds: number }[] = [];
  const layer = Layer.succeed(
    Inbox,
    Inbox.of({
      read: (_agentId, cursor, seconds) =>
        Effect.sync(() => {
          const page = script[holds.length] ?? { notices: [], cursor: cursor ?? "0" };
          holds.push({ cursor, seconds });
          if (page.notices.length === 0) clock.advance(seconds * 1000);
          return page;
        }),
    }),
  );
  return { holds, clock, layer: Layer.merge(layer, clock.layer) };
}

describe("a wait longer than one object's hold", () => {
  it.effect(
    "[wait.holds] a wait of 70 seconds is holds of 30, 30 and 10, and then the answer as it stands",
    () => {
      const inbox = scriptedInbox();
      return Effect.gen(function* () {
        const page = yield* readInbox(token, "7", 70);
        expect(inbox.holds.map((hold) => hold.seconds)).toEqual([30, 30, 10]);
        expect(page).toEqual({ notices: [], cursor: "7" });
      }).pipe(Effect.provide(inbox.layer));
    },
  );

  it.effect("[wait.answers] it answers the moment a hold has something, and holds no more", () => {
    const arrived = { notices: [notice(8)], cursor: "8" };
    const inbox = scriptedInbox([{ notices: [], cursor: "7" }, arrived]);
    return Effect.gen(function* () {
      const page = yield* readInbox(token, "7", 70);
      expect(page).toEqual(arrived);
      expect(inbox.holds.map((hold) => hold.seconds)).toEqual([30, 30]);
    }).pipe(Effect.provide(inbox.layer));
  });

  it.effect(
    "[wait.cursor] each hold reads on from the cursor the one before answered, so `end` is sent once",
    () => {
      const inbox = scriptedInbox([
        { notices: [], cursor: "000000000007" },
        { notices: [], cursor: "000000000007" },
        { notices: [notice(8)], cursor: "000000000008" },
      ]);
      return Effect.gen(function* () {
        const page = yield* readInbox(token, "end", 900);
        expect(inbox.holds.map((hold) => hold.cursor)).toEqual([
          "end",
          "000000000007",
          "000000000007",
        ]);
        expect(page.cursor).toBe("000000000008");
      }).pipe(Effect.provide(inbox.layer));
    },
  );

  it.effect(
    "[wait.bounds] a wait is at most 900 seconds and at least none, and no wait is one read",
    () => {
      const most = scriptedInbox();
      const none = scriptedInbox();
      const below = scriptedInbox();
      return Effect.gen(function* () {
        yield* readInbox(token, undefined, 100_000).pipe(Effect.provide(most.layer));
        expect(most.holds).toHaveLength(MAX_WAIT_SECONDS / HOLD_SECONDS);
        expect(most.holds.reduce((sum, hold) => sum + hold.seconds, 0)).toBe(900);
        yield* readInbox(token, undefined).pipe(Effect.provide(none.layer));
        expect(none.holds).toEqual([{ cursor: undefined, seconds: 0 }]);
        yield* readInbox(token, undefined, -5).pipe(Effect.provide(below.layer));
        expect(below.holds).toEqual([{ cursor: undefined, seconds: 0 }]);
      });
    },
  );

  it.effect(
    "[wait.budget] holds that end before their time with nothing are counted: a wait makes 60 at most, and then answers as it stands",
    () => {
      // An object that restarts under every hold: each is answered at once, empty, and no time passes.
      const holds: number[] = [];
      const going = Layer.succeed(
        Inbox,
        Inbox.of({
          read: (_agentId, cursor, seconds) =>
            Effect.sync(() => {
              holds.push(seconds);
              return { notices: [], cursor: cursor ?? "0" };
            }),
        }),
      );
      return Effect.gen(function* () {
        const page = yield* readInbox(token, "7", 900);
        expect(holds).toHaveLength(MAX_HOLDS);
        expect(MAX_HOLDS).toBe(60);
        expect(page).toEqual({ notices: [], cursor: "7" });
      }).pipe(Effect.provide(Layer.merge(going, makeManualClock().layer)));
    },
  );

  it("[wait.abort] a caller that goes ends the wait: no hold is asked for after it", async () => {
    const gone = new AbortController();
    const inbox = scriptedInbox();
    // Each hold is a call that comes back later, as an object's does; the caller goes under the second.
    const layer = Layer.merge(
      Layer.effect(
        Inbox,
        Effect.map(Inbox, (held) =>
          Inbox.of({
            read: (...asked) =>
              Effect.promise(() => Promise.resolve()).pipe(
                Effect.andThen(held.read(...asked)),
                Effect.tap(() =>
                  inbox.holds.length === 2 ? Effect.sync(() => gone.abort()) : Effect.void,
                ),
              ),
          }),
        ),
      ).pipe(Layer.provide(inbox.layer)),
      inbox.clock.layer,
    );
    const exit = await Effect.runPromiseExit(
      readInbox(token, undefined, 900).pipe(Effect.provide(layer)),
      { signal: gone.signal },
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(inbox.holds).toHaveLength(2);
  });
});

/** An event of `type` on the project: only its type matters to who is shown it. */
const event = (seq: number, type: string) =>
  Schema.decodeUnknownSync(EventEnvelope)({
    eventId: makeId("evt", ulidOf(seq)),
    type,
    entity: { kind: "change", id: makeId("chg", ulidOf(seq)) },
    seq,
    at: 1_760_000_000_000 + seq,
    dedupeKey: `change/cause-${seq}`,
    project: projectId,
    affected: [],
    notified: [],
    payload: { _tag: type },
  });

describe("a held read of the feed", () => {
  it.effect(
    "[wait.feed] a page whose events the reader is not shown is not an answer, and the wait holds on from its cursor",
    () => {
      const clock = makeManualClock();
      const asked: EventFeedRead[] = [];
      // A members' event the public is not shown, then nothing, then a public one.
      const script: readonly EventFeedPage[] = [
        { events: [event(1, "AgentEnrolled")], cursor: "000000000001" },
        { events: [], cursor: "000000000001" },
        { events: [event(2, "ChangeStarted")], cursor: "000000000002" },
      ];
      const feed = Layer.succeed(
        EventFeed,
        EventFeed.of({
          read: (request) =>
            Effect.sync(() => {
              const page = script[asked.length] ?? { events: [], cursor: request.cursor ?? "0" };
              asked.push(request);
              if (page.events.length === 0) clock.advance(request.waitSeconds * 1000);
              return page;
            }),
        }),
      );
      return Effect.gen(function* () {
        const page = yield* readEvents(
          { _tag: "Project", project: projectId, audience: "public" },
          { cursor: "end", waitSeconds: 90, limit: 20 },
        );
        expect(
          asked.map((request) => [request.cursor, request.waitSeconds, request.limit]),
        ).toEqual([
          ["end", 30, 20],
          ["000000000001", 30, 20],
          ["000000000001", 30, 20],
        ]);
        expect(page.events.map((each) => each.type)).toEqual(["ChangeStarted"]);
        expect(page.cursor).toBe("000000000002");
      }).pipe(Effect.provide(Layer.merge(feed, clock.layer)));
    },
  );
});

/** A submission as it stands once its commit moved. */
const moved = (status: SubmissionStatus): SubmissionStatus => ({
  ...status,
  commitSha: Schema.decodeUnknownSync(CommitSha)("a".repeat(40)),
});

/** The in-memory Changes with one declared change, whose holds are recorded and move at the `moves`th. */
function submission(moves: number) {
  const memory = makeChangesMemory();
  const clock = makeManualClock();
  const holds: number[] = [];
  const layer = Layer.effect(
    Changes,
    Effect.map(Changes, (changes) =>
      Changes.of({
        ...changes,
        awaitSubmission: (changeId, seconds) =>
          Effect.map(changes.awaitSubmission(changeId, 0), (status) => {
            holds.push(seconds);
            if (holds.length === moves) return moved(status);
            clock.advance(seconds * 1000);
            return status;
          }),
      }),
    ),
  ).pipe(Layer.provide(memory.layer));
  const declared = Changes.use((changes) =>
    changes.declare(token, {
      goal: "Cache permission lookups per request",
      footprint: [],
      premises: [],
      idempotencyKey: `declare-${crypto.randomUUID()}`,
    }),
  );
  return { holds, declared, layer: Layer.merge(layer, clock.layer) };
}

describe("a held read of a submission", () => {
  it.effect(
    "[wait.submission] a long wait reads the submission first and answers when a hold differs from it",
    () => {
      const { holds, declared, layer } = submission(3);
      return Effect.gen(function* () {
        const { change } = yield* declared;
        const status = yield* submissionOf(change.id, 70);
        expect(holds).toEqual([0, 30, 30]);
        expect(status.commitSha).toBe("a".repeat(40));
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "[wait.submission-short] a wait one hold can keep is the object's own answer: one call",
    () => {
      const { holds, declared, layer } = submission(0);
      return Effect.gen(function* () {
        const { change } = yield* declared;
        yield* submissionOf(change.id, 30);
        yield* submissionOf(change.id);
        expect(holds).toEqual([30, 0]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "[wait.submission-deadline] a submission that never moves is answered as it stands when the wait runs out",
    () => {
      const { holds, declared, layer } = submission(0);
      return Effect.gen(function* () {
        const { change } = yield* declared;
        const status = yield* submissionOf(change.id, 70);
        expect(holds).toEqual([0, 30, 30, 10]);
        expect(status.commitSha).toBeNull();
      }).pipe(Effect.provide(layer));
    },
  );
});
