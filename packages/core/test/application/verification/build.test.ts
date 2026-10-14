import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  BUILD_BUNDLE_LIMIT,
  BUILD_CONFIG_LIMIT,
  BUILD_PROTOCOL,
  type BuildOutput,
  judgeBuild,
  parseBuildOutput,
  workerAppDeployPack,
} from "../../../src/application/verification/index.ts";
import { DeploySpec } from "../../../src/domain/delivery/index.ts";
import { CommitSha } from "../../../src/domain/kernel/index.ts";
import { compile } from "../../../src/domain/verification/index.ts";

const DEPLOY = Schema.decodeUnknownSync(DeploySpec)({
  target: "production",
  worker: "worker-lite",
  path: "apps/worker",
  smoke: [{ path: "/health", status: 200 }],
});
const plan = Result.getOrThrow(
  compile(
    undefined,
    { baseCommit: CommitSha.make("0".repeat(40)), touchedPaths: [], subjects: [], facts: {} },
    workerAppDeployPack(DEPLOY),
  ),
);
const step = plan.steps.find((s) => s.id === "worker-app.build");
if (step === undefined) throw new Error("the deploy pack has no build");

const b64 = (text: string): string => btoa(text);
const CONFIG = `{
  // the Worker
  "name": "worker-lite",
  "main": "src/index.ts",
  "compatibility_date": "2026-10-01",
  "compatibility_flags": ["nodejs_compat"],
  "vars": { "GREETING": "hi" },
}`;

/** A runner's stdout, built the way the build command prints it. */
const stdout = (fields: Record<string, string>, extra: readonly string[] = []) =>
  [
    "some console line the box printed",
    BUILD_PROTOCOL,
    ...Object.entries(fields).map(([k, v]) => `${k} ${v}`),
    ...extra,
    "KEEL_END",
    "",
  ].join("\n");

const ran = (over: Record<string, string> = {}): Record<string, string> => ({
  KEEL_HYDRATION: "ok",
  KEEL_DEPS: "ok",
  KEEL_CONFIG: `wrangler.jsonc ${CONFIG.length} ${b64(CONFIG)}`,
  KEEL_BUNDLER: "ok",
  KEEL_EXIT: "0",
  KEEL_DURATION_MS: "900",
  KEEL_TAIL: b64("built in 40ms"),
  KEEL_BUNDLE: "H4sIAAAA",
  ...over,
});

const judged = (output: BuildOutput, config: string | undefined) => {
  const j = judgeBuild(step, output, { config, tail: "" });
  return [j.report.outcome, j.evidence.why];
};

const ranOutput = (over: Partial<Extract<BuildOutput, { _tag: "ran" }>> = {}): BuildOutput => ({
  _tag: "ran",
  config: { file: "wrangler.jsonc", bytes: CONFIG.length, text: b64(CONFIG) },
  exit: 0,
  durationMs: 900,
  bundle: { _tag: "module", gzip: "H4sIAAAA" },
  ...over,
});

