import { describe, expect, it } from "vitest";
import type { Org } from "../../../src/account/account.ts";
import { accountsOf, isOwn, orgsOf } from "../../../src/account/accounts.ts";

const ada = { handle: "ada" };
// As Keel lists them: in the order the person joined, their own namespace wherever it falls.
const listed: Org[] = [
  { id: "org_2", name: "Analytical Engines", handle: "engines" },
  { id: "org_1", name: "ada", handle: "ada" },
  { id: "org_3", name: "lovelace", handle: "lovelace" },
];

describe("a person's accounts", () => {
  it("[accounts.own] counts a person's own namespace as theirs and never among their orgs", () => {
    expect(isOwn({ handle: "ada" }, ada)).toBe(true);
    expect(isOwn({ handle: "engines" }, ada)).toBe(false);
    // Someone who has not chosen a handle yet has no namespace of their own.
    expect(isOwn({ handle: "ada" }, {})).toBe(false);
    expect(orgsOf(listed, ada).map((org) => org.handle)).toEqual(["engines", "lovelace"]);
    expect(orgsOf(listed, {}).map((org) => org.handle)).toEqual(["engines", "ada", "lovelace"]);
  });

  it("[accounts.first] lists the person's own handle first in the frame's dropdown, marked as theirs, then their orgs", () => {
    expect(accountsOf(listed, ada)).toEqual([
      { name: "ada", href: "/ada", note: "you" },
      { name: "engines", href: "/engines", note: "Analytical Engines" },
      { name: "lovelace", href: "/lovelace" },
    ]);
  });
});
