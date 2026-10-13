import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { makeBundleUrlKeys } from "@keeltown/testing/bundle-url-keys";
import { makeCommitSigningKeys } from "@keeltown/testing/commit-signing-keys";
import { Exit } from "effect";
import { defineProject } from "vitest/config";
import { encodeExit, VerifierCodecs } from "../keel-verify/src/rpc/index.ts";

/** A fresh Ed25519 signing key per test run, in the JWK form the KEEL_SIGNING_KEY secret holds. */
async function testSigningKey(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  if (!("privateKey" in pair)) throw new Error("Ed25519 did not generate a key pair");
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return JSON.stringify(Object.assign(jwk, { kid: "test" }));
}

/**
 * The fake keel-verify's answers to `worldReady`, in keel-verify's own
 * encoding: every world is ready but the one whose bundle hash is all d's,
 * which has no deps bundle for its lockfile.
 */
const worldReadiness = {
  ready: JSON.stringify(encodeExit(VerifierCodecs.worldReady, Exit.succeed({ _tag: "Ready" }))),
  unready: JSON.stringify(
    encodeExit(
      VerifierCodecs.worldReady,
      Exit.succeed({
        _tag: "Unready",
        reason: "lockfile-diverged: no deps bundle for pnpm-lock.yaml 0ddba11",
      }),
    ),
  ),
};

/** The fake Artifacts namespace, typechecked as TypeScript and served as plain JavaScript. */
const fakeArtifacts = stripTypeScriptTypes(
  readFileSync(`${import.meta.dirname}/test/pool/fake-artifacts.worker.ts`, "utf8"),
);

export default defineProject({
  plugins: [
    cloudflareTest(async () => {
      // A fresh commit-signing key per run, with the signers setting that vouches for it.
      const commitSigning = await makeCommitSigningKeys();
      return {
        wrangler: { configPath: "./wrangler.jsonc" },
        remoteBindings: false,
        miniflare: {
          bindings: {
            KEEL_ENV: "test",
            KEEL_SIGNING_KEY: await testSigningKey(),
            BETTER_AUTH_SECRET: `test-auth-${crypto.randomUUID()}`,
            BUNDLE_URL_SIGNING_KEY: (await makeBundleUrlKeys()).signingKey,
            KEEL_COMMIT_SIGNING_KEY: commitSigning.signingKey,
            KEEL_COMMIT_SIGNERS: commitSigning.signers,
            TEST_MIGRATIONS: await readD1Migrations(`${import.meta.dirname}/migrations`),
            // prove:red pins fast-check's seed; workerd sees it only as a binding.
            ...(process.env["FC_SEED"] === undefined ? {} : { FC_SEED: process.env["FC_SEED"] }),
          },
          // Artifacts has no local simulator, and miniflare binds WORKSPACES to the remote proxy
          // whatever is set here. Composition serves keel-ws-00 from TEST_ARTIFACTS when it is
          // bound, so the real CodeHost adapter runs inside the WorkspacePool DO against a fake.
          serviceBindings: { TEST_ARTIFACTS: "fake-artifacts" },
          // An empty database beside DB, for running a migration over rows written before it.
          d1Databases: { TEST_BACKFILL_DB: "keel-backfill" },
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
                `import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";`,
                `export class KeelSandbox extends DurableObject {}`,
                `export default class extends WorkerEntrypoint {`,
                `  fetch() { return Response.json({ fake: "keel-verify" }); }`,
                `  worldReady(request) {`,
                `    return request.worldBundle === "sha256:" + "d".repeat(64)`,
                `      ? ${worldReadiness.unready}`,
                `      : ${worldReadiness.ready};`,
                `  }`,
                `}`,
              ].join("\n"),
              durableObjects: { SANDBOX: { className: "KeelSandbox", useSQLite: true } },
            },
          ],
        },
      };
    }),
  ],
  test: {
    name: "pool:keel",
    include: ["test/pool/**/*.test.ts"],
    // The first test in a pool pays workerd's cold module load (the sandbox SDK alone is ~3.5 s).
    testTimeout: 30_000,
    setupFiles: ["test/pool/setup.ts"],
  },
});
