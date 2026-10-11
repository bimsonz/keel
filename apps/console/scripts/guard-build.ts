// Keel is a real product: the built console reads Keel and nothing else. The
// scripted scenarios exist for tests and for working on a view, and must not
// be in what is deployed, and neither must the controls that play one back.
// This reads the build and fails if any of them is.
//
//   node scripts/guard-build.ts [dist]
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Text that only a fixture, or the code that serves or plays one, contains. One line from each. */
const MARKS: [string, string][] = [
  ["Owners can revoke collaborators, effective immediately", "scenario 1"],
  ["Remove unused hooks from the permission cache", "scenario 2"],
  ["pnpm swarm --seed", "the swarm"],
  ["How a request's permissions are decided", "the fixtures' subjects"],
  ["the ruled log does not continue the one already served", "the mock source"],
  ["https://keel.town/problems/", "the stand-in Keel"],
  ["It is the\ncodebase the Keel scenarios change", "the fixtures' repository"],
  ["this fixture has no repository", "the stand-in repository"],
  // Playback moves about in a fixture's log. Keel's is followed, never played.
  ["Position in the log", "the playback controls"],
];

/** The console's own folder, wherever this is run from. */
const CONSOLE = join(import.meta.dirname, "..");

const root = process.argv[2] ?? join(CONSOLE, "dist");

function files(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

const read = files(root).filter((path) => /\.(js|mjs|html|css|json|map)$/.test(path));
const found = read.flatMap((path) => {
  const text = readFileSync(path, "utf8");
  return MARKS.filter(([mark]) => text.includes(mark)).map(([, what]) => `${path}: ${what}`);
});

// A mark that is in no fixture any more would catch nothing. Each must still be in the source it stands for.
const sources = [...files(join(CONSOLE, "src")), ...files(join(CONSOLE, "test", "fixtures"))]
  .filter((path) => /\.tsx?$/.test(path))
  .map((path) => readFileSync(path, "utf8"));
const stale = MARKS.filter(([mark]) => !sources.some((text) => text.includes(mark)));
if (stale.length > 0) {
  console.error(
    `guard-build: no source contains the mark for ${stale.map(([, what]) => what).join(", ")}, so it would catch nothing. Choose a line that is there.`,
  );
  process.exit(1);
}

// A guard that read nothing proves nothing.
if (read.length < 10) {
  console.error(`guard-build: only ${read.length} files under ${root}. Was the console built?`);
  process.exit(1);
}
if (found.length > 0) {
  console.error(
    `guard-build: something that belongs to the test fixtures is in the built console.\n  ${found.join("\n  ")}`,
  );
  process.exit(1);
}
console.log(`guard-build: ${read.length} built files read, no test fixture in any of them.`);
