import { describe, expect, it } from "vitest";
import {
  mappingFromD1,
  mappingOf,
  mappingQueryFor,
  MappingRefused,
} from "../../../scripts/lib/rehome-r2.ts";

const ORG_A = "org_01M4S2MJTNG88WTBB0JSDHKCKJ";
const ORG_B = "org_01M4RZBDSFSC5H0BA1PM87E40X";
const USER_A = "usr_01M4S2MJTNG88WTBB0JSDHKCKA";
const USER_B = "usr_01M4RZBDSFSC5H0BA1PM87E40B";

const row = (from: unknown, to: unknown, handle: unknown = "keel-run-d") => ({ from, to, handle });

/** The two statements of the migration that re-home, as it writes them. */
const REHOMES = `
-- A personal org's projects and agents become its person's own.
UPDATE projects
SET namespace_id = (
  SELECT u.id FROM organization o JOIN "user" u ON u.username = o.slug
  WHERE o.id = projects.namespace_id
)
WHERE namespace_id IN (
  SELECT o.id FROM organization o JOIN "user" u ON u.username = o.slug
);

UPDATE agents
SET namespace_id = (
  SELECT u.id FROM organization o JOIN "user" u ON u.username = o.slug
  WHERE o.id = agents.namespace_id
)
WHERE namespace_id IN (
  SELECT o.id FROM organization o JOIN "user" u ON u.username = o.slug
);
`;

describe("who becomes whom when a namespace's objects are carried to its new id", () => {
  it("[rehome.mapping] takes rows that each turn one org's id into one user's", () => {
    expect(mappingOf([row(ORG_A, USER_A), row(ORG_B, USER_B, "keel-seed")])).toEqual([
      { from: ORG_A, to: USER_A, handle: "keel-run-d" },
      { from: ORG_B, to: USER_B, handle: "keel-seed" },
    ]);
  });

  it.each([
    ["no list", { from: ORG_A, to: USER_A, handle: "a" }, /not a list/],
    ["no rows", [], /no rows/],
    ["a source that is a user's id", [row(USER_A, USER_B)], /not an org's id/],
    ["a source that is no id", [row("org_", USER_A)], /not an org's id/],
    ["a source with a path in it", [row(`${ORG_A}/bundles`, USER_A)], /not an org's id/],
    ["a destination that is an org's id", [row(ORG_A, ORG_B)], /not a user's id/],
    ["a destination left out", [{ from: ORG_A, handle: "a" }], /not a user's id/],
    ["a handle that is no handle", [row(ORG_A, USER_A, "Not A Handle")], /not a handle/],
    ["an org mapped twice", [row(ORG_A, USER_A), row(ORG_A, USER_B)], /mapped twice/],
    ["two orgs into one user", [row(ORG_A, USER_A), row(ORG_B, USER_A)], /two orgs/],
  ])("[rehome.mapping-refused] refuses %s", (_what, rows, reason) => {
    expect(() => mappingOf(rows)).toThrow(MappingRefused);
    expect(() => mappingOf(rows)).toThrow(reason);
  });

  it("[rehome.mapping-d1] reads the rows out of the one statement D1 answered", () => {
    const answer = [{ results: [row(ORG_A, USER_A)], success: true, meta: { rows_read: 2 } }];
    expect(mappingFromD1(answer)).toEqual([{ from: ORG_A, to: USER_A, handle: "keel-run-d" }]);
  });

  it.each([
    [
      "a statement that failed",
      [{ results: [row(ORG_A, USER_A)], success: false }],
      /did not answer/,
    ],
    [
      "two statements",
      [
        { results: [], success: true },
        { results: [], success: true },
      ],
      /did not answer/,
    ],
    ["no rows, which is what the migration leaves", [{ results: [], success: true }], /has run/],
  ])("[rehome.mapping-d1-refused] refuses %s", (_what, answer, reason) => {
    expect(() => mappingFromD1(answer)).toThrow(MappingRefused);
    expect(() => mappingFromD1(answer)).toThrow(reason);
  });

  it("[rehome.join] asks by the join the migration re-homes projects by", () => {
    expect(mappingQueryFor(REHOMES)).toBe(
      'SELECT o.id AS "from", u.id AS "to", u.username AS handle FROM organization o JOIN "user" u ON u.username = o.slug ORDER BY u.username',
    );
  });

  it.each([
    [
      "pairs an org with its owner by the member table",
      REHOMES.replaceAll(
        'organization o JOIN "user" u ON u.username = o.slug',
        'organization o JOIN member m ON m.organizationId = o.id JOIN "user" u ON u.id = m.userId',
      ),
    ],
    ["re-homes agents only", REHOMES.replace(/UPDATE projects[^;]*;/, "")],
    [
      "sets another column",
      REHOMES.replace("UPDATE projects\nSET namespace_id", "UPDATE projects\nSET owner_id"),
    ],
    ["is empty", ""],
  ])("[rehome.join-refused] refuses a migration that %s", (_what, migration) => {
    expect(() => mappingQueryFor(migration)).toThrow(MappingRefused);
  });
});
