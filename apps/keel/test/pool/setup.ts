import { adminSecretsStore, applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach } from "vitest";
import { CLIENT_SECRET, drainRegistered } from "./helpers.ts";

// Storage is isolated per test file; every file starts from the migrated schema.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// The credential store's KEK, as Terraform makes it: base64 of 32 random bytes, a fresh one per file.
// Miniflare keeps Secrets Store secrets in local storage that starts empty, so the binding has no value
// until one is created through its admin API.
{
  using admin = adminSecretsStore(env.CREDENTIAL_KEK);
  await admin.create(btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))));
}

// The OAuth client's secret (CLIENT_SECRET), which Cloudflare issues when the client is registered.
{
  using admin = adminSecretsStore(env.CF_OAUTH_CLIENT_SECRET);
  await admin.create(CLIENT_SECRET);
}

// The Worker loads its HTTP side on the first request (src/index.ts). Here every module is transformed as it is
// first asked for, which then takes longer than a case may: load it with the file instead, as the Worker did before.
await import("../../src/composition/isolate.ts");

// Every object a case registered (drainAfter) flushes before the next case starts, and before the file ends.
afterEach(drainRegistered, 30_000);
