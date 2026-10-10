import type { GuardOptions, GuardResult } from "./guard.ts";
import { checkPublicScrub, PUBLIC_SCRUB } from "./guards/public-scrub.ts";

/**
 * Every guard and rule, by name. Each entry runs against a root directory; the
 * real tree passes the workspace root, a control passes `test/controls/<name>`.
 * Controls run with nothing skipped, since a control is all violation.
 */
export interface RegisteredGuard {
  readonly name: string;
  readonly run: (root: string, options?: GuardOptions) => GuardResult;
  /** The control's own canary, relative to test/controls/<name>. */
  readonly controlCanary: string;
}

export const guards: readonly RegisteredGuard[] = [
  { name: REGISTRY_PUBLIC, run: checkRegistryPublic, controlCanary: "pnpm-lock.yaml" },
  { name: PUBLIC_SCRUB, run: checkPublicScrub, controlCanary: "README.md" },
];
