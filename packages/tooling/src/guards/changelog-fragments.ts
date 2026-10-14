import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { FRAGMENTS, parseFragment } from "../changelog.ts";
import { type GuardOptions, type GuardResult, type Violation, withVacuityCheck } from "../guard.ts";
import { read } from "../scan.ts";

export const CHANGELOG_FRAGMENTS = "changelog-fragments";

/**
 * A change describes itself in a fragment under `changes/unreleased/`, never
 * in CHANGELOG.md, whose `## Unreleased` section stays empty until a release
 * folds the fragments in: two changes that each add a line there conflict
 * when they are composed together. Every fragment must also read as one
 * (`parseFragment`), so a release folds all of them.
 */
export function checkChangelogFragments(root: string, options: GuardOptions = {}): GuardResult {
  const violations: Violation[] = [];
  const scanned: string[] = [];
  const rule = CHANGELOG_FRAGMENTS;
  if (existsSync(join(root, "CHANGELOG.md"))) {
    scanned.push("CHANGELOG.md");
    const lines = read(root, "CHANGELOG.md").split("\n");
    const at = lines.indexOf("## Unreleased");
    if (at < 0)
      violations.push({
        rule,
        file: "CHANGELOG.md",
        message: 'has no "## Unreleased" heading for a release to fold the fragments under',
      });
    const end = lines.findIndex((text, index) => index > at && text.startsWith("## "));
    const unreleased = at < 0 ? [] : lines.slice(at + 1, end < 0 ? lines.length : end);
    unreleased.forEach((text, offset) => {
      if (text.trim() !== "")
        violations.push({
          rule,
          file: "CHANGELOG.md",
          line: at + 2 + offset,
          message: `the Unreleased section holds an entry: write it as a fragment in ${FRAGMENTS}/ instead (changes/README.md)`,
        });
    });
  }
  const dir = join(root, FRAGMENTS);
  for (const name of existsSync(dir) ? readdirSync(dir).toSorted() : []) {
    const file = `${FRAGMENTS}/${name}`;
    scanned.push(file);
    if (!name.endsWith(".md")) {
      violations.push({ rule, file, message: "is not a fragment: a fragment is a .md file" });
      continue;
    }
    for (const problem of parseFragment(read(root, file)).problems)
      violations.push({ rule, file, line: problem.line, message: problem.message });
  }
  return withVacuityCheck(
    rule,
    scanned,
    violations,
    options.vacuity ?? { minFiles: 1, canary: "CHANGELOG.md" },
  );
}
