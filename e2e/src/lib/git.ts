import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * System git, as an agent's harness runs it: no global or system config, and
 * the workspace token only in an Authorization header set through GIT_CONFIG_*,
 * so it is never in argv, a remote URL or .git/config.
 */
export function git(cwd: string, args: readonly string[], token?: string): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      ...(token === undefined
        ? {}
        : {
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "http.extraHeader",
            GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
          }),
    },
  }).trim();
}

/** A clone of a workspace, in a scratch directory of its own. */
export function cloneWorkspace(remote: string, token: string): string {
  const dir = mkdtempSync(join(tmpdir(), "keel-s0-"));
  git(dir, ["clone", "-q", remote, "."], token);
  return dir;
}

/** Commits everything as `author`, pushes the workspace's main and answers the commit. */
export function commitAndPush(dir: string, token: string, author: string, message: string): string {
  const identity = ["-c", `user.name=${author}`, "-c", `user.email=${author}@agents.keel.invalid`];
  git(dir, ["add", "-A"]);
  git(dir, [...identity, "commit", "-q", "-m", message]);
  git(dir, ["push", "-q", "origin", "HEAD:refs/heads/main"], token);
  return git(dir, ["rev-parse", "HEAD"]);
}