describe("the worker-app build's report", () => {
  it("[build.parse] reads one well-formed run, its stops, and nothing else", () => {
    expect(parseBuildOutput(stdout(ran()))).toEqual({
      _tag: "ran",
      config: { file: "wrangler.jsonc", bytes: CONFIG.length, text: b64(CONFIG) },
      exit: 0,
      durationMs: 900,
      tail: b64("built in 40ms"),
      bundle: { _tag: "module", gzip: "H4sIAAAA" },
    });
    expect(parseBuildOutput(stdout(ran({ KEEL_BUNDLE: "too-large 200000" })))).toMatchObject({
      bundle: { _tag: "too-large", bytes: 200_000 },
    });
    expect(parseBuildOutput(stdout(ran({ KEEL_BUNDLE: "none", KEEL_TAIL: "none" })))).toMatchObject(
      { bundle: { _tag: "none" } },
    );
    expect(
      parseBuildOutput(stdout({ KEEL_HYDRATION: "ok", KEEL_DEPS: "ok", KEEL_CONFIG: "none" })),
    ).toEqual({ _tag: "no-config" });
    const {
      KEEL_EXIT: _e,
      KEEL_DURATION_MS: _d,
      KEEL_TAIL: _t,
      KEEL_BUNDLE: _b,
      ...upToBundler
    } = ran({ KEEL_BUNDLER: "none" });
    expect(parseBuildOutput(stdout(upToBundler))).toEqual({ _tag: "no-bundler" });
    const malformed: readonly (readonly [string, string])[] = [
      ["no report", ran().KEEL_CONFIG ?? ""],
      ["no config marker", stdout({ ...ran(), KEEL_CONFIG: "" })],
      [
        "a config file Keel does not read",
        stdout(ran({ KEEL_CONFIG: `package.json 2 ${b64("{}")}` })),
      ],
      ["a config that is not base64", stdout(ran({ KEEL_CONFIG: "wrangler.jsonc 2 {}" }))],
      [
        "a config with a fourth word",
        stdout(ran({ KEEL_CONFIG: `wrangler.jsonc 2 ${b64("{}")} x` })),
      ],
      ["no bundler marker", stdout(ran({ KEEL_BUNDLER: "" }))],
      ["a bundle that is not base64", stdout(ran({ KEEL_BUNDLE: "not base64!" }))],
      ["a tail that is not base64", stdout(ran({ KEEL_TAIL: "not base64!" }))],
      ["a second bundle", stdout(ran(), ["KEEL_BUNDLE H4sIBBBB"])],
      ["no end", stdout(ran()).replace("KEEL_END\n", "")],
    ];
    expect(malformed.map(([name, out]) => [name, parseBuildOutput(out)._tag])).toEqual(
      malformed.map(([name]) => [name, "malformed"]),
    );
  });

  it("[build.judge] passes with the module and the facts the preview uploads, fails what the change broke, and abstains on what Keel cannot carry", () => {
    const cases: readonly (readonly [string, BuildOutput, string | undefined, string, string])[] = [
      [
        "no config",
        { _tag: "no-config" },
        CONFIG,
        "fail",
        "no wrangler.jsonc or wrangler.json at apps/worker",
      ],
      [
        "no entry",
        ranOutput(),
        CONFIG.replace('"main": "src/index.ts",', ""),
        "fail",
        "wrangler.jsonc has no usable main",
      ],
      ["unreadable", ranOutput(), "{", "fail", "wrangler.jsonc: "],
      [
        "another Worker",
        ranOutput(),
        CONFIG.replace('"worker-lite"', '"billing-api"'),
        "fail",
        "wrangler.jsonc names the Worker billing-api, but the base's deploy spec pins worker-lite",
      ],
      ["the bundler failed", ranOutput({ exit: 1 }), CONFIG, "fail", "the bundler exited 1"],
      [
        "a KV binding",
        ranOutput(),
        CONFIG.replace("{\n", '{"kv_namespaces": [],\n'),
        "abstain",
        "wrangler.jsonc declares kv_namespaces",
      ],
      [
        "TOML",
        ranOutput({ config: { file: "wrangler.toml", bytes: 4, text: b64("x=1") } }),
        "x=1",
        "abstain",
        "wrangler.toml: Keel reads",
      ],
      [
        "a config too long",
        ranOutput({ config: { file: "wrangler.jsonc", bytes: BUILD_CONFIG_LIMIT + 1, text: "" } }),
        CONFIG,
        "abstain",
        `wrangler.jsonc is ${BUILD_CONFIG_LIMIT + 1} bytes`,
      ],
      [
        "a config that did not decode",
        ranOutput(),
        undefined,
        "abstain",
        "wrangler.jsonc did not decode",
      ],
      [
        "a bundle too large",
        ranOutput({ bundle: { _tag: "too-large", bytes: BUILD_BUNDLE_LIMIT + 1 } }),
        CONFIG,
        "abstain",
        `the bundle is ${BUILD_BUNDLE_LIMIT + 1} bytes gzipped`,
      ],
      [
        "no module",
        ranOutput({ bundle: { _tag: "none" } }),
        CONFIG,
        "abstain",
        "the bundler exited 0 and made no module",
      ],
      [
        "no bundler",
        { _tag: "no-bundler" },
        CONFIG,
        "abstain",
        "no rolldown among the project's dependencies",
      ],
      [
        "no hydration",
        { _tag: "hydration-failed", reason: "no-workspace" },
        CONFIG,
        "abstain",
        "hydration-failed: no-workspace",
      ],
      ["built", ranOutput(), CONFIG, "pass", "built worker-lite from src/index.ts"],
    ];
    expect(
      cases.map(([name, output, config]) => {
        const [outcome, why] = judged(output, config);
        return [name, outcome, why?.slice(0, cases.find((c) => c[0] === name)?.[4].length)];
      }),
    ).toEqual(cases.map(([name, , , outcome, why]) => [name, outcome, why]));
    const failed = judgeBuild(step, ranOutput({ exit: 1 }), { config: CONFIG, tail: "" });
    expect(failed.evidence.deploy).toEqual({ failure: "the bundler exited 1" });
    const built = judgeBuild(step, ranOutput(), { config: CONFIG, tail: "built" });
    expect(built.evidence).toMatchObject({
      worker: "worker-lite",
      facts: {
        compatibilityDate: "2026-10-01",
        compatibilityFlags: ["nodejs_compat"],
        vars: { GREETING: "hi" },
      },
      mainModule: "worker.js",
      bundle: "H4sIAAAA",
    });
    expect(built.evidence).not.toHaveProperty("deploy");
    const { deploy: _deploy, ...bare } = step;
    expect(judgeBuild(bare, ranOutput(), { config: CONFIG, tail: "" }).report.outcome).toBe(
      "abstain",
    );
  });
});
