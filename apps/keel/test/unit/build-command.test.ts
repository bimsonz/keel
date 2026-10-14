import { describe, expect, it } from "@effect/vitest";
import {
  BUILD_PROTOCOL,
  type DepsAnswer,
  workerAppDeployPack,
} from "@keeltown/core/application/verification";
import { DeploySpec } from "@keeltown/core/domain/delivery";
import { compile, type VerificationJob } from "@keeltown/core/domain/verification";
import { CommitSha, ContentHash } from "@keeltown/core/kernel";
import { EvidenceStore, VerifierRuntime } from "@keeltown/core/ports";
import { makeBundleUrlKeys, makeEvidenceStoreMemory, sampleNamespace } from "@keeltown/testing";
import { Effect, Layer, Result, Schema } from "effect";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { BUILD_SCRIPT } from "../../src/adapters/driven/ci/build-script.ts";
import {
  buildCommand,
  type SuiteRunnerOptions,
  SuiteRuntimeCi,
  tier2RunnerFor,
} from "../../src/adapters/driven/ci/suite-runtime.ts";

const ROOT = join(import.meta.dirname, "../../../..");
/** The rolldown the box bundles with: the fixture's lockfile pins 1.2.13, and so does this repo's. */
const ROLLDOWN = (() => {
  const store = join(ROOT, "node_modules/.pnpm");
  const dir = readdirSync(store).find((name) => name === "rolldown@1.2.13");
  if (dir === undefined) throw new Error("rolldown 1.2.13 is not installed");
  return join(store, dir, "node_modules/rolldown/dist/index.mjs");
})();

const DEPLOY = Schema.decodeUnknownSync(DeploySpec)({
  target: "production",
  worker: "worker-lite",
  path: "apps/worker",
  smoke: [{ path: "/health", status: 200 }],
});
const PLAN = Result.getOrThrow(
  compile(
    undefined,
    { baseCommit: CommitSha.make("0".repeat(40)), touchedPaths: [], subjects: [], facts: {} },
    workerAppDeployPack(DEPLOY),
  ),
);
const BUILD = PLAN.steps.find((s) => s.id === "worker-app.build");
if (BUILD === undefined) throw new Error("the deploy pack has no build");

const CONFIG = `{
  // the Worker
  "name": "worker-lite",
  "main": "src/index.ts", /* its entry */
  "compatibility_date": "2026-10-01",
  "vars": { "GREETING": "hi // not a comment", }, // a trailing comma before a comment
}`;

