import type { Hono } from "hono";
import type { AppEnv } from "../../../generated/http/runtime.gen.ts";

/**
 * Keel's allowed-signers file: every key Keel signs or has signed commits
 * with. Outside /v1, at an address that never moves, and open to anyone: a
 * reader saves it, names it as git's `gpg.ssh.allowedSignersFile`, and
 * `git verify-commit` then checks any commit Keel landed.
 */
export const SIGNERS_PATH = "/.well-known/keel/allowed-signers";

/** How long a copy may be reused: a rotation adds a key before it signs, so a short-lived copy is never wrong. */
const MAX_AGE_SECONDS = 300;

export function registerSigners(app: Hono<AppEnv>, signers: () => string): void {
  app.get(SIGNERS_PATH, (c) =>
    c.text(signers(), 200, { "cache-control": `public, max-age=${MAX_AGE_SECONDS}` }),
  );
}
