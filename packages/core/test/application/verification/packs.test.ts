import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Result } from "effect";
import { describe, expect, it } from "vitest";
import {
  DEPLOY_PREVIEW,
  DEPLOY_SMOKE,
  detectPack,
  executable,
  JS_TS_SUITE,
  WORKER_APP_BUILD,
  WORKER_APP_PACK,
  WORKER_APP_TYPECHECK,
} from "../../../src/application/verification/index.ts";
import { compile, type PlanStep } from "../../../src/domain/verification/index.ts";
import { base } from "../../arbitraries/flow.ts";

const pkg = (deps: Record<string, string>, dev: Record<string, string> = {}) =>
  JSON.stringify({ name: "x", dependencies: deps, devDependencies: dev });

const DEPLOY = {
  target: "production",
  worker: "worker-lite",
  smoke: [{ path: "/health", status: 200, contains: "ok" }],
};
const compiled = (defaults: Parameters<typeof compile>[2]) =>
  Result.getOrThrow(
    compile(
      undefined,
      { baseCommit: base, touchedPaths: ["src/a.ts"], subjects: [], facts: {} },
      defaults,
    ),
  );

describe("verifier packs: defaults chosen by detection, never rules", () => {
  it("[packs.worker-app-by-config] a wrangler config at the root makes a worker app", () => {
    for (const config of ["wrangler.json", "wrangler.jsonc", "wrangler.toml"]) {
      const pack = detectPack(["package.json", config, "src"], pkg({}));
      expect(pack.name).toBe("worker-app");
      expect(pack.reason).toContain(config);
    }
    expect(detectPack(["package.json", "apps"], pkg({})).name).toBe("js-ts");
  });

  it("[packs.worker-app-by-dependency] wrangler or an @cloudflare package among the dependencies makes a worker app", () => {
    expect(detectPack(["package.json"], pkg({}, { wrangler: "4.0.0" })).name).toBe("worker-app");
    expect(
      detectPack(["package.json"], pkg({ "@cloudflare/vitest-pool-workers": "1.0.0" })).name,
    ).toBe("worker-app");
    expect(detectPack(["package.json"], pkg({ hono: "4.0.0" })).name).toBe("js-ts");
  });

  it("[packs.js-ts] forge-lite, a package with no Worker tooling, is js-ts", () => {
    const fixture = join(import.meta.dirname, "../../../../../fixtures/forge-lite");
    const pack = detectPack(
      ["package.json", "src", "test", "tsconfig.json"],
      readFileSync(join(fixture, "package.json"), "utf8"),
    );
    expect(pack.name).toBe("js-ts");
    expect(pack.defaults.steps.map((s) => s.id)).toEqual([JS_TS_SUITE.id]);
  });

  it("[packs.no-manifest] with no package.json, or an unreadable one, the js-ts suite runs, and its abstain parks the change", () => {
    expect(detectPack(["README.md"], undefined)).toMatchObject({
      name: "js-ts",
      reason: "no package.json",
    });
    expect(detectPack(["package.json"], "{").name).toBe("js-ts");
  });

  it("[packs.worker-app-compiles] the worker-app pack runs the suite and the typecheck side by side, both in Tier 2", () => {
    const plan = Result.getOrThrow(
      compile(
        undefined,
        { baseCommit: base, touchedPaths: ["src/a.ts"], subjects: [], facts: {} },
        WORKER_APP_PACK,
      ),
    );
    expect(plan.flow).toEqual({
      _tag: "par",
      items: [
        { _tag: "step", step: JS_TS_SUITE.id },
        { _tag: "step", step: WORKER_APP_TYPECHECK.id },
      ],
    });
    expect(plan.steps.map((s) => [s.id, s.tier.tier, s.evidenceCeiling])).toEqual([
      [JS_TS_SUITE.id, 2, "proof"],
      [WORKER_APP_TYPECHECK.id, 2, "proof"],
    ]);
  });

  it("[packs.executable-run] a Tier 2 step with a command of its own is executable whatever its id, and only in Tier 2", () => {
    const own: PlanStep = {
      id: "keel.check",
      kind: "deterministic",
      evidenceCeiling: "proof",
      appliesTo: [],
      tier: { tier: 2, reason: "a command of the project's own runs in a container" },
      because: "applies to every change",
    };
    const run = { command: "pnpm test", timeoutMs: 240_000 };
    expect(executable(own)).toBe(false);
    expect(executable({ ...own, run })).toBe(true);
    expect(executable({ ...own, run, tier: { tier: 1, reason: "policy" } })).toBe(false);
    expect(executable({ ...own, id: JS_TS_SUITE.id })).toBe(true);
  });

  it("[packs.deploy-steps] a deploy spec at the base builds, previews and smokes the Worker beside the suite, each step carrying the spec", () => {
    const pack = detectPack(
      ["package.json", "src"],
      pkg({ hono: "4.0.0" }),
      JSON.stringify(DEPLOY),
    );
    expect([pack.name, pack.reason]).toEqual(["worker-app", "worker-app: .keel/deploy.json"]);
    const plan = compiled(pack.defaults);
    expect(plan.flow).toEqual({
      _tag: "par",
      items: [
        { _tag: "step", step: JS_TS_SUITE.id },
        { _tag: "step", step: WORKER_APP_TYPECHECK.id },
        {
          _tag: "seq",
          exitOn: "fail",
          items: [
            { _tag: "step", step: WORKER_APP_BUILD.id },
            { _tag: "step", step: DEPLOY_PREVIEW.id },
            { _tag: "step", step: DEPLOY_SMOKE.id },
          ],
        },
      ],
    });
    expect(
      plan.steps.map((s) => [s.id, s.kind, s.tier.tier, s.deploy?.worker, executable(s)]),
    ).toEqual([
      [JS_TS_SUITE.id, "deterministic", 2, undefined, true],
      [WORKER_APP_TYPECHECK.id, "deterministic", 2, undefined, true],
      [WORKER_APP_BUILD.id, "deterministic", 2, "worker-lite", true],
      [DEPLOY_PREVIEW.id, "deploy", 0, "worker-lite", true],
      [DEPLOY_SMOKE.id, "deploy", 0, "worker-lite", true],
    ]);
  });

  it("[packs.deploy-unreadable] a deploy spec that does not read adds no deploy step, and the reason says why", () => {
    const rootPaths = ["package.json", "wrangler.jsonc"];
    const without = detectPack(rootPaths, pkg({}));
    for (const bad of [
      "{",
      JSON.stringify({ ...DEPLOY, Path: "x" }),
      JSON.stringify({ ...DEPLOY, smoke: [] }),
    ]) {
      const pack = detectPack(rootPaths, pkg({}), bad);
      expect([
        bad,
        pack.defaults,
        pack.reason.startsWith(`${without.reason}; no deploy steps: .keel/deploy.json`),
      ]).toEqual([bad, WORKER_APP_PACK, true]);
    }
  });

  it("[packs.executable-deploy] a deploy step runs only in Tier 0, as one of Keel's own deploy steps, with the spec it carries", () => {
    const preview = compiled(detectPack([], undefined, JSON.stringify(DEPLOY)).defaults).steps.find(
      (s) => s.id === DEPLOY_PREVIEW.id,
    );
    if (preview === undefined) throw new Error("no preview step");
    const { deploy: _deploy, ...bare } = preview;
    expect([
      executable(preview),
      executable(bare),
      executable({ ...preview, tier: { tier: 1, reason: "policy" } }),
      executable({ ...preview, id: "deploy.anywhere" }),
      executable({ ...preview, kind: "deterministic" }),
    ]).toEqual([true, false, false, false, false]);
  });
});