/** A Worker in a fresh directory: an entry, a module it imports and one it imports lazily. */
const project = (files: Record<string, string>): string => {
  const dir = mkdtempSync(join(tmpdir(), "keel-build-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
};
const WORKER = {
  "wrangler.jsonc": CONFIG,
  "src/index.ts": [
    'import { greet } from "./greet.ts";',
    "export default {",
    "  async fetch(request: Request): Promise<Response> {",
    '    const { late } = await import("./late.ts");',
    "    return new Response(`${greet(new URL(request.url).pathname)} ${late}`);",
    "  },",
    "};",
  ].join("\n"),
  "src/greet.ts": "export const greet = (path: string): string => `hello from ${path}`;",
  "src/late.ts": 'export const late = "and later";',
};

/** The build script exactly as the command hands it to the box, decoded by a real sh. */
const decodedScript = (): string => {
  const line = buildCommand(DEPLOY.path)
    .split("\n")
    .find((l) => l.includes("| base64 -d >$K/build.mjs"));
  if (line === undefined) throw new Error("no decode line");
  return execFileSync("sh", ["-c", line.replace(" >$K/build.mjs", "")], { encoding: "utf8" });
};

const b64 = (bytes: Uint8Array | string): string => Buffer.from(bytes).toString("base64");

const runScript = (dir: string, config: string) => {
  const script = join(dir, "build.mjs");
  writeFileSync(script, decodedScript());
  const out = join(dir, "out", "worker.js");
  const run = spawnSync("node", [script, ROLLDOWN, join(dir, config), out], { encoding: "utf8" });
  return { status: run.status, stderr: run.stderr, out };
};

describe("the worker-app build in the box", () => {
  it("[build.script-runs] the script the command carries bundles the Worker into one module that answers as the Worker does", async () => {
    expect(decodedScript()).toBe(BUILD_SCRIPT);
    const dir = project(WORKER);
    const { status, stderr, out } = runScript(dir, "wrangler.jsonc");
    expect([status, stderr]).toEqual([0, ""]);
    expect(readdirSync(join(dir, "out"))).toEqual(["worker.js"]);
    const module: unknown = await import(pathToFileURL(out).href);
    const worker = Reflect.get(Object(module), "default");
    const answer: Response = await Reflect.get(
      worker,
      "fetch",
    )(new Request("https://preview.example/health"));
    expect(await answer.text()).toBe("hello from /health and later");
  });

  it("[build.script-refuses] a config the script cannot read exits 2 naming why, and code that does not bundle exits 1", () => {
    const toml = project({ ...WORKER, "wrangler.toml": 'name = "worker-lite"' });
    expect(runScript(toml, "wrangler.toml")).toMatchObject({
      status: 2,
      stderr: "Keel reads wrangler.jsonc or wrangler.json, not TOML yet\n",
    });
    const noMain = project({ ...WORKER, "wrangler.jsonc": '{"name": "worker-lite"}' });
    expect(runScript(noMain, "wrangler.jsonc").status).toBe(2);
    const broken = project({ ...WORKER, "src/greet.ts": "export const greet = (" });
    expect(runScript(broken, "wrangler.jsonc").status).toBe(1);
  });
});

describe("the build's runner", () => {
  const job: VerificationJob = {
    jobId: "job-1",
    bundle: Schema.decodeUnknownSync(ContentHash)(`sha256:${"b".repeat(64)}`),
    steps: [BUILD],
    fence: { batchId: "bat_1", attempt: 1, chainEpoch: 0 },
  };
  const READY: DepsAnswer = {
    _tag: "DepsReady",
    install: "1".repeat(64),
    parts: [{ sha256: "d".repeat(64), bytes: 10 }],
  };
  const MODULE = "export default { fetch() { return new Response('ok'); } };";
  const STDOUT = [
    BUILD_PROTOCOL,
    "KEEL_HYDRATION ok",
    "KEEL_DEPS ok",
    `KEEL_CONFIG wrangler.jsonc ${CONFIG.length} ${b64(CONFIG)}`,
    "KEEL_BUNDLER ok",
    "KEEL_EXIT 0",
    "KEEL_DURATION_MS 812",
    "KEEL_TAIL none",
    `KEEL_BUNDLE ${b64(gzipSync(MODULE))}`,
    "KEEL_END",
    "",
  ].join("\n");

  it.effect(
    "[build.runner-wired] a build step asks the box for its deploy spec's path, with no credential, and its pass stores the module and the facts",
    () =>
      Effect.gen(function* () {
        const keys = yield* Effect.promise(() => makeBundleUrlKeys());
        const calls: SuiteRunnerOptions[] = [];
        const store = makeEvidenceStoreMemory();
        const layer = Layer.merge(
          store.layer,
          SuiteRuntimeCi({
            runner: async (options) => {
              calls.push(options);
              return { logs: { stdout: STDOUT } };
            },
            durable: (_name, effect) => effect,
            literals: [],
            signingKey: keys.signingKey,
          }).pipe(Layer.provide(store.layer)),
        );
        const [result] = yield* Effect.gen(function* () {
          return yield* (yield* VerifierRuntime).run(sampleNamespace, job, READY);
        }).pipe(Effect.provide(layer));
        expect(tier2RunnerFor(BUILD)?.command).toBe(buildCommand("apps/worker"));
        expect(calls.map((c) => [c.name, c.command, c.cloudflareCredentials])).toEqual([
          ["worker-app.build", buildCommand("apps/worker"), false],
        ]);
        expect(calls[0]?.command).toContain("D='/workspace/apps/worker'");
        expect(result?.outcome).toBe("pass");
        const ref = Schema.decodeUnknownSync(ContentHash)(result?.resultRef);
        const document = yield* Effect.gen(function* () {
          return yield* (yield* EvidenceStore).get(sampleNamespace, ref);
        }).pipe(Effect.provide(store.layer));
        expect(document).toMatchObject({
          worker: "worker-lite",
          mainModule: "worker.js",
          facts: { compatibilityDate: "2026-10-01", vars: { GREETING: "hi // not a comment" } },
        });
        const gz = Buffer.from(String(Reflect.get(Object(document), "bundle")), "base64");
        expect(new TextDecoder().decode(gunzipSync(gz))).toBe(MODULE);
      }),
  );
});
