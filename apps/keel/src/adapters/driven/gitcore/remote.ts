import type { GitRemote } from "@keeltown/gitcore";

/**
 * How long one git HTTP request, to Artifacts or to an upstream, may run with
 * its body before it is aborted. The slowest seen is a 17 MB import relay's
 * pack, 55–64 s (13 Oct); this is about twice that. Unbounded, a request that
 * never answers holds whatever waits on it: on 15 Oct a mirror sync hung
 * 408 s on Artifacts' git and held trunk's promotion behind it.
 */
export const GIT_HTTP_DEADLINE_MS = 120_000;

/** A git remote as Keel calls it: every request to it bounded by `GIT_HTTP_DEADLINE_MS`. */
export const gitRemote = (url: string, token?: string): GitRemote => ({
  url,
  ...(token === undefined ? {} : { token }),
  deadlineMs: GIT_HTTP_DEADLINE_MS,
});
