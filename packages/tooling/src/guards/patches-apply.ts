import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { type GuardOptions, type GuardResult, type Violation, withVacuityCheck } from "../guard.ts";

export const PATCHES_APPLY = "patches-apply";

/** Where the seeded wrong implementations live (AGENTS.md § Proving a check). */
const MUTANTS = "test/mutants";

/** One check is one git process and there are thousands of patches: this many run at once. */
const AT_ONCE = 8;

interface GitExit {
  readonly status: number;
  readonly stderr: string;
}

/**
 * Runs git in `root` and nowhere above it. Left to walk upward, git finds the
 * repository a control folder sits in, reads a patch's paths from that
 * repository's top, skips every path outside the folder and exits 0: a patch
 * that cannot apply reads as one that does. The ceiling ends the walk at
 * `root`, so a root that is no repository of its own is read as plain files.
 * A git that cannot be run at all rejects.
 */
function git(root: string, args: readonly string[]): Promise<GitExit> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...args],
      { cwd: root, env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(root) } },
      (error, _stdout, stderr) => {
        if (error === null) resolve({ status: 0, stderr });
        else if (typeof error.code === "number") resolve({ status: error.code, stderr });
        else reject(error);
      },
    );
  });
}

/**
 * Whether `root` is a work tree of its own (a clone, a worktree, CI's
 * checkout) or plain files (a `git archive` export, a control). Any other
 * answer from git throws, so the guard never reads the wrong thing because
 * git broke.
 */
async function isRepository(root: string): Promise<boolean> {
  const asked = await git(root, ["rev-parse", "--is-inside-work-tree"]);
  if (asked.status === 0) return true;
  if (asked.status === 128 && /not a git repository/.test(asked.stderr)) return false;
  throw new Error(`git rev-parse failed in ${root}: ${asked.stderr.trim()}`);
}

/** `task` over every item, `AT_ONCE` at a time, the answers in the items' order. */
async function eachOf<T, R>(items: readonly T[], task: (item: T) => Promise<R>): Promise<R[]> {
  const answers: R[] = [];
  const queue = items.entries();
  const worker = async (): Promise<void> => {
    const next = queue.next();
    if (next.done === true) return;
    const [index, item] = next.value;
    answers[index] = await task(item);
    await worker();
  };
  await Promise.all(Array.from({ length: AT_ONCE }, () => worker()));
  return answers;
}

/**
 * Every mutant patch still applies. A patch whose lines have moved under it is
 * never run again, so the check it once proved red is proved by nothing, and
 * nobody is told: whoever moves the lines makes the patch again as the same
 * edit (AGENTS.md § Proving a check).
 *
 * In a repository a patch is checked against the index, not the working tree.
 * `prove:red` applies a mutant to the working tree and then runs its command;
 * read from the tree, that mutant's own patch no longer applies, and every
 * proof whose command runs the guards would go red by this guard alone,
 * whatever its own check says. The index stays the committed tree throughout.
 * Outside a repository there is no index, and the files are what was committed.
 */
export async function checkPatchesApply(
  root: string,
  options: GuardOptions = {},
): Promise<GuardResult> {
  const scanned = existsSync(join(root, MUTANTS))
    ? readdirSync(join(root, MUTANTS))
        .filter((name) => name.endsWith(".patch"))
        .toSorted()
        .map((name) => `${MUTANTS}/${name}`)
    : [];
  const against = scanned.length > 0 && (await isRepository(root)) ? ["--cached"] : [];
  const refused = await eachOf(scanned, async (file): Promise<Violation[]> => {
    const applied = await git(root, ["apply", "--check", ...against, file]);
    if (applied.status === 0) return [];
    const said =
      applied.stderr.split("\n").find((line) => line.trim() !== "") ?? "git said nothing";
    return [
      {
        rule: PATCHES_APPLY,
        file,
        message: `does not apply: ${said.replace(/^(?:error|fatal): /, "")}`,
      },
    ];
  });
  return withVacuityCheck(
    PATCHES_APPLY,
    scanned,
    refused.flat(),
    options.vacuity ?? {
      minFiles: 100,
      canary: `${MUTANTS}/domain-patches-apply-passes-whatever-git-says.patch`,
    },
  );
}
