import { describe, expect, it } from "@effect/vitest";
import { IssueId, ProjectId, UserId, AgentId } from "@keeltown/core/kernel";
import { IssueNumbers, Issues } from "@keeltown/core/ports";
import { Effect, type Layer, Schema } from "effect";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ulid = () =>
  [...crypto.getRandomValues(new Uint8Array(26))].map((b) => CROCKFORD[b % 32] ?? "0").join("");
const aProject = () => Schema.decodeUnknownSync(ProjectId)(`prj_${ulid()}`);
const anIssue = () => Schema.decodeUnknownSync(IssueId)(`iss_${ulid()}`);
const ann = () => `user:${Schema.decodeUnknownSync(UserId)(`usr_${ulid()}`)}` as const;
const bot = () => `agent:${Schema.decodeUnknownSync(AgentId)(`agt_${ulid()}`)}` as const;
const key = () => `issue-${crypto.randomUUID()}`;

/**
 * The contract every `Issues` adapter keeps: numbers from the project's
 * sequence, a key replayed with its body answering what it did and another
 * body refused, moves that repeat committing nothing, comments in order, pages
 * newest first, and each project's issues its own.
 */
export function describeIssuesContract(adapter: string, make: () => Layer.Layer<Issues>) {
  const issues = () =>
    Effect.gen(function* () {
      return yield* Issues;
    }).pipe(Effect.provide(make()));

  describe(`Issues contract: ${adapter}`, () => {
    it.live(
      "[issues.contract] opens with the project's next #n, answers a replayed key again with no second number, and refuses its key with another body",
      () =>
        Effect.gen(function* () {
          const port = yield* issues();
          const [projectId, author] = [aProject(), ann()];
          const first = { projectId, title: "Sign-in loops", body: "Steps…", author };
          const k = key();
          const opened = yield* port.open({ ...first, idempotencyKey: k });
          expect(opened).toMatchObject({ number: 1, state: "open", author, comments: 0 });
          expect(yield* port.open({ ...first, idempotencyKey: k })).toEqual(opened);
          const refused = yield* Effect.flip(
            port.open({ ...first, title: "Something else", idempotencyKey: k }),
          );
          expect(refused._tag).toBe("IdempotencyConflict");
          const second = yield* port.open({ ...first, idempotencyKey: key() });
          expect(second.number).toBe(2);
          expect(second.issueId).not.toBe(opened.issueId);
        }),
    );

    it.live(
      "[issues.contract] takes comments in order, closes and reopens once each, and an issue the project has not got is IssueNotFound",
      () =>
        Effect.gen(function* () {
          const port = yield* issues();
          const [projectId, author, other] = [aProject(), ann(), bot()];
          const { number } = yield* port.open({
            projectId,
            title: "A request",
            body: "",
            author,
            idempotencyKey: key(),
          });
          yield* port.comment({
            projectId,
            number,
            body: "first",
            author: other,
            idempotencyKey: key(),
          });
          yield* port.comment({ projectId, number, body: "second", author, idempotencyKey: key() });
          const close = { projectId, number, reason: "not-planned" as const, by: other };
          const closed = yield* port.close({ ...close, idempotencyKey: key() });
          expect(closed).toMatchObject({
            state: "closed",
            closedReason: "not-planned",
            closedBy: other,
          });
          expect(
            yield* port.close({ ...close, reason: "completed", idempotencyKey: key() }),
          ).toEqual(closed);
          const reopened = yield* port.reopen({
            projectId,
            number,
            by: author,
            idempotencyKey: key(),
          });
          expect(reopened.state).toBe("open");
          expect(reopened).not.toHaveProperty("closedReason");

          const thread = yield* port.get(projectId, number);
          expect(thread.issue).toEqual(reopened);
          expect(thread.comments.map((c) => [c.body, c.author])).toEqual([
            ["first", other],
            ["second", author],
          ]);
          expect(thread.issue.comments).toBe(2);

          const missing = yield* Effect.flip(port.get(projectId, number + 1));
          expect(missing).toMatchObject({ _tag: "IssueNotFound", projectId, number: number + 1 });
          const missed = yield* Effect.flip(
            port.comment({ projectId, number: 99, body: "x", author, idempotencyKey: key() }),
          );
          expect(missed._tag).toBe("IssueNotFound");
        }),
    );

    it.live(
      "[issues.contract] lists newest first in either state with both totals, a page at a time, and another project's issues are not there",
      () =>
        Effect.gen(function* () {
          const port = yield* issues();
          const [projectId, elsewhere, author] = [aProject(), aProject(), ann()];
          for (const title of ["one", "two", "three", "four"])
            yield* port.open({ projectId, title, body: "", author, idempotencyKey: key() });
          yield* port.open({
            projectId: elsewhere,
            title: "theirs",
            body: "",
            author,
            idempotencyKey: key(),
          });
          yield* port.close({
            projectId,
            number: 2,
            reason: "completed",
            by: author,
            idempotencyKey: key(),
          });

          const page = yield* port.list({ projectId, limit: 2 });
          expect(page.items.map((i) => i.title)).toEqual(["four", "three"]);
          expect(page).toMatchObject({ next: 3, open: 3, closed: 1 });
          const rest = yield* port.list({ projectId, limit: 2, before: page.next });
          expect(rest.items.map((i) => i.title)).toEqual(["two", "one"]);
          expect(rest).not.toHaveProperty("next");
          const open = yield* port.list({ projectId, limit: 10, state: "open" });
          expect(open.items.map((i) => i.number)).toEqual([4, 3, 1]);
          const closed = yield* port.list({ projectId, limit: 10, state: "closed" });
          expect(closed.items.map((i) => i.number)).toEqual([2]);
          const theirs = yield* port.list({ projectId: elsewhere, limit: 10 });
          expect(theirs.items.map((i) => [i.title, i.number])).toEqual([["theirs", 1]]);
        }),
    );
  });
}

/** The contract every `IssueNumbers` adapter keeps: one sequence a project, each issue given its number once. */
export function describeIssueNumbersContract(
  adapter: string,
  make: () => Layer.Layer<IssueNumbers>,
) {
  describe(`IssueNumbers contract: ${adapter}`, () => {
    it.live(
      "[issue-numbers.contract] gives each issue the project's next number once, asked again answers the same, and each project counts on its own",
      () =>
        Effect.gen(function* () {
          const numbers = yield* Effect.gen(function* () {
            return yield* IssueNumbers;
          }).pipe(Effect.provide(make()));
          const [here, there, a, b] = [aProject(), aProject(), anIssue(), anIssue()];
          expect(yield* numbers.give(here, a)).toBe(1);
          expect(yield* numbers.give(here, b)).toBe(2);
          expect(yield* numbers.give(here, a)).toBe(1);
          expect(yield* numbers.give(there, b)).toBe(1);
        }),
    );
  });
}
