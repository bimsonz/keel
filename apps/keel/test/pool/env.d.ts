import type { D1Migration } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface Env {
      /** Test-only: the D1 migrations, read on the Node side by the vitest config. */
      TEST_MIGRATIONS: D1Migration[];
      /** Test-only: the fake Artifacts namespace composition serves keel-ws-00 from (see composition/do.ts). */
      TEST_ARTIFACTS?: Artifacts;
    }
  }
}
