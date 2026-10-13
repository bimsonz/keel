import { describe, expect, it } from "vitest";
import { RESERVED_SEGMENTS } from "../../src/contract/keel/index.ts";
import { type Route, carriedOf, href, parse } from "../../src/route.ts";

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
  ["/acme/demo/decisions", { at: "decisions" }],
  [
    "/acme/demo/decisions?subject=authz.permission-evaluation",
    { at: "decisions", subject: "authz.permission-evaluation" },
  ],
  ["/acme/demo/decisions/D-1", { at: "decision", name: "D-1" }],
  ["/acme/demo/mission-control", { at: "mission-control" }],
  [
    "/acme/demo/subjects/authz.permission-evaluation",
    { at: "mission-control", subject: "authz.permission-evaluation" },
  ],
  ["/acme/demo/insights", { at: "insights", tab: "trunk" }],
  ["/acme/demo/insights/funnel", { at: "insights", tab: "funnel" }],
  ["/acme/demo/insights/benchmark", { at: "insights", tab: "benchmark" }],
  ["/acme/demo/agents", { at: "agents", shown: 50 }],
  ["/acme/demo/agents?shown=100", { at: "agents", shown: 100 }],
  ["/acme/demo/agents/tidy-otter", { at: "agent", name: "tidy-otter" }],
  ["/acme/demo/agents/agt_01JABC", { at: "agent", name: "agt_01JABC" }],
];

function read(address: string): ReturnType<typeof parse> {
  const [pathname = "", search = ""] = address.split("?");
  return parse(pathname, search);
}

describe("the console's addresses", () => {
  it.each(ADDRESSES)(
    "%s names one place, and that place writes back the same address",
    (address, route) => {
      expect(read(address)).toEqual({ namespace: "acme", project: "demo", route });
      expect(href("acme", "demo", route)).toBe(address);
    },
  );

  it("[route.home] reads the bare address as the home, and one segment as a namespace's own, each naming no project", () => {
    const top = { at: "code", kind: "tree", ref: "trunk", path: "" };
    expect(read("/")).toEqual({ namespace: null, project: null, route: top });
    expect(read("")).toEqual({ namespace: null, project: null, route: top });
    expect(read("/acme")).toEqual({ namespace: "acme", project: null, route: top });
    expect(read("/acme/")).toEqual({ namespace: "acme", project: null, route: top });
  });

  it("[route.namespace] reads the namespace before the project, so one's project is never taken for another's of the same name", () => {
    expect(read("/acme/demo/changes/7")).toMatchObject({ namespace: "acme", project: "demo" });
    expect(read("/other/demo/changes/7")).toMatchObject({ namespace: "other", project: "demo" });
    // A project named as a place is a project all the same: the place comes third.
    expect(read("/acme/changes")).toEqual({
      namespace: "acme",
      project: "changes",
      route: { at: "code", kind: "tree", ref: "trunk", path: "" },
    });
    expect(href("other", "demo", { at: "change", name: "7", tab: "overview" })).toBe(
      "/other/demo/changes/7",
    );
  });

  it("[route.reserved] takes no project, and no namespace, to be named by a reserved first segment", () => {
    // The list is Keel's own, which refuses each of these as a handle: what Keel or the Worker answers itself,
    // the build's own files, and the pages above every namespace. A page the console adds is in it before it ships.
    expect(RESERVED_SEGMENTS).toEqual(
      expect.arrayContaining(["v1", "assets", "healthz", "login", "orgs"]),
    );
    for (const segment of RESERVED_SEGMENTS) {
      const nowhere = { namespace: null, project: null, route: { at: "missing" } };
      expect(read(`/${segment}`)).toEqual(nowhere);
      expect(read(`/${segment}/anything/changes`)).toEqual(nowhere);
    }
  });

  it("[route.settings] gives a project's settings an address of their own, with nothing under it", () => {
    expect(parse("/acme/demo/settings", "")).toEqual({
      namespace: "acme",
      project: "demo",
      route: { at: "settings" },
    });
    expect(href("acme", "demo", { at: "settings" })).toBe("/acme/demo/settings");
    expect(parse("/acme/demo/settings/members", "").route).toEqual({ at: "missing" });
    // The first segment of that name is the reader's own settings, and nobody's handle.
    expect(parse("/settings", "")).toMatchObject({ namespace: null, project: null });
  });

  it("[route.agents] gives the project's agents a list, and each agent an address with nothing under it", () => {
    expect(parse("/acme/demo/agents", "").route).toEqual({ at: "agents", shown: 50 });
    expect(parse("/acme/demo/agents", "shown=150").route).toEqual({ at: "agents", shown: 150 });
    expect(href("acme", "demo", { at: "agents", shown: 50 })).toBe("/acme/demo/agents");
    expect(href("acme", "demo", { at: "agents", shown: 150 })).toBe("/acme/demo/agents?shown=150");
    // An agent is called by its handle, or by Keel's id for it: one segment either way.
    expect(parse("/acme/demo/agents/tidy-otter", "").route).toEqual({
      at: "agent",
      name: "tidy-otter",
    });
    expect(href("acme", "demo", { at: "agent", name: "tidy-otter" })).toBe(
      "/acme/demo/agents/tidy-otter",
    );
    // A run is a part of its agent's page, and has no address of its own.
    expect(parse("/acme/demo/agents/tidy-otter/runs", "").route).toEqual({ at: "missing" });
    expect(parse("/acme/demo/agents/tidy-otter/run_1", "").route).toEqual({ at: "missing" });
  });

  it("[route.decisions] gives the project's decisions a list, narrowed by a subject where one is named, and each decision an address", () => {
    // A decision is called by Keel's label for it, or by Keel's id where a link has only that: one segment.
    expect(read("/acme/demo/decisions/dec_01").route).toEqual({ at: "decision", name: "dec_01" });
    // A decision has no part with an address of its own.
    expect(read("/acme/demo/decisions/D-1/extra").route).toEqual({ at: "missing" });
    // A subject that names nothing narrows nothing, and the list's address stays bare.
    expect(read("/acme/demo/decisions?subject=").route).toEqual({ at: "decisions" });
    expect(href("acme", "demo", { at: "decisions" })).toBe("/acme/demo/decisions");
    // The subject rides beside whatever every link carries.
    expect(href("acme", "demo", { at: "decisions", subject: "a.b" }, "theme=dark")).toBe(
      "/acme/demo/decisions?subject=a.b&theme=dark",
    );
  });

  it("says an address names nothing rather than guess at it", () => {
    for (const address of [
      "/acme/demo/nowhere",
      "/acme/demo/changes/7/nowhere",
      "/acme/demo/conflicts/C-1/files",
      "/acme/demo/escalations/E-1/extra",
      "/acme/demo/decisions/D-1/extra",
      "/acme/demo/insights/nowhere",
      "/acme/demo/agents/tidy-otter/runs",
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
