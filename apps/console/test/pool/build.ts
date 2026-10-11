import { execFileSync } from "node:child_process";
import { join } from "node:path";

/**
 * The Worker serves the built page, so the page is built before the Worker is
 * tested: as the deploy builds it, and not as a test would (NODE_ENV).
 */
export default function setup(): void {
  execFileSync("pnpm", ["run", "build", "--logLevel", "warn"], {
    cwd: join(import.meta.dirname, "..", ".."),
    env: { ...process.env, NODE_ENV: "production" },
    stdio: "inherit",
  });
}
