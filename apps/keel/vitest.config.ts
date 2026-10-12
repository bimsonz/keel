import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineProject } from "vitest/config";

/** A fresh Ed25519 signing key per test run, in the JWK form the KEEL_SIGNING_KEY secret holds. */
async function testSigningKey(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  if (!("privateKey" in pair)) throw new Error("Ed25519 did not generate a key pair");
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return JSON.stringify(Object.assign(jwk, { kid: "test" }));
}

/** The pool's claim code, and its digest as deploy.ts derives KEEL_CLAIM_DIGEST from Terraform's. */
const claimCode = `test-claim-${crypto.randomUUID()}`;
const claimDigest = createHash("sha256").update(claimCode).digest("hex");

/** The fake Artifacts namespace, typechecked as TypeScript and served as plain JavaScript. */
const fakeArtifacts = stripTypeScriptTypes(
  readFileSync(`${import.meta.dirname}/test/pool/fake-artifacts.worker.ts`, "utf8"),
);

export default defineProject({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      remoteBindings: false,
      miniflare: {
        bindings: {
          KEEL_ENV: "test",
          KEEL_SIGNING_KEY: await testSigningKey(),
          KEEL_BOOTSTRAP_SECRET: `test-bootstrap-${crypto.randomUUID()}`,
          BETTER_AUTH_SECRET: `test-auth-${crypto.randomUUID()}`,
          KEEL_CLAIM_DIGEST: claimDigest,
          // Test-only: the claim code itself, which no deployed Worker holds.
          TEST_CLAIM_CODE: claimCode,
          TEST_MIGRATIONS: await readD1Migrations(`${import.meta.dirname}/migrations`),
          // prove:red pins fast-check's seed; workerd sees it only as a binding.
          ...(process.env["FC_SEED"] === undefined ? {} : { FC_SEED: process.env["FC_SEED"] }),
        },
        // Artifacts has no local simulator, and miniflare binds WORKSPACES to the remote proxy
        // whatever is set here. Composition serves keel-ws-00 from TEST_ARTIFACTS when it is
        // bound, so the real CodeHost adapter runs inside the WorkspacePool DO against a fake.
        serviceBindings: { TEST_ARTIFACTS: "fake-artifacts" },
        // keel-verify is another deployable; tests bind VERIFIER to a fake of it.
        workers: [
          {
            name: "fake-artifacts",
            modules: true,
            compatibilityDate: "2026-10-01",
            script: fakeArtifacts,
          },
          {
            name: "keel-verify",
            modules: true,
            compatibilityDate: "2026-10-01",
            script: [
              `import { DurableObject } from "cloudflare:workers";`,
              `export class KeelSandbox extends DurableObject {}`,
              `export default { fetch() { return Response.json({ fake: "keel-verify" }); } };`,
            ].join("\n"),
            durableObjects: { SANDBOX: { className: "KeelSandbox", useSQLite: true } },
          },
        ],
      },
    })),
  ],
  test: {
    name: "pool:keel",
    include: ["test/pool/**/*.test.ts"],
    // The first test in a pool pays workerd's cold module load (the sandbox SDK alone is ~3.5 s).
    testTimeout: 30_000,
    setupFiles: ["test/pool/setup.ts"],
  },
});
