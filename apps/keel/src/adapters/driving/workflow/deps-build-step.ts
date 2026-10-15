/**
 * The `deps:<install>` step's config. A deps build may install for eight
 * minutes, and its answer is data: only a call that threw is tried again. It
 * runs in keel-verify's deps box, so a keel-verify deploy cuts it as it cuts a
 * Tier 2 box, and keel's deploy a minute later can cut the retry: retries
 * one, two and four minutes apart outlast both (seven minutes).
 */
export const DEPS_BUILD_STEP = {
  retries: { limit: 3, delay: 60_000, backoff: "exponential" },
  timeout: "15 minutes",
} as const;
