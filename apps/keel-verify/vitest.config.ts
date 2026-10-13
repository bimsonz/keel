import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { makeBundleUrlKeys } from "@keeltown/testing/bundle-url-keys";
import { defineProject } from "vitest/config";

/** Where a test reads what keel-verify sent out; nothing else under `.invalid` is ever answered. */
const EGRESS_RECORD = "https://keel-egress-record.invalid/";

/** Every outbound request keel-verify (and its VerifierDOs) made, in order. */
const egress: string[] = [];

export default defineProject({
  plugins: [
    cloudflareTest(async () => {
      // A fresh pair per run: the bundle host verifies with the public half, and a test signs with the other.
      const keys = await makeBundleUrlKeys();
      return {
        wrangler: { configPath: "./wrangler.jsonc" },
        remoteBindings: false,
        miniflare: {
          bindings: {
            BUNDLE_URL_PUBLIC_KEY: keys.publicKey,
            TEST_BUNDLE_URL_SIGNING_KEY: keys.signingKey,
          },
          // keel-verify reaches nothing in a test: every outbound request is recorded and denied, so a test can
          // prove at the network itself that bundling a probe never fetches (worker-bundler can install from npm).
          outboundService: (request: Request) => {
            if (request.url === EGRESS_RECORD) return Response.json(egress);
            egress.push(`${request.method} ${request.url}`);
            return new Response("keel-verify has no outbound network in tests", { status: 599 });
          },
        },
      };
    }),
  ],
  test: {
    name: "pool:keel-verify",
    include: ["test/pool/**/*.test.ts"],
    // The first test in a pool pays workerd's cold module load (the sandbox SDK alone is ~3.5 s),
    // which reached 28–30 s on a loaded machine (10 Oct, load average ~400).
    testTimeout: 60_000,
  },
});
