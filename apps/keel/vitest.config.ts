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
          TEST_MIGRATIONS: await readD1Migrations(`${import.meta.dirname}/migrations`),
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
