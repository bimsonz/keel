import { describe, expect, it } from "vitest";
import type { ProjectSettings } from "../../../src/contract/keel/index.ts";
import { maintains, mayPublish, readBy } from "../../../src/engine/settings.ts";

describe("a project's settings, as a page offers them", () => {
  it("[settings.maintainers] offers them to an owner and a maintainer of the project's org, and to nobody else", () => {
    expect(maintains({ viewer: { role: "owner" } })).toBe(true);
    expect(maintains({ viewer: { role: "maintainer" } })).toBe(true);
    expect(maintains({ viewer: { role: "member" } })).toBe(false);
    // A visitor, and someone signed in who is in no org of the project's: Keel names neither a viewer.
    expect(maintains({})).toBe(false);
  });

  it("[settings.typed] makes a project public only once its name has been typed, whole and as it is written", () => {
    const project = { name: "forge-lite" };
    expect(mayPublish(project, "forge-lite")).toBe(true);
    for (const typed of ["", "forge", "forge-lite ", "Forge-Lite", "keel/forge-lite"])
      expect(mayPublish(project, typed)).toBe(false);
  });

  it("[settings.whole] changes who may read a project and nothing else of what Keel holds for it", () => {
    const held: ProjectSettings = {
      protectedPaths: ["infra/**", ".keel/**"],
      maxBatchSize: 8,
      verification: "required",
      visibility: "private",
    };
    expect(readBy(held, "public")).toEqual({ ...held, visibility: "public" });
    expect(readBy(readBy(held, "public"), "private")).toEqual(held);
    // What was read is not written on.
    expect(held.visibility).toBe("private");
  });
});
