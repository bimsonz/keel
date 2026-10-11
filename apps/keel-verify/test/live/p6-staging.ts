// A live series on staging: template-first probe drafting end to end, on
// the composition the Probe Workflow uses. apps/keel/test/live/p6-driver.ts,
// run locally by wrangler with remote bindings, runs core's draftProbe on
// keel's probeDraftingLayer: the pinned model through Workers AI, drafted
// probes into the bundle bucket, and the world matrix on staging keel-verify's
// VerifierDOs. Nothing is faked.
//
//   CLOUDFLARE_ACCOUNT_ID=… node apps/keel-verify/test/live/p6-staging.ts [drafts]
//
// It refuses a dirty tree, and reports the commit it ran, the pins (read from
// keel's committed wrangler.jsonc), keel-verify's version before and after,
// and per draft the outcome, attempts, the model each call was served by,
// and the wall time. The bar is at least 8 of 10 admitted (S26).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MATRIX_WORLDS } from "@keeltown/core/application/verification";
import { type BundleFile, depsNeed, sha256Hex, writeBundle } from "@keeltown/runner-protocol";
import { unstable_readConfig, unstable_startWorker } from "wrangler";
import { FIXTURE, s1Worlds } from "./s1-worlds.ts";

const REPO = join(import.meta.dirname, "../../../..");
const KEEL = join(REPO, "apps/keel");
const drafts = Number(process.argv[2] ?? 10);

const git = (...args: string[]) =>
  execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8" }).trim();
if (git("status", "--porcelain") !== "")
  throw new Error("the tree is dirty: the series runs only from a clean committed tree");
const commit = git("rev-parse", "HEAD");

/** keel's own pins, from its committed config: the series runs exactly what keel would. */
const pins: unknown = unstable_readConfig({ config: join(KEEL, "wrangler.jsonc") }).vars[
  "PLATFORM_FUNCTION_PINS"
];

/** keel-verify's deployed version, newest first, as wrangler lists it. */
const keelVerifyVersion = (): unknown => {
  const listed: unknown = JSON.parse(
    execFileSync(
      "pnpm",
      ["exec", "wrangler", "deployments", "list", "--name", "keel-verify", "--json"],
      {
        cwd: KEEL,
        encoding: "utf8",
        env: { ...process.env, npm_config_userconfig: "/dev/null" },
      },
    ),
  );
  const newest: unknown = Array.isArray(listed) ? listed.at(-1) : undefined;
  return {
    created: Reflect.get(Object(newest), "created_on"),
    versions: Reflect.get(Object(newest), "versions"),
  };
};

/** S-1's disagreement: A relies on freshness at most per-request; B makes it per-session. */
const proposition = (relation: string, value: string) => ({
  subject: "authz.permission-evaluation",
  predicate: "freshness",
  relation,
  value,
});
const fixtureFile = (path: string) => readFileSync(join(FIXTURE, path), "utf8");
const context = {
  premise: proposition("at-most", "per-request"),
  effect: proposition("is", "per-session"),
  anchors: [
    "src/authz/require-permission.ts requirePermission",
    "src/routes/collaborators.ts store.removeCollaborator",
  ],
  source: git("ls-files", "fixtures/forge-lite/src")
    .split("\n")
    .filter((p) => p.length > 0)
    .map((p) => ({
      path: p.slice("fixtures/forge-lite/".length),
      text: readFileSync(join(REPO, p), "utf8"),
    })),
  hunks: { A: fixtureFile("scenarios/s1/a.patch"), B: fixtureFile("scenarios/s1/b.patch") },
};

const driver = await unstable_startWorker({
  config: join(KEEL, "test/live/p6-driver.wrangler.jsonc"),
  dev: { server: { port: 0 }, inspector: false },
});
await driver.ready;

const call = (path: string, init: Parameters<typeof driver.fetch>[1]) =>
  driver.fetch(`http://driver${path}`, init);
const has = async (key: string) => (await call(`/r2/${key}`, { method: "HEAD" })).status === 200;

/** Puts files as a content-addressed bundle at `bundles/<hex>` unless the bucket holds it already. */
const put = async (files: readonly BundleFile[]): Promise<string> => {
  const bytes = await writeBundle(files);
  const hex = await sha256Hex(bytes);
  if (!(await has(`bundles/${hex}`)))
    await call(`/r2/bundles/${hex}`, { method: "PUT", body: Buffer.from(bytes) });
  return `sha256:${hex}`;
};

const percentile = (values: readonly number[], p: number) =>
  values.toSorted((a, b) => a - b)[
    Math.min(values.length - 1, Math.ceil((p / 100) * values.length) - 1)
  ];

try {
  const before = keelVerifyVersion();
  const built = s1Worlds();
  const need = await depsNeed(built.trunk);
  if (need._tag === "lockfile" && !(await has(`deps/${need.sha256}`)))
    throw new Error(
      `no deps/${need.sha256}: run deps-bundle.ts fixtures/forge-lite --upload first`,
    );
  const worlds: Record<string, string> = {};
  // oxlint-disable-next-line no-await-in-loop -- five uploads, each skipped when the bucket has it
  for (const world of MATRIX_WORLDS) worlds[world] = await put(built[world]);
  console.log(JSON.stringify({ commit, pins, keelVerifyBefore: before, worlds }));

  const results: { outcome: string; attempts: number; ms: number }[] = [];
  for (let n = 1; n <= drafts; n++) {
    // oxlint-disable-next-line no-await-in-loop -- one draft after another, as the series is specified
    const response = await call("/draft", {
      method: "POST",
      body: JSON.stringify({ pins, context, worlds }),
    });
    // oxlint-disable-next-line no-await-in-loop -- the draft's own answer
    const body: unknown = await response.json();
    const outcome: unknown = Reflect.get(Object(body), "outcome");
    const tag = String(Reflect.get(Object(outcome), "_tag") ?? "error");
    const attempts = Number(Reflect.get(Object(outcome), "attempts") ?? 0);
    const ms = Number(Reflect.get(Object(body), "ms") ?? 0);
    results.push({ outcome: tag, attempts, ms });
    console.log(
      JSON.stringify({
        draft: n,
        outcome: tag,
        reason: Reflect.get(Object(outcome), "reason"),
        attempts,
        served: Reflect.get(Object(body), "served"),
        ms,
        feedback: Reflect.get(Object(outcome), "feedback"),
        probe: Reflect.get(Object(outcome), "probe"),
        error: Reflect.get(Object(body), "error"),
      }),
    );
  }
  const admitted = results.filter((r) => r.outcome === "Admitted").length;
  const ms = results.map((r) => r.ms);
  console.log(
    JSON.stringify({
      summary: {
        commit,
        admitted: `${admitted}/${results.length}`,
        bar: "at least 8 of 10",
        meetsBar: results.length > 0 && admitted >= Math.ceil(0.8 * results.length),
        outcomes: Object.fromEntries(
          [...new Set(results.map((r) => r.outcome))].map((o) => [
            o,
            results.filter((r) => r.outcome === o).length,
          ]),
        ),
        attempts: results.map((r) => r.attempts),
        wallMs: { p50: percentile(ms, 50), p90: percentile(ms, 90), max: percentile(ms, 100) },
        keelVerifyAfter: keelVerifyVersion(),
      },
    }),
  );
} finally {
  await driver.dispose();
}
