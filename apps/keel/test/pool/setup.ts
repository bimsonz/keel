import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach } from "vitest";
import { drainRegistered } from "./helpers.ts";

// Storage is isolated per test file; every file starts from the migrated schema.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// Every object a case registered (drainAfter) flushes before the next case starts, and before the file ends.
afterEach(drainRegistered, 30_000);
