import { describe, expect, it } from "vitest";
import type { Org } from "../../../src/account/account.ts";
import { accountsOf, isOwn } from "../../../src/account/accounts.ts";

const ada = { handle: "ada" };
// As Keel lists them: the orgs the person made or joined. Their own namespace is no org, and is not among them.
const listed: Org[] = [
  { id: "org_2", name: "Analytical Engines", handle: "engines" },
  { id: "org_3", name: "lovelace", handle: "lovelace" },
];

describe("a person's accounts", () => {
  it("[accounts.own] takes a handle to be a person's own where it is theirs, and nobody's where they have none", () => {
    expect(isOwn({ handle: "ada" }, ada)).toBe(true);
    expect(isOwn({ handle: "engines" }, ada)).toBe(false);
    // Someone who has not chosen a handle yet has no namespace of their own.
    expect(isOwn({ handle: "ada" }, {})).toBe(false);
  });

  it("[accounts.first] lists the person's own handle first in the frame's dropdown, marked as theirs, then their orgs", () => {
    expect(accountsOf(listed, ada)).toEqual([
      { name: "ada", href: "/ada", note: "you" },
      { name: "engines", href: "/engines", note: "Analytical Engines" },
      { name: "lovelace", href: "/lovelace" },
    ]);
    // Someone who has not chosen a handle yet has no account of their own to list: their orgs alone.
    expect(accountsOf(listed, {}).map((entry) => entry.name)).toEqual(["engines", "lovelace"]);
  });
});
