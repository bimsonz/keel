import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineProject } from "vitest/config";

/** A fresh Ed25519 signing key per test run, in the JWK form the KEEL_SIGNING_KEY secret holds. */
async function testSigningKey(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  if (!("privateKey" in pair)) throw new Error("Ed25519 did not generate a key pair");
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return JSON.stringify(Object.assign(jwk, { kid: "test" }));
}

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
        // keel-verify is another deployable; tests bind VERIFY to a fake of it.
        workers: [
          {
            name: "keel-verify",
            modules: true,
            script: `export default { fetch() { return Response.json({ fake: "keel-verify" }); } };`,
          },
        ],
      },
    })),
  ],
  test: {
    name: "pool:keel",
    include: ["test/pool/**/*.test.ts"],
    setupFiles: ["test/pool/setup.ts"],
  },
});
