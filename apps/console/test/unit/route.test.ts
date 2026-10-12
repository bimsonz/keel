import { describe, expect, it } from "vitest";
import { RESERVED, type Route, carriedOf, href, parse } from "../../src/route.ts";

/** Every kind of address the console has, with the route it names. Each is read, and written back the same. */
const ADDRESSES: [string, Route][] = [
  ["/acme/demo", { at: "code", kind: "tree", ref: "trunk", path: "" }],
  [
    "/acme/demo/tree/trunk/src/authz",
    { at: "code", kind: "tree", ref: "trunk", path: "src/authz" },
  ],
  ["/acme/demo/tree/2e7f0b9", { at: "code", kind: "tree", ref: "2e7f0b9", path: "" }],
  [
    "/acme/demo/blob/trunk/src/authz/cache.ts",
    { at: "code", kind: "blob", ref: "trunk", path: "src/authz/cache.ts" },
  ],
  [
    "/acme/demo/blob/2e7f0b9/docs/a%20file.md",
    { at: "code", kind: "blob", ref: "2e7f0b9", path: "docs/a file.md" },
  ],
  ["/acme/demo/commits", { at: "commits", ref: "trunk" }],
  ["/acme/demo/commits/2e7f0b9", { at: "commits", ref: "2e7f0b9" }],
  ["/acme/demo/commit/2e7f0b9", { at: "commit", sha: "2e7f0b9" }],
  ["/acme/demo/changes", { at: "changes", filter: "in-flight", shown: 50 }],
  ["/acme/demo/changes?state=landed", { at: "changes", filter: "landed", shown: 50 }],
  ["/acme/demo/changes?state=bounced", { at: "changes", filter: "bounced", shown: 50 }],
  [
    "/acme/demo/changes?state=not-landed&shown=150",
    { at: "changes", filter: "not-landed", shown: 150 },
  ],
  ["/acme/demo/changes/7", { at: "change", name: "7", tab: "overview" }],
  ["/acme/demo/changes/7/verification", { at: "change", name: "7", tab: "verification" }],
  ["/acme/demo/changes/chg_01JABC/files", { at: "change", name: "chg_01JABC", tab: "files" }],
  ["/acme/demo/conflicts", { at: "conflicts", filter: "open", shown: 50 }],
  ["/acme/demo/conflicts?state=settled", { at: "conflicts", filter: "settled", shown: 50 }],
  ["/acme/demo/conflicts/C-1", { at: "conflict", name: "C-1", tab: "overview" }],
  ["/acme/demo/conflicts/C-1/probe", { at: "conflict", name: "C-1", tab: "probe" }],
  [
    "/acme/demo/conflicts/C%C2%B7ab12/evidence",
    { at: "conflict", name: "C·ab12", tab: "evidence" },
  ],
  ["/acme/demo/escalations", { at: "escalations", filter: "open", shown: 50 }],
  ["/acme/demo/escalations?state=closed", { at: "escalations", filter: "closed", shown: 50 }],
  ["/acme/demo/escalations/E-1", { at: "escalation", name: "E-1" }],
  ["/acme/demo/mission-control", { at: "mission-control" }],
  [
    "/acme/demo/subjects/authz.permission-evaluation",
    { at: "mission-control", subject: "authz.permission-evaluation" },
  ],
  ["/acme/demo/insights", { at: "insights", tab: "trunk" }],
  ["/acme/demo/insights/funnel", { at: "insights", tab: "funnel" }],
  ["/acme/demo/insights/benchmark", { at: "insights", tab: "benchmark" }],
];

function read(address: string): ReturnType<typeof parse> {
  const [pathname = "", search = ""] = address.split("?");
  return parse(pathname, search);
}

