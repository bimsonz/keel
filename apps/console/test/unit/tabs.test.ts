import { describe, expect, it } from "vitest";
import { PAGE } from "../../src/engine/lists.ts";
import { tabOf, titleOf } from "../../src/tabs.ts";

describe("a project's tabs", () => {
  it("[tabs.of] files a conflict and a question under Changes, and Keel's own lists under Insights", () => {
    expect(tabOf({ at: "code", kind: "tree", ref: "trunk", path: "" })).toBe("code");
    expect(tabOf({ at: "commit", sha: "2e7f0b9" })).toBe("code");
    expect(tabOf({ at: "changes", filter: "open", shown: PAGE })).toBe("changes");
    expect(tabOf({ at: "change", name: "7", tab: "checks" })).toBe("changes");
    expect(tabOf({ at: "conflict", name: "C-1", tab: "overview" })).toBe("changes");
    expect(tabOf({ at: "escalation", name: "E-1" })).toBe("changes");
    expect(tabOf({ at: "conflicts", filter: "open", shown: PAGE })).toBe("insights");
    expect(tabOf({ at: "escalations", filter: "open", shown: PAGE })).toBe("insights");
    expect(tabOf({ at: "decisions" })).toBe("insights");
    expect(tabOf({ at: "decision", name: "D-1" })).toBe("insights");
    expect(tabOf({ at: "pipeline" })).toBe("pipeline");
    expect(tabOf({ at: "mission-control" })).toBe("mission-control");
    expect(tabOf({ at: "settings" })).toBe("settings");
    expect(tabOf({ at: "missing" })).toBeUndefined();
  });

  it("[tabs.title] titles each page by its place, then the project, as a code host titles a repository's", () => {
    expect(titleOf({ at: "code", kind: "tree", ref: "trunk", path: "" }, "keel", "keel")).toBe(
      "keel/keel",
    );
    expect(
      titleOf({ at: "code", kind: "blob", ref: "trunk", path: "README.md" }, "keel", "keel"),
    ).toBe("README.md · keel/keel");
    expect(titleOf({ at: "change", name: "20", tab: "overview" }, "keel", "keel")).toBe(
      "Change #20 · keel/keel",
    );
    expect(titleOf({ at: "changes", filter: "open", shown: PAGE }, "keel", "keel")).toBe(
      "Changes · keel/keel",
    );
    expect(titleOf({ at: "pipeline" }, "acme", "demo")).toBe("Pipeline · acme/demo");
  });
});
