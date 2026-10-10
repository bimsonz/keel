import { Glob } from "../../src/domain/kernel/index.ts";
import { fc } from "../support/fast-check.ts";

/** Few segment names, so generated paths and globs collide often: including the guard tree's `.keel/guards`. */
const segment = fc.constantFrom(
  "src",
  "lib",
  "a",
  "b",
  ".keel",
  "guards",
  "flow",
  "x.ts",
  "y.md",
  "auth",
);

/** A repository path: one to five segments. */
export const repoPath: fc.Arbitrary<string> = fc
  .array(segment, { minLength: 1, maxLength: 5 })
  .map((s) => s.join("/"));

/** A path under the guard tree. */
export const guardPath: fc.Arbitrary<string> = repoPath.map((p) => `.keel/guards/${p}`);

/** Paths a submission touches: ordinary ones, guard ones, and duplicates. */
export const touchedPaths: fc.Arbitrary<string[]> = fc.array(
  fc.oneof({ weight: 4, arbitrary: repoPath }, { weight: 1, arbitrary: guardPath }),
  { maxLength: 10 },
);

/** A glob over the same segments: literal prefixes, `*` and `**`. */
export const glob: fc.Arbitrary<Glob> = fc
  .tuple(
    fc.array(segment, { minLength: 0, maxLength: 3 }),
    fc.constantFrom("**", "*", "*.ts", "x.ts", "auth"),
  )
  .map(([prefix, last]) => Glob.make([...prefix, last].join("/")));

/** A project's protected globs: often none, sometimes several. */
export const protectedGlobs: fc.Arbitrary<Glob[]> = fc.array(glob, { maxLength: 4 });
