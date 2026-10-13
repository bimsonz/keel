import { describe, expect, it } from "vitest";
import { type Target, directoryOf, readmeAmong, targetOf } from "../../../src/engine/readme.ts";

const entries = (...written: string[]): { kind: string; name: string }[] =>
  written.map((entry) =>
    entry.endsWith("/")
      ? { kind: "tree", name: entry.slice(0, -1) }
      : { kind: "blob", name: entry },
  );
const readme = (...written: string[]): string | undefined => readmeAmong(entries(...written))?.name;

const file = (path: string): Target => ({ to: "path", kind: "blob", path });
const directory = (path: string): Target => ({ to: "path", kind: "tree", path });
const NOWHERE: Target = { to: "nowhere" };

describe("a directory's README", () => {
  it("[readme.name] is README.md, then README.markdown, then README, wherever each stands in the list", () => {
    expect(readme("LICENSE", "README", "README.markdown", "README.md")).toBe("README.md");
    expect(readme("README", "README.markdown", "main.ts")).toBe("README.markdown");
    expect(readme("src/", "README")).toBe("README");
    // No other name is one, however close.
    expect(readme("README.txt", "README.rst", "READMEmd", "MYREADME.md", "docs.md")).toBe(
      undefined,
    );
    expect(readme()).toBe(undefined);
  });

  it("[readme.case] is told by its name in any case", () => {
    expect(readme("package.json", "readme.md")).toBe("readme.md");
    expect(readme("ReadMe.MD")).toBe("ReadMe.MD");
    expect(readme("Readme.Markdown")).toBe("Readme.Markdown");
    expect(readme("readme")).toBe("readme");
  });

  it("[readme.file] is a file: a directory by the name is not one", () => {
    expect(readme("README.md/", "README/")).toBe(undefined);
    expect(readme("README.md/", "readme")).toBe("readme");
  });

  it("[readme.directory] is in the directory its path names, the root for a file at the root", () => {
    expect(["README.md", "docs/README", "docs/api/readme.md"].map(directoryOf)).toEqual([
      "",
      "docs",
      "docs/api",
    ]);
  });
});

describe("an address written in a README", () => {
  it("[readme.link] is counted from the README's own directory", () => {
    expect(targetOf("guide.md", "")).toEqual(file("guide.md"));
    expect(targetOf("guide.md", "docs")).toEqual(file("docs/guide.md"));
    expect(targetOf("./api/index.md", "docs")).toEqual(file("docs/api/index.md"));
    expect(targetOf("a/./b//c.md", "docs")).toEqual(file("docs/a/b/c.md"));
  });

  it("[readme.link-up] climbs a directory at each .., and leads nowhere once it has climbed out of the repository", () => {
    expect(targetOf("../src/http.ts", "docs")).toEqual(file("src/http.ts"));
    expect(targetOf("../../LICENSE", "docs/api")).toEqual(file("LICENSE"));
    expect(targetOf("..", "docs")).toEqual(directory(""));
    expect(targetOf("../..", "docs")).toEqual(NOWHERE);
    expect(targetOf("../secrets.txt", "")).toEqual(NOWHERE);
    expect(targetOf("a/../../../etc/passwd", "docs")).toEqual(NOWHERE);
    expect(targetOf("/../outside", "docs")).toEqual(NOWHERE);
  });

  it("[readme.link-root] is counted from the repository's root when it opens with a slash", () => {
    expect(targetOf("/package.json", "docs/api")).toEqual(file("package.json"));
    expect(targetOf("/src/authz/check.ts", "docs")).toEqual(file("src/authz/check.ts"));
    expect(targetOf("/", "docs")).toEqual(directory(""));
  });

  it("[readme.link-kind] is a file unless it is written as a directory or is the root itself", () => {
    expect(targetOf("src/", "")).toEqual(directory("src"));
    expect(targetOf("../", "docs/api")).toEqual(directory("docs"));
    expect(targetOf("src", "")).toEqual(file("src"));
    expect(targetOf("./", "")).toEqual(directory(""));
  });

  it("[readme.link-plain] names the path as it is, without what the address added to it", () => {
    expect(targetOf("a%20b.md", "docs")).toEqual(file("docs/a b.md"));
    // A part that is no encoding of anything is taken as written.
    expect(targetOf("100%.md", "")).toEqual(file("100%.md"));
    expect(targetOf("guide.md#usage", "docs")).toEqual(file("docs/guide.md"));
    expect(targetOf("guide.md?plain=1", "docs")).toEqual(file("docs/guide.md"));
    expect(targetOf("api/?tab=all#top", "docs")).toEqual(directory("docs/api"));
  });

  it("[readme.link-heading] leads to a heading by the id its words give it, which is in lower case", () => {
    expect(targetOf("#run", "docs")).toEqual({ to: "heading", id: "run" });
    expect(targetOf("#Getting-Started", "")).toEqual({ to: "heading", id: "getting-started" });
    expect(targetOf("#caf%C3%A9", "")).toEqual({ to: "heading", id: "café" });
    expect(targetOf("#", "")).toEqual(NOWHERE);
    expect(targetOf("", "docs")).toEqual(NOWHERE);
  });

  it("[readme.link-elsewhere] is somewhere else when it names a scheme or a host, and is never read as a path", () => {
    for (const href of [
      "https://example.org/a",
      "HTTP://EXAMPLE.ORG",
      "mailto:someone@example.org",
      "//cdn.example.org/x.js",
    ]) {
      expect(targetOf(href, "docs")).toEqual({ to: "elsewhere", href });
    }
  });

  it("[readme.link-scheme] leads nowhere by a scheme a browser might run or read a file by", () => {
    for (const href of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "blob:https://example.org/1",
    ]) {
      expect(targetOf(href, "docs")).toEqual(NOWHERE);
    }
  });
});
