import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkPublicScrub } from "../../src/guards/public-scrub.ts";

const scratch = mkdtempSync(join(tmpdir(), "keel-scrub-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** No global or system config, so the machine's own ignore rules never reach these repositories. */
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, ...args], { env: GIT_ENV, encoding: "utf8" });

// Built at run time, so this file never names a local path itself.
const LEAK = `{ "transcript": "${["", "Users", "someone", "run", "a1.jsonl"].join("/")}" }\n`;
const VACUITY = { minFiles: 1, canary: "README.md" };

/** A directory holding `files`: a git work tree that ignores `runs/` when `repository` is set. */
function tree(name: string, files: Record<string, string>, repository: boolean): string {
  const dir = join(scratch, name);
  mkdirSync(dir);
  if (repository) execFileSync("git", ["init", "-q", "-b", "main", dir], { env: GIT_ENV });
  const all = { "README.md": "# A project\n", ".gitignore": "runs/\n", ...files };
  for (const [path, text] of Object.entries(all)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  if (repository) git(dir, "add", "README.md", ".gitignore");
  return dir;
}

const leaks = (dir: string) =>
  checkPublicScrub(dir, { skip: [], vacuity: VACUITY }).violations.map(
    (v) => `${v.file}: ${v.message}`,
  );

/**
 * public-scrub reads what git would publish from a work tree, so a gitignored
 * run record never fails it, while anything tracked, or untracked and not
 * ignored, is still read. Outside a work tree, as in a `git archive` export,
 * every file is read.
 */
describe("public-scrub reads what git would publish", () => {
  it("[scrub.ignored] passes over an ignored file that names a local path", () => {
    const dir = tree("ignored", { "runs/agents.json": LEAK }, true);
    expect(leaks(dir)).toEqual([]);
  });

  it("[scrub.tracked-ignored] still reads a file forced into the index under an ignore rule", () => {
    const dir = tree("tracked-ignored", { "runs/agents.json": LEAK }, true);
    git(dir, "add", "-f", "runs/agents.json");
    expect(leaks(dir)).toEqual(["runs/agents.json: names a local filesystem path"]);
  });

  it("[scrub.untracked] reads an untracked file no rule ignores, since `git add -A` would publish it", () => {
    const dir = tree("untracked", { "notes.md": LEAK }, true);
    expect(leaks(dir)).toEqual(["notes.md: names a local filesystem path"]);
  });

  it("[scrub.repeat] names a forbidden term in every file that holds it, not only the first", () => {
    // The control fixture plants a fictional forbidden name; copied here, so this file never spells it.
    const planted = readFileSync(
      join(import.meta.dirname, "../../../../test/controls/public-scrub/README.md"),
      "utf8",
    ).replace(/^.*\/(Users|home)\/.*$/gm, "");
    const dir = tree("repeat", { "a.md": planted, "b.md": planted }, true);
    git(dir, "add", "a.md", "b.md");
    expect(leaks(dir)).toEqual([
      expect.stringMatching(/^a\.md: names the control's planted name$/),
      expect.stringMatching(/^b\.md: names the control's planted name$/),
    ]);
  });

  it("[scrub.no-git] reads every file outside a work tree, ignore rules or not", () => {
    const dir = tree("no-git", { "runs/agents.json": LEAK }, false);
    const outside = spawnSync("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], {
      env: GIT_ENV,
      encoding: "utf8",
    });
    expect(outside.status).toBe(128);
    expect(leaks(dir)).toEqual(["runs/agents.json: names a local filesystem path"]);
  });
});
