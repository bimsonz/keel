import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { makeBundleUrlKeys } from "@keeltown/testing/bundle-url-keys";
import { defineProject } from "vitest/config";

/** Where a test reads what keel-verify sent out; nothing else under `.invalid` is ever answered. */
const EGRESS_RECORD = "https://keel-egress-record.invalid/";

/** The public registry, which only a deps box's own handler fetches from. */
const REGISTRY = "registry.npmjs.org";

/** The registry path under which the stand-in answers with a redirect, and the other host the redirect names. */
const REGISTRY_MOVED = "/-/moved/";
const MOVED_TO = "https://tarballs.example/";

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
            // The one host keel-verify fetches from, for a deps box: a stand-in that answers with the request
            // it was sent, so a test reads what left. An attestation is not found, as for a package with none.
            const url = new URL(request.url);
            // Under one path the stand-in answers with a redirect to another host instead. That host is recorded
            // and denied like any other, so a redirect that was followed shows in the record as a request to it.
            if (url.hostname === REGISTRY && url.pathname.startsWith(REGISTRY_MOVED))
              return new Response("moved", {
                status: 302,
                headers: { location: MOVED_TO + url.pathname.slice(REGISTRY_MOVED.length) },
              });
            if (url.hostname === REGISTRY)
              return Response.json(
                {
                  method: request.method,
                  url: request.url,
                  headers: Object.fromEntries(request.headers),
                },
                { status: url.pathname.startsWith("/-/npm/v1/attestations/") ? 404 : 200 },
              );
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
