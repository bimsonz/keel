import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Storage is isolated per test file; every file starts from the migrated schema.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
