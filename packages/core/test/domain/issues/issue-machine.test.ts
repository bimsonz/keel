import { describe, expect, it } from "vitest";
import {
  closingNumbers,
  decideIssue,
  evolveIssue,
  type Issue,
  type IssueCommand,
  type IssueFacts,
  type IssuesEvent,
} from "../../../src/domain/issues/index.ts";
import {
  agentActor,
  type CommandActor,
  type CommentId,
  IllegalTransition,
  Instant,
  makeId,
  userActor,
} from "../../../src/domain/kernel/index.ts";
import { fc } from "../../support/fast-check.ts";

const ulid = (n: number): string => String(n).padStart(26, "0");
const FACTS: IssueFacts = {
  projectId: makeId("prj", ulid(1)),
  issueId: makeId("iss", ulid(2)),
  number: 7,
};
const ANN: CommandActor = userActor(makeId("usr", ulid(3)));
const BOT: CommandActor = agentActor(makeId("agt", ulid(4)));
const CHANGE = makeId("chg", ulid(5));
const comment = (n: number): CommentId => makeId("cmt", ulid(100 + n));

/** Decides each command in turn and folds what it decided, as a commit does. */
const play = (commands: readonly IssueCommand[], from = 1000) => {
  let issue: Issue | undefined;
  const events: IssuesEvent[] = [];
  commands.forEach((command, i) => {
    for (const payload of decideIssue(issue, command, FACTS)) {
      issue = evolveIssue(issue, { at: Instant(from + i), payload });
      events.push(payload);
    }
  });
  return { issue, events };
};

const OPEN: IssueCommand = { _tag: "Open", title: "Sign-in loops", body: "Steps…", author: ANN };

describe("[issue.machine] an issue's life", () => {
  it("[issue.machine] opens once, takes comments open or closed, closes and reopens, and repeats commit nothing", () => {
    const { issue, events } = play([
      OPEN,
      OPEN,
      { _tag: "Comment", commentId: comment(1), body: "Seen too", author: BOT },
      { _tag: "Close", reason: "not-planned", by: ANN },
      { _tag: "Close", reason: "completed", by: BOT },
      { _tag: "Comment", commentId: comment(2), body: "Still seen", author: BOT },
      { _tag: "Reopen", by: BOT },
      { _tag: "Reopen", by: ANN },
    ]);
    expect(events.map((e) => e._tag)).toEqual([
      "IssueOpened",
      "IssueCommented",
      "IssueClosed",
      "IssueCommented",
      "IssueReopened",
    ]);
    expect(issue).toMatchObject({ state: "open", comments: 2, author: ANN, number: 7 });
    expect(issue).not.toHaveProperty("closedReason");
    expect(issue).not.toHaveProperty("closedBy");
    expect(issue?.updatedAt).toBe(Instant(1006));
  });

  it("[issue.machine] a change that named the issue closes it as completed, naming the change and no person", () => {
    const { issue, events } = play([OPEN, { _tag: "CloseByChange", changeId: CHANGE }]);
    expect(events.at(-1)).toMatchObject({
      _tag: "IssueClosed",
      reason: "completed",
      byChange: CHANGE,
    });
    expect(events.at(-1)).not.toHaveProperty("by");
    expect(issue).toMatchObject({
      state: "closed",
      closedReason: "completed",
      closedByChange: CHANGE,
    });
    expect(issue).not.toHaveProperty("closedBy");
    // Closed already, a second change that names it closes nothing.
    expect(decideIssue(issue, { _tag: "CloseByChange", changeId: CHANGE }, FACTS)).toEqual([]);
  });

  it("[issue.machine] a command on an issue never opened, or on another issue's record, is the caller's mistake", () => {
    expect(() => decideIssue(undefined, { _tag: "Reopen", by: ANN }, FACTS)).toThrow(
      IllegalTransition,
    );
    const { issue } = play([OPEN]);
    const other = { ...FACTS, issueId: makeId("iss", ulid(9)) };
    expect(() => decideIssue(issue, { _tag: "Reopen", by: ANN }, other)).toThrow(IllegalTransition);
    const [opened] = decideIssue(undefined, OPEN, FACTS);
    if (opened === undefined) throw new Error("nothing opened");
    expect(() => evolveIssue(issue, { at: Instant(2), payload: opened })).toThrow(
      IllegalTransition,
    );
  });
});

const commandArb: fc.Arbitrary<IssueCommand> = fc.oneof(
  fc.constant(OPEN),
  fc.nat(50).map((n): IssueCommand => ({
    _tag: "Comment",
    commentId: comment(n),
    body: "a comment",
    author: n % 2 === 0 ? ANN : BOT,
  })),
  fc
    .constantFrom("completed" as const, "not-planned" as const, "duplicate" as const)
    .map((reason): IssueCommand => ({ _tag: "Close", reason, by: ANN })),
  fc.constant<IssueCommand>({ _tag: "CloseByChange", changeId: CHANGE }),
  fc.constant<IssueCommand>({ _tag: "Reopen", by: BOT }),
);

describe("[issue.fold] what any run of commands leaves", () => {
  it("[issue.fold] after it is opened, every run folds; its state is the last close or reopen, and it counts every comment", () => {
    fc.assert(
      fc.property(fc.array(commandArb, { maxLength: 30 }), (rest) => {
        const { issue, events } = play([OPEN, ...rest]);
        const last = rest.findLast((c) => c._tag !== "Comment" && c._tag !== "Open");
        const closed = last !== undefined && last._tag !== "Reopen";
        expect(issue?.comments).toBe(rest.filter((c) => c._tag === "Comment").length);
        expect(issue?.state).toBe(closed ? "closed" : "open");
        expect(issue?.closedReason !== undefined).toBe(closed);
        expect(events.filter((e) => e._tag === "IssueOpened")).toHaveLength(1);
        // Every close or reopen that changed the state was one event; repeats were none.
        const moves = events.flatMap((e) =>
          e._tag === "IssueClosed" || e._tag === "IssueReopened" ? [e._tag] : [],
        );
        expect(moves.filter((tag, i) => i > 0 && tag === moves[i - 1])).toEqual([]);
      }),
    );
  });
});

describe("[issue.closing] which issues a change's goal closes", () => {
  it("[issue.closing] GitHub's nine keywords in any case, with or without a colon, each issue once in order", () => {
    expect(
      closingNumbers(
        "Fixes #12, closes #3 and Resolved: #45. Also FIXED #12, close #7, fix #8, resolves #9",
      ),
    ).toEqual([12, 3, 45, 7, 8, 9]);
    expect(closingNumbers("Closed #1; resolve #2; fixes:  #3")).toEqual([1, 2, 3]);
  });

  it("[issue.closing] a number with no keyword before it, inside a word, after another repository, or #0 closes nothing", () => {
    expect(
      closingNumbers(
        "See #12. prefixes #4, unfixes #5, fixes-up #6, fixes owner/repo#7, fixes #8x, fixes #0, fixes#9",
      ),
    ).toEqual([]);
    expect(closingNumbers("")).toEqual([]);
  });
});
