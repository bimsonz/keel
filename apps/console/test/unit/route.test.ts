import { describe, expect, it } from "vitest";
import { RESERVED, type Route, carriedOf, href, parse } from "../../src/route.ts";

/** Every kind of address the console has, with the route it names. Each is read, and written back the same. */
const ADDRESSES: [string, Route][] = [
  ["/demo", { at: "code", kind: "tree", ref: "trunk", path: "" }],
  ["/demo/tree/trunk/src/authz", { at: "code", kind: "tree", ref: "trunk", path: "src/authz" }],
  ["/demo/tree/2e7f0b9", { at: "code", kind: "tree", ref: "2e7f0b9", path: "" }],
  [
    "/demo/blob/trunk/src/authz/cache.ts",
    { at: "code", kind: "blob", ref: "trunk", path: "src/authz/cache.ts" },
  ],
  [
    "/demo/blob/2e7f0b9/docs/a%20file.md",
    { at: "code", kind: "blob", ref: "2e7f0b9", path: "docs/a file.md" },
  ],
  ["/demo/commits", { at: "commits", ref: "trunk" }],
  ["/demo/commits/2e7f0b9", { at: "commits", ref: "2e7f0b9" }],
  ["/demo/commit/2e7f0b9", { at: "commit", sha: "2e7f0b9" }],
  ["/demo/changes", { at: "changes", filter: "in-flight", shown: 50 }],
  ["/demo/changes?state=landed", { at: "changes", filter: "landed", shown: 50 }],
  ["/demo/changes?state=bounced", { at: "changes", filter: "bounced", shown: 50 }],
  ["/demo/changes?state=not-landed&shown=150", { at: "changes", filter: "not-landed", shown: 150 }],
  ["/demo/changes/7", { at: "change", name: "7", tab: "overview" }],
  ["/demo/changes/7/verification", { at: "change", name: "7", tab: "verification" }],
  ["/demo/changes/chg_01JABC/files", { at: "change", name: "chg_01JABC", tab: "files" }],
  ["/demo/conflicts", { at: "conflicts", filter: "open", shown: 50 }],
  ["/demo/conflicts?state=settled", { at: "conflicts", filter: "settled", shown: 50 }],
  ["/demo/conflicts/C-1", { at: "conflict", name: "C-1", tab: "overview" }],
  ["/demo/conflicts/C-1/probe", { at: "conflict", name: "C-1", tab: "probe" }],
  ["/demo/conflicts/C%C2%B7ab12/evidence", { at: "conflict", name: "C·ab12", tab: "evidence" }],
  ["/demo/escalations", { at: "escalations", filter: "open", shown: 50 }],
  ["/demo/escalations?state=closed", { at: "escalations", filter: "closed", shown: 50 }],
  ["/demo/escalations/E-1", { at: "escalation", name: "E-1" }],
  ["/demo/mission-control", { at: "mission-control" }],
  [
    "/demo/subjects/authz.permission-evaluation",
    { at: "mission-control", subject: "authz.permission-evaluation" },
  ],
  ["/demo/insights", { at: "insights", tab: "trunk" }],
  ["/demo/insights/funnel", { at: "insights", tab: "funnel" }],
  ["/demo/insights/benchmark", { at: "insights", tab: "benchmark" }],
];

function read(address: string): ReturnType<typeof parse> {
  const [pathname = "", search = ""] = address.split("?");
  return parse(pathname, search);
}

describe("the console's addresses", () => {
  it.each(ADDRESSES)(
    "%s names one place, and that place writes back the same address",
    (address, route) => {
      expect(read(address)).toEqual({ project: "demo", route });
      expect(href("demo", route)).toBe(address);
    },
  );

  it("reads a bare address as the project's code, with the project still to be named", () => {
    expect(read("/")).toEqual({
      project: null,
      route: { at: "code", kind: "tree", ref: "trunk", path: "" },
    });
    expect(read("")).toEqual({
      project: null,
      route: { at: "code", kind: "tree", ref: "trunk", path: "" },
    });
  });

  it("takes no project to be named by a path the Worker answers itself", () => {
    // What the Worker runs first for: its reads, its ruling routes and its health check. And the build's own files.
    expect([...RESERVED].toSorted()).toEqual(["api", "assets", "healthz", "present", "rule"]);
    for (const segment of RESERVED)
      expect(read(`/${segment}/anything`)).toEqual({ project: null, route: { at: "missing" } });
  });

  it("says an address names nothing rather than guess at it", () => {
    for (const address of [
      "/demo/nowhere",
      "/demo/changes/7/nowhere",
      "/demo/conflicts/C-1/files",
      "/demo/escalations/E-1/extra",
      "/demo/insights/nowhere",
      "/demo/commit",
      "/demo/blob/trunk",
      "/demo/subjects",
      "/demo/mission-control/extra",
      "/demo/%E0%A4%A",
    ]) {
      expect(read(address).route).toEqual({ at: "missing" });
    }
  });

  it("ignores a filter or a count it does not know, and never shows less than a page", () => {
    expect(read("/demo/changes?state=sideways&shown=abc").route).toEqual({
      at: "changes",
      filter: "in-flight",
      shown: 50,
    });
    expect(read("/demo/conflicts?state=landed").route).toEqual({
      at: "conflicts",
      filter: "open",
      shown: 50,
    });
    expect(read("/demo/escalations?shown=3").route).toEqual({
      at: "escalations",
      filter: "open",
      shown: 50,
    });
  });

  it("ends a directory's address the same with or without a trailing slash", () => {
    expect(read("/demo/tree/trunk/src/").route).toEqual({
      at: "code",
      kind: "tree",
      ref: "trunk",
      path: "src",
    });
    expect(read("/demo/").route).toEqual({ at: "code", kind: "tree", ref: "trunk", path: "" });
  });
});

describe("what a link carries with it", () => {
  const search =
    "?scenario=s1&t=460&play=0&speed=16&seed=7&ruling=live&agents=40&seconds=90&theme=light&view=code&rule=abc&state=landed&presenter=x";

  it("is the fixture being looked at, in development", () => {
    expect(carriedOf(search, true)).toBe(
      "scenario=s1&t=460&play=0&speed=16&seed=7&ruling=live&agents=40&seconds=90&theme=light",
    );
    expect(carriedOf("", true)).toBe("");
  });

  it("is the theme and nothing else, in the built console", () => {
    expect(carriedOf(search, false)).toBe("theme=light");
    expect(carriedOf("?scenario=swarm", false)).toBe("");
  });

  it("follows the place's own parameters", () => {
    expect(href("demo", { at: "changes", filter: "landed", shown: 50 }, "scenario=s1&t=460")).toBe(
      "/demo/changes?state=landed&scenario=s1&t=460",
    );
    expect(href("demo", { at: "change", name: "7", tab: "files" }, "scenario=s1")).toBe(
      "/demo/changes/7/files?scenario=s1",
    );
    expect(href("demo", { at: "insights", tab: "trunk" }, "")).toBe("/demo/insights");
  });
});
