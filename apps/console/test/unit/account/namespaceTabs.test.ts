import { describe, expect, it } from "vitest";
import { tabHref, tabsOf } from "../../../src/account/namespaceTabs.ts";

describe("a namespace's tabs", () => {
  it("[tabs.by-reader] offers each reader the tabs Keel lets them open, in a code host's order", () => {
    // A person, on their own page and on another's.
    expect(tabsOf({ kind: "user", own: true })).toEqual([
      "overview",
      "projects",
      "orgs",
      "settings",
    ]);
    expect(tabsOf({ kind: "user", own: false })).toEqual(["overview", "projects"]);
    // An agent's page is the same to everyone.
    expect(tabsOf({ kind: "agent", own: false })).toEqual(["overview", "projects"]);
    // An org: to anyone who is not a member, as Keel reads its members only to them; to each role of a member.
    expect(tabsOf({ kind: "org", own: false })).toEqual(["overview", "projects"]);
    expect(tabsOf({ kind: "org", own: false, role: "member" })).toEqual([
      "overview",
      "projects",
      "people",
    ]);
    expect(tabsOf({ kind: "org", own: false, role: "maintainer" })).toEqual([
      "overview",
      "projects",
      "people",
      "settings",
    ]);
    expect(tabsOf({ kind: "org", own: false, role: "owner" })).toEqual([
      "overview",
      "projects",
      "people",
      "credentials",
      "settings",
    ]);
  });

  it("[tabs.addresses] puts each tab where the console already has its page, and a namespace's projects under its own address", () => {
    expect(tabHref("acme", "org", "overview")).toBe("/acme");
    expect(tabHref("acme", "org", "projects")).toBe("/acme?tab=projects");
    expect(tabHref("acme", "org", "people")).toBe("/orgs/acme/members");
    expect(tabHref("acme", "org", "credentials")).toBe("/orgs/acme/credentials");
    expect(tabHref("acme", "org", "settings")).toBe("/orgs/acme/settings");
    expect(tabHref("ada", "user", "orgs")).toBe("/ada?tab=orgs");
    // A person's settings are their account's, at /settings.
    expect(tabHref("ada", "user", "settings")).toBe("/settings");
  });
});
