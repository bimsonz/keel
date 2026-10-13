import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkPatchesApply } from "../../src/guards/patches-apply.ts";
import { allChecks } from "../../src/registry.ts";
import { repoRoot } from "../../src/scan.ts";

const root = repoRoot(import.meta.dirname);
const empty = mkdtempSync(join(tmpdir(), "keel-guard-empty-"));
afterAll(() => rmSync(empty, { recursive: true, force: true }));

/**
 * What each control must be caught for. A control that goes red for some
 * other reason proves nothing about its rule, so the reason is checked too.
 * Rules backed by ArchUnitTS must be caught by both engines.
 */
const EXPECTED: Record<string, readonly RegExp[]> = {
  "public-scrub": [/local filesystem path/, /planted name/],
  "event-names": [
    /PremiseSuspect is not a past-tense verb/,
    /catalogued twice/,
    /ChangeTeleported .* missing from the catalogue/,
  ],
  "lint-config": [/nested \.oxlintrc\.json/],
  "model-pins": [
    /binds AI but declares no vars\.PLATFORM_FUNCTION_PINS/,
    /pins keel\.probe\.freshness to "cloudflare\/auto", not an exact @cf\/ model id/,
    /pins keel\.probe\.free-form to 7, not an exact @cf\/ model id/,
  ],
  "runner-credentials": [
    /cloudflareCredentials hands a credential/,
    /sourceControlCredentials hands a credential/,
    /runner call leaves sourceControlCredentials unset/,
    /runner options are not an object literal/,
  ],
  "loader-spec": [
    /leaves globalOutbound unset/,
    /sets globalOutbound to something other than the literal null/,
    /hands the isolate an env/,
    /spreads an object/,
    /is not an arrow returning an object literal/,
    /LOADER is used other than as LOADER\.get/,
    /LOADER is destructured or passed on/,
  ],
  "readonly-bundles": [
    /used for something other than get, head or list/,
    /BUNDLES is destructured/,
    /BUNDLES\.put outside keel-deps-box\.ts/,
    /BUNDLES\.put writes a key that is not namespaceKey/,
  ],
  "xstate-test-only": [/imports xstate; xstate is a test-only/, /imports @xstate\/inspect/],
  "r2-namespace-keys": [
    /builds a key under bundles\/ by hand/,
    /builds a key under evidence\/ by hand/,
    /builds a key under ns\/ by hand/,
  ],
  "patches-apply": [/does not apply: patch failed: notes\.txt:1/],
  R1: [
    /outside the domain/,
    /package hono/,
    /imports Effect from effect/,
    /\[archunit\] depends on src\/application/,
  ],
  R2: [/imports hono/, /generated\/http\/app\.gen\.ts/],
  R3: [
    /driving adapter imports the driven adapter/,
    /\[archunit\] depends on src\/adapters\/driven/,
  ],
  R4: [/reaches into context coordination past its index\.ts/, /\[archunit\] cycle/],
  R5: [/imports cloudflare:workers/, /imports zod/],
  R6: [/zod belongs to generated code only/],
  R7: [/imports cloudflare:workers outside/],
  R8: [/runs an effect \(runPromise\)/, /detaches a fiber \(forkDetach\)/],
  R9: [/depends on @keeltown\/core/, /imports @keeltown\/testing/],
  R10: [/imports agents/, /imports @modelcontextprotocol\/client/],
  R11: [/setInterval polls/, /setAlarm outside/, /must name kind/],
  R12: [/layer folder is missing or empty/],
  R13: [
    /account_id is committed/,
    /database_id holds an account-specific id/,
    /ratelimits\[0\]\.namespace_id holds an account-specific id/,
    /vars\.KEEL_HOST/,
    /MergeBox\) has no max_instances/,
    /GatedBox\) uses the durable_object policy but is not registered/,
    /workers_dev must be set/,
    /compatibility dates differ/,
    /adds binding EXTRA_SECRET/,
  ],
  R14: [/literal against a literal/, /it\.only/],
  R15: [/imports @keeltown\/core\/ports/, /imports \.\.\/adapters\/driven\/system\.ts/],
};

/**
 * The real-tree pass of an ArchUnitTS check builds a TypeScript program over the
 * whole repo: R3's takes ~11 s alone on an idle machine, but 70–110 s while every
 * lane gates at once (load 90–160), past the project's 60 s. Its budget is set
 * for that load, not for an idle runner; the canary and file count still prove
 * that it read the tree.
 */
const REAL_TREE_TIMEOUT = 600_000;

