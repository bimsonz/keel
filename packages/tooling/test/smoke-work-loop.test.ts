import { describe, expect, it } from "vitest";
import { samePageSoFar, sameSubmission } from "../../../e2e/src/smoke/work-loop.ts";

const CHANGE = "chg_01M4S2MJTNG88WTBB0JSDHKCKJ";
const COMMIT = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const started = { type: "PrecheckStarted", changeId: CHANGE };

/** A submit's answer: the envelope around the submission as it stood when asked. */
const submission = (over: object = {}, envelope: object = {}) => ({
  ok: true,
  summary: "Submitted.",
  result: { changeId: CHANGE, revision: 1, commitSha: COMMIT, state: "submitted", ...over },
  findings: [],
  next: [],
  notices: [],
  ...envelope,
});

/** An inbox read's answer: a page of notices and where it ends. */
const page = (notices: readonly object[], cursor: string) => ({
  ok: true,
  summary: "",
  result: { notices, cursor },
  findings: [],
  next: [],
  notices: [],
});
const notice = (n: number) => ({ type: "ChangeDeclared", seq: n });

describe("the work-loop smoke's paired reads", () => {
  it("[smoke.submit-replay] a replay under the same key is the same submission, wherever the Precheck has taken it since", () => {
    const replayed = submission(
      { state: "deriving" },
      { summary: "Deriving.", next: [{ title: "Wait" }], notices: [started] },
    );
    expect(sameSubmission(submission(), replayed)).toBe(true);
    expect(sameSubmission(submission(), submission())).toBe(true);
  });

  it("[smoke.submit-other] an answer for another revision, commit or change is not a replay, and nor is one that names none", () => {
    expect(sameSubmission(submission(), submission({ revision: 2 }))).toBe(false);
    expect(sameSubmission(submission(), submission({ commitSha: COMMIT.replace("4", "5") }))).toBe(
      false,
    );
    expect(sameSubmission(submission(), submission({ changeId: CHANGE.replace("J", "K") }))).toBe(
      false,
    );
    expect(sameSubmission({ ok: false }, { ok: false })).toBe(false);
  });

  it("[smoke.inbox-later] a page read a moment later may hold a notice more, and is the same page as far as the earlier one went", () => {
    const seven = [1, 2, 3, 4, 5, 6, 7].map(notice);
    expect(samePageSoFar(page(seven, "57"), page([...seven, started], "58"))).toBe(true);
    expect(samePageSoFar(page([...seven, started], "58"), page(seven, "57"))).toBe(true);
    expect(samePageSoFar(page(seven, "57"), page(seven, "57"))).toBe(true);
  });

  it("[smoke.inbox-other] pages that differ where both hold a notice are not one page, and nor are two of one length that end apart", () => {
    const seven = [1, 2, 3, 4, 5, 6, 7].map(notice);
    const other = [1, 2, 3, 4, 5, 6, 8].map(notice);
    expect(samePageSoFar(page(seven, "57"), page([...other, started], "58"))).toBe(false);
    expect(samePageSoFar(page(seven, "57"), page(other, "57"))).toBe(false);
    expect(samePageSoFar(page(seven, "57"), page(seven, "58"))).toBe(false);
    expect(samePageSoFar({ ok: false }, { ok: false })).toBe(false);
  });
});
