import { describe, expect, it } from "vitest";
import { D1_AWAY, isD1Unavailable } from "../../src/adapters/driven/d1/unavailable.ts";

/** The sentences Cloudflare lists as the ones a retry is for, written out here so one leaving the list is seen. */
const TRANSIENT = [
  "D1 DB reset because its code was updated.",
  "Network connection lost.",
  "Replica disconnected from primary.",
  "Internal error in D1 DB storage caused object to be reset.",
  "Internal error while starting up D1 DB storage caused object to be reset.",
  "Cannot resolve D1 DB due to transient issue on remote node.",
  "Can't read from request stream because client disconnected.",
  "D1 DB storage operation exceeded timeout which caused object to be reset.",
  "D1 DB is overloaded. Requests queued for too long.",
  "D1 DB is overloaded. Too many requests queued.",
  "D1 DB's isolate exceeded its memory limit and was reset.",
  "D1 DB exceeded its CPU time limit and was reset.",
];

/** `error` under `wrappers` errors, each the cause of the one above it. */
const under = (wrappers: number, error: unknown): unknown =>
  wrappers === 0 ? error : new Error("a wrapper", { cause: under(wrappers - 1, error) });

describe("what D1 says when it is away", () => {
  it("[d1.unavailable-list] each sentence of the list reads as away: plain, as D1 prefixes it, and as a cause two deep", () => {
    expect([...D1_AWAY]).toEqual(TRANSIENT);
    for (const sentence of TRANSIENT) {
      expect([
        sentence,
        isD1Unavailable(new Error(sentence)),
        isD1Unavailable(new Error(`D1_ERROR: ${sentence}`)),
        isD1Unavailable(under(2, new Error(`D1_ERROR: ${sentence}`))),
      ]).toEqual([sentence, true, true, true]);
    }
  });

  it("[d1.unavailable-causes] a cause is read four deep and no deeper, and a cause that is its own cause ends", () => {
    const lost = new Error("D1_ERROR: Network connection lost.");
    expect([4, 5].map((wrappers) => isD1Unavailable(under(wrappers, lost)))).toEqual([true, false]);
    const circle = new Error("round");
    circle.cause = circle;
    expect(isD1Unavailable(circle)).toBe(false);
  });

  it("[d1.unavailable-others] a query that is wrong, a constraint, a wrong type and what is no error are not away", () => {
    const others: unknown[] = [
      new Error("D1_ERROR: no such table: nowhere: SQLITE_ERROR"),
      new Error("D1_ERROR: UNIQUE constraint failed: projects.id: SQLITE_CONSTRAINT"),
      new Error("D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined'"),
      new Error("D1_ERROR"),
      "Network connection lost.",
      { message: "Network connection lost." },
      undefined,
      null,
    ];
    expect(others.map(isD1Unavailable)).toEqual(others.map(() => false));
  });
});
