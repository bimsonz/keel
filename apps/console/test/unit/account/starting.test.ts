import { describe, expect, it } from "vitest";
import { keys, ownersOf, ready, requestOf } from "../../../src/account/starting.ts";

describe("making a project: what is asked of Keel", () => {
  it("[new.request] asks for the name as typed with no space round it, and for a branch only where one was given", () => {
    expect(requestOf("ada", "  Notes ", { kind: "empty" })).toEqual({
      namespace: "ada",
      name: "Notes",
      source: { kind: "empty" },
    });
    // Whether a name is free, and in which case Keel keeps it, are Keel's to say: nothing is lower-cased here.
    expect(
      requestOf("acme", "Forge", { kind: "import", url: " https://git.example/a/b ", ref: " " }),
    ).toEqual({
      namespace: "acme",
      name: "Forge",
      source: { kind: "import", url: "https://git.example/a/b" },
    });
    expect(
      requestOf("acme", "forge", { kind: "import", url: "https://git.example/a/b", ref: " main " })
        .source,
    ).toEqual({ kind: "import", url: "https://git.example/a/b", ref: "main" });
  });

  it("[new.ready] has nothing to ask until there is an owner, a name, and an address where a repository is to be imported", () => {
    expect(ready(requestOf("ada", "notes", { kind: "empty" }))).toBe(true);
    expect(ready(requestOf("ada", "   ", { kind: "empty" }))).toBe(false);
    expect(ready(requestOf("", "notes", { kind: "empty" }))).toBe(false);
    expect(ready(requestOf("ada", "notes", { kind: "import", url: " ", ref: "main" }))).toBe(false);
    expect(
      ready(requestOf("ada", "notes", { kind: "import", url: "https://git.example/a/b", ref: "" })),
    ).toBe(true);
  });

  it("[new.key] sends the same request again under the same key and a changed one under another, and makes the key of nothing typed", () => {
    let made = 0;
    const keyOf = keys(() => {
      made += 1;
      return `fresh-${made}`;
    });
    const asked = requestOf("ada", "notes", { kind: "empty" });
    expect(keyOf(asked)).toBe("console:new:fresh-1");
    // Asked again as it was, as after a host that did not answer: Keel finishes the same project.
    expect(keyOf(requestOf("ada", "notes ", { kind: "empty" }))).toBe("console:new:fresh-1");
    // Anything changed is another request: Keel refuses an old key used for one.
    const other = requestOf("ada", "notes-2", { kind: "empty" });
    expect(keyOf(other)).toBe("console:new:fresh-2");
    expect(keyOf(asked)).toBe("console:new:fresh-3");
    // A key says nothing of what was asked, and holds no address that was typed.
    const secret = requestOf("ada", "private-plans", {
      kind: "import",
      url: "https://git.example/secret/place",
      ref: "",
    });
    const key = keys()(secret);
    expect(key).toMatch(/^console:new:[0-9a-f-]{36}$/);
    for (const typed of ["private-plans", "secret", "git.example"])
      expect(key).not.toContain(typed);
  });

  it("[new.owners] offers the person's own account first, then each org Keel lists them in, and nobody's where they have no handle", () => {
    const orgs = [
      { handle: "acme", name: "Acme Ltd" },
      { handle: "zeta", name: "zeta" },
    ];
    expect(ownersOf(orgs, { handle: "ada" })).toEqual([
      { handle: "ada", note: "you" },
      { handle: "acme", note: "Acme Ltd" },
      { handle: "zeta", note: "zeta" },
    ]);
    expect(ownersOf([], {})).toEqual([]);
  });
});
