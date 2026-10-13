import { adminSecretsStore, applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach } from "vitest";
import { drainRegistered } from "./helpers.ts";

// Storage is isolated per test file; every file starts from the migrated schema.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// The credential store's KEK, as Terraform makes it: base64 of 32 random bytes, a fresh one per file.
// Miniflare keeps Secrets Store secrets in local storage that starts empty, so the binding has no value
// until one is created through its admin API.
{
  using admin = adminSecretsStore(env.CREDENTIAL_KEK);
  await admin.create(btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))));
}

// Every object a case registered (drainAfter) flushes before the next case starts, and before the file ends.
afterEach(drainRegistered, 30_000);