describe.each(allChecks.map((check) => [check.name, check] as const))("%s", (name, check) => {
  it(
    "passes on the real tree, having read enough files and the canary",
    { timeout: REAL_TREE_TIMEOUT },
    async () => {
      const result = await check.run(root);
      expect(result.violations).toEqual([]);
      expect(result.canarySeen).toBe(true);
      expect(result.filesScanned).toBeGreaterThan(0);
    },
  );

  it("goes red on its control fixture, for the reasons it exists", async () => {
    const result = await check.run(join(root, "test/controls", name), {
      skip: [],
      vacuity: { minFiles: 1, canary: check.controlCanary },
    });
    const messages = result.violations.map((v) => v.message);
    expect(messages.filter((m) => m.startsWith("vacuous:"))).toEqual([]);
    for (const pattern of EXPECTED[name] ?? [/^$/])
      expect(messages).toContainEqual(expect.stringMatching(pattern));
  });

  it("goes red when pointed at a directory with nothing to read", async () => {
    const result = await check.run(empty);
    expect(result.violations.map((v) => v.message)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^vacuous:/)]),
    );
  });
});

it("every check has its expected control reasons written down", () => {
  expect(allChecks.map((c) => c.name).toSorted()).toEqual(Object.keys(EXPECTED).toSorted());
});

describe("patches-apply", () => {
  const control = join(root, "test/controls/patches-apply");
  const vacuity = { minFiles: 1, canary: "test/mutants/stale.patch" };
  const stale = ["test/mutants/stale.patch"];

  it("[patches-apply.control] reports the patch that cannot apply and no other", async () => {
    const result = await checkPatchesApply(control, { vacuity });
    expect(result.filesScanned).toBe(2);
    expect(result.violations.map((v) => v.file)).toEqual(stale);
  });

  it("[patches-apply.index] reads a repository's index, so a mutant applied to the working tree leaves its own patch fresh", async () => {
    const repo = mkdtempSync(join(tmpdir(), "keel-guard-patches-"));
    try {
      cpSync(control, repo, { recursive: true });
      for (const args of [
        ["init", "--quiet"],
        ["add", "--all"],
        ["apply", "test/mutants/fresh.patch"],
      ])
        execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
      const result = await checkPatchesApply(repo, { vacuity });
      expect(result.violations.map((v) => v.file)).toEqual(stale);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("[patches-apply.every-patch] checks every patch when there are more than run at once", async () => {
    const copy = mkdtempSync(join(tmpdir(), "keel-guard-patches-"));
    try {
      cpSync(control, copy, { recursive: true });
      const more = Array.from({ length: 20 }, (_, i) => `test/mutants/z-${i + 10}.patch`);
      for (const patch of more)
        cpSync(join(control, "test/mutants/stale.patch"), join(copy, patch));
      const result = await checkPatchesApply(copy, { vacuity });
      expect(result.violations.map((v) => v.file)).toEqual([...stale, ...more]);
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  });

  it("[patches-apply.git-broke] throws when git cannot say whether the root is a repository", async () => {
    const broken = mkdtempSync(join(tmpdir(), "keel-guard-patches-"));
    try {
      cpSync(control, broken, { recursive: true });
      writeFileSync(join(broken, ".git"), "not a gitfile\n");
      await expect(checkPatchesApply(broken, { vacuity })).rejects.toThrow(/git rev-parse failed/);
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  });
});

/** Every source file under `dir`, recursively. */
function sources(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".ts"))
    .map((path) => join(dir, path));
}

const ARCHUNIT_RULES = allChecks.filter((check) => ["R1", "R3", "R4"].includes(check.name));

describe.each(ARCHUNIT_RULES.map((check) => [check.name, check] as const))(
  "[arch.graph-fresh] %s",
  (name, check) => {
    it("reads the tree again on its next run, not the graph its last run built", async () => {
      const tree = mkdtempSync(join(tmpdir(), "keel-guard-fresh-"));
      try {
        cpSync(join(root, "test/controls", name), tree, { recursive: true });
        const options = { skip: [], vacuity: { minFiles: 1, canary: check.controlCanary } };
        const before = (await check.run(tree, options)).violations.map((v) => v.message);
        expect(before).toContainEqual(expect.stringMatching(/^\[archunit\]/));

        for (const file of sources(tree)) writeFileSync(file, "export {};\n");
        expect((await check.run(tree, options)).violations).toEqual([]);
      } finally {
        rmSync(tree, { recursive: true, force: true });
      }
    });
  },
);
