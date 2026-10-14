import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Result } from "effect";
import { describe, expect, it } from "vitest";
import {
  detectPack,
  executable,
  JS_TS_SUITE,
  WORKER_APP_PACK,
  WORKER_APP_TYPECHECK,
} from "../../../src/application/verification/index.ts";
import { compile, type PlanStep } from "../../../src/domain/verification/index.ts";
import { base } from "../../arbitraries/flow.ts";

const pkg = (deps: Record<string, string>, dev: Record<string, string> = {}) =>
  JSON.stringify({ name: "x", dependencies: deps, devDependencies: dev });

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
});
