import { describe, expect, it } from "vitest";
import { commentText, leaks, normalise, type LeakInput } from "../src/leak.ts";

const base = (over: Partial<LeakInput> & { diff: string; language?: string }): LeakInput => ({
  id: "P01",
  predicate: over.predicate ?? "freshness",
  effect: over.effect ?? "per-session",
  subject: over.subject ?? "authz.permission-evaluation",
  scope: over.scope ?? "service:forge-lite",
  hunks: [{ file: "src/x.ts", language: over.language ?? "typescript", diff: over.diff }],
  symbols: over.symbols ?? [],
});

const CACHE = [
  "--- a/src/authz/cache.ts",
  "+++ b/src/authz/cache.ts",
  "@@ -1,3 +1,4 @@",
  "+const roles = new Map<string, Role>();",
  " export function get(sessionId: string, repoId: string) {",
  "   return roles.get(sessionId + \":\" + repoId);",
  " }",
].join("\n");

describe("leak check", () => {
  it("passes code that only shows the mechanism", () => {
    expect(leaks(base({ diff: CACHE }))).toEqual([]);
  });
  it("fails a planted comment that names the answer", () => {
    const planted = CACHE.replace("+const roles", "+// Per-session cache of evaluated roles.\n+const roles");
    expect(leaks(base({ diff: planted }))).toEqual([
      'P01: state contains the ground-truth value "per-session"',
      'P01: state contains "session cache", a synonym of per-session',
    ]);
  });
  it("fails a lattice id in any spelling, including identifiers", () => {
    expect(leaks(base({ diff: CACHE.replaceAll("roles", "perSessionRoles") }))).not.toEqual([]);
    expect(leaks(base({ diff: CACHE.replaceAll("roles", "PER_SESSION_ROLES") }))).not.toEqual([]);
  });
  it("fails a synonym in the scope", () => {
    expect(leaks(base({ diff: CACHE, scope: "service:forge-lite (until logout)" }))).toEqual([
      'P01: state contains "until logout", a synonym of per-session',
    ]);
  });
  it("allows code-native words in code but not in comments", () => {
    const go = ["--- a/t.go", "+++ b/t.go", "@@ -1 +1 @@", "-    ID int64 `json:\"id\"`", "+    ID string `json:\"id\"`"].join("\n");
    expect(leaks(base({ predicate: "shape", effect: "string", diff: go, language: "go" }))).toEqual([]);
    const commented = go + "\n+    // now a string";
    expect(leaks(base({ predicate: "shape", effect: "string", diff: commented, language: "go" }))).not.toEqual([]);
  });
  it("fails a comment that states the bound", () => {
    const ts = ["--- a/p.ts", "+++ b/p.ts", "@@ -1 +1 @@", "-const MAX = 50;", "+// at most 1,000 rows", "+const MAX = 1000;"].join("\n");
    expect(leaks(base({ predicate: "bound", effect: "le-1k", diff: ts }))).toEqual(['P01: comment/question states the bound ("at most 1,000")']);
  });
  it("extracts comments by language and ignores comment markers in strings", () => {
    expect(commentText(["+x = \"#not\"  # yes", "+\"\"\"doc", "+string\"\"\""].join("\n"), "python")).toBe("# yes\ndoc\nstring");
    expect(commentText(["+const u = \"http://x\"; // c", "+/* a", "+ b */"].join("\n"), "typescript")).toBe("// c\n a\n b ");
    expect(normalise("perSessionCache PER_SESSION per-session")).toBe(" per session cache per session per session ");
  });
});