describe("the console's addresses", () => {
  it.each(ADDRESSES)(
    "%s names one place, and that place writes back the same address",
    (address, route) => {
      expect(read(address)).toEqual({ org: "acme", project: "demo", route });
      expect(href("acme", "demo", route)).toBe(address);
    },
  );

  it("[route.home] reads the bare address as the home, and one segment as an org's own, each naming no project", () => {
    const top = { at: "code", kind: "tree", ref: "trunk", path: "" };
    expect(read("/")).toEqual({ org: null, project: null, route: top });
    expect(read("")).toEqual({ org: null, project: null, route: top });
    expect(read("/acme")).toEqual({ org: "acme", project: null, route: top });
    expect(read("/acme/")).toEqual({ org: "acme", project: null, route: top });
  });

  it("[route.org] reads the org before the project, so one org's project is never taken for another's of the same name", () => {
    expect(read("/acme/demo/changes/7")).toMatchObject({ org: "acme", project: "demo" });
    expect(read("/other/demo/changes/7")).toMatchObject({ org: "other", project: "demo" });
    // A project named as a place is a project all the same: the place comes third.
    expect(read("/acme/changes")).toEqual({
      org: "acme",
      project: "changes",
      route: { at: "code", kind: "tree", ref: "trunk", path: "" },
    });
    expect(href("other", "demo", { at: "change", name: "7", tab: "overview" })).toBe(
      "/other/demo/changes/7",
    );
  });

  it("[route.reserved] takes no project, and no org, to be named by a reserved first segment", () => {
    // The list agreed with Keel, which refuses each of these as a handle: what Keel or the Worker answers itself,
    // the build's own files, and the pages above every org.
    expect([...RESERVED].toSorted()).toEqual(
      [
        ".well-known",
        "admin",
        "api",
        "assets",
        "device",
        "favicon.ico",
        "healthz",
        "install",
        "invite",
        "llms.txt",
        "login",
        "logout",
        "mcp",
        "new",
        "orgs",
        "privacy",
        "robots.txt",
        "settings",
        "signup",
        "start",
        "terms",
        "v1",
      ].toSorted(),
    );
    for (const segment of RESERVED) {
      const nowhere = { org: null, project: null, route: { at: "missing" } };
      expect(read(`/${segment}`)).toEqual(nowhere);
      expect(read(`/${segment}/anything/changes`)).toEqual(nowhere);
    }
  });

  it("says an address names nothing rather than guess at it", () => {
    for (const address of [
      "/acme/demo/nowhere",
      "/acme/demo/changes/7/nowhere",
      "/acme/demo/conflicts/C-1/files",
      "/acme/demo/escalations/E-1/extra",
      "/acme/demo/insights/nowhere",
      "/acme/demo/commit",
      "/acme/demo/blob/trunk",
      "/acme/demo/subjects",
      "/acme/demo/mission-control/extra",
      "/acme/demo/%E0%A4%A",
    ]) {
      expect(read(address).route).toEqual({ at: "missing" });
    }
  });

  it("ignores a filter or a count it does not know, and never shows less than a page", () => {
    expect(read("/acme/demo/changes?state=sideways&shown=abc").route).toEqual({
      at: "changes",
      filter: "in-flight",
      shown: 50,
    });
    expect(read("/acme/demo/conflicts?state=landed").route).toEqual({
      at: "conflicts",
      filter: "open",
      shown: 50,
    });
    expect(read("/acme/demo/escalations?shown=3").route).toEqual({
      at: "escalations",
      filter: "open",
      shown: 50,
    });
  });

  it("ends a directory's address the same with or without a trailing slash", () => {
    expect(read("/acme/demo/tree/trunk/src/").route).toEqual({
      at: "code",
      kind: "tree",
      ref: "trunk",
      path: "src",
    });
    expect(read("/acme/demo/").route).toEqual({ at: "code", kind: "tree", ref: "trunk", path: "" });
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
    expect(
      href("acme", "demo", { at: "changes", filter: "landed", shown: 50 }, "scenario=s1&t=460"),
    ).toBe("/acme/demo/changes?state=landed&scenario=s1&t=460");
    expect(href("acme", "demo", { at: "change", name: "7", tab: "files" }, "scenario=s1")).toBe(
      "/acme/demo/changes/7/files?scenario=s1",
    );
    expect(href("acme", "demo", { at: "insights", tab: "trunk" }, "")).toBe("/acme/demo/insights");
  });
});
