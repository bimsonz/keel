import type { D1Migration } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface Env {
      /** Test-only: the D1 migrations, read on the Node side by the vitest config. */
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
