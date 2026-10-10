import { describe, expect, it } from "vitest";
import { checkSubDiff, parseDiff } from "../scripts/build-dataset.ts";
import { leaks } from "../src/leak.ts";
import { stripDiff, stripLines } from "../src/strip.ts";

const base = (diff: string) => ({ id: "P01", predicate: "freshness" as const, effect: "per-session", subject: "authz.permission-evaluation", scope: "service:forge-lite", hunks: [{ file: "src/x.ts", language: "typescript", diff }], symbols: [] });

describe("comment stripping (fix 1)", () => {
  it("drops comment-only lines and trailing comments, keeps strings", () => {
    expect(stripLines(['const u = "http://x"; // c', "/* a", " b */ const y = 1;", "let s = '/* no */';"], "typescript")).toEqual(['const u = "http://x";', null, " const y = 1;", "let s = '/* no */';"]);
    expect(stripLines(["x = '#no'  # yes", '"""doc', 'more"""', "q = \"\"\"SELECT 1 -- kept\"\"\""], "python")).toEqual(["x = '#no'", null, null, 'q = """SELECT 1 -- kept"""']);
    expect(stripLines(["  # only", '  name = "a#b" // c', "  /* x */ count = 1"], "hcl")).toEqual([null, '  name = "a#b"', "   count = 1"]);
    expect(stripLines(["s := `raw // not a comment", "still raw` // gone"], "go")).toEqual(["s := `raw // not a comment", "still raw`"]);
    expect(stripLines(["SELECT 1 -- gone", "/* x */ SELECT 2"], "sql")).toEqual(["SELECT 1", " SELECT 2"]);
  });
  it("turns a change that was only a comment into context", () => {
    const d = ["--- a/x.go", "+++ b/x.go", "@@ -1,2 +1,2 @@", " a := 1", "-b := 2 // old", "+b := 2 // new"].join("\n") + "\n";
    expect(stripDiff(d, "go").diff).toBe(["--- a/x.go", "+++ b/x.go", "@@ -1,2 +1,2 @@", " a := 1", " b := 2"].join("\n") + "\n");
  });
  it("leaves a section without comments byte-identical", () => {
    const d = ["--- a/x.ts", "+++ b/x.ts", "@@ -3,2 +3,2 @@ function f() {", " a();", "-b();", "+c();"].join("\n") + "\n";
    expect(stripDiff(d, "typescript").diff).toBe(["--- a/x.ts", "+++ b/x.ts", "@@ -3,2 +3,2 @@ function f() {", " a();", "-b();", "+c();"].join("\n") + "\n");
  });
  it("removes a planted comment leak, but the leak guard still fails a leak in code", () => {
    const planted = ["--- a/src/x.ts", "+++ b/src/x.ts", "@@ -1,1 +1,2 @@", "+// Per-session cache of evaluated roles.", "+const roles = new Map<string, Role>();", " export {};"].join("\n") + "\n";
    expect(leaks(base(planted))).not.toEqual([]);
    expect(leaks(base(stripDiff(planted, "typescript").diff))).toEqual([]);
    const inCode = planted.replaceAll("roles", "perSessionRoles");
    expect(leaks(base(stripDiff(inCode, "typescript").diff))).toEqual(['P01: state contains the ground-truth value "per-session"']);
  });
});

describe("anchor views (fix 3)", () => {
  const orig = parseDiff(["--- a/a.ts", "+++ b/a.ts", "@@ -1,3 +1,3 @@", " x();", "-y();", "+z();", " w();"].join("\n") + "\n");
  it("accepts a view that only removes lines", () => {
    expect(checkSubDiff("T", orig, parseDiff(["--- a/a.ts", "+++ b/a.ts", "@@ -1,2 +1,1 @@", " x();", "-y();"].join("\n") + "\n"))).toEqual([]);
  });
  it("rejects a view that adds or reorders a line", () => {
    expect(checkSubDiff("T", orig, parseDiff(["--- a/a.ts", "+++ b/a.ts", "@@ -1,1 +1,2 @@", " x();", "+cache();"].join("\n") + "\n"))).not.toEqual([]);
    expect(checkSubDiff("T", orig, parseDiff(["--- a/a.ts", "+++ b/a.ts", "@@ -1,2 +1,2 @@", " w();", " x();"].join("\n") + "\n"))).not.toEqual([]);
  });
});
