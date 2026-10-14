// Folds the changelog fragments in changes/unreleased/ into CHANGELOG.md.
//
// Usage: node scripts/changelog.ts                             prints the sections the next release would add
//        node scripts/changelog.ts release <version> [<date>]  writes them under "## <version> (<date>)"
//                                                              and removes the fragments it folded
//
// <date> is written as CHANGELOG.md writes it ("14 Oct 2026"); today's when omitted.
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  FRAGMENTS,
  type Fragment,
  foldFragments,
  parseFragment,
  release,
} from "../packages/tooling/src/changelog.ts";

const root = join(import.meta.dirname, "..");
const dir = join(root, FRAGMENTS);
const fragments: Fragment[] = readdirSync(dir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
  .map((entry) => ({ name: entry.name, text: readFileSync(join(dir, entry.name), "utf8") }));

const broken = fragments.flatMap((fragment) =>
  parseFragment(fragment.text).problems.map(
    (problem) => `${FRAGMENTS}/${fragment.name}:${problem.line}: ${problem.message}`,
  ),
);
if (broken.length > 0) {
  console.error(broken.join("\n"));
  process.exit(1);
}

const [command, version, date] = process.argv.slice(2);
if (command === undefined) {
  console.log(foldFragments(fragments));
} else if (command === "release" && version !== undefined) {
  const day =
    date ??
    new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  const path = join(root, "CHANGELOG.md");
  writeFileSync(path, release(readFileSync(path, "utf8"), version, day, fragments));
  for (const fragment of fragments) rmSync(join(dir, fragment.name));
  console.log(`CHANGELOG.md: ${fragments.length} fragment(s) released as ${version} (${day})`);
} else {
  console.error("usage: node scripts/changelog.ts [release <version> [<date>]]");
  process.exit(2);
}
