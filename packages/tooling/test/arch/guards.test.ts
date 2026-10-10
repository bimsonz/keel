import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
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
  "event-names": [/PremiseSuspect is not a past-tense verb/, /catalogued twice/, /ChangeTeleported .* missing from the catalogue/],
  "lint-config": [/nested \.oxlintrc\.json/],
  R1: [/outside the domain/, /package hono/, /imports Effect from effect/, /\[archunit\] depends on src\/application/],
  R2: [/imports hono/, /generated\/http\/app\.gen\.ts/],
  R3: [/driving adapter imports the driven adapter/, /\[archunit\] depends on src\/adapters\/driven/],
  R4: [/reaches into context coordination past its index\.ts/, /\[archunit\] cycle/],
  R5: [/imports cloudflare:workers/, /imports zod/],
  R6: [/zod belongs to generated code only/],
  R7: [/imports cloudflare:workers outside/],
  R8: [/runs an effect \(runPromise\)/, /detaches a fiber \(forkDetach\)/],
  R9: [/depends on @keeltown\/core/, /imports @keeltown\/testing/],
  R10: [/imports agents/, /imports @modelcontextprotocol\/client/],
  R11: [/setInterval polls/, /setAlarm outside/, /must name kind/],
  R12: [/layer folder is missing or empty/],
  R13: [/account_id is committed/, /database_id holds an account-specific id/, /vars\.KEEL_HOST/, /max_instances/, /workers_dev must be set/, /compatibility dates differ/, /adds binding EXTRA_SECRET/],
  R14: [/literal against a literal/, /it\.only/],
  R15: [/imports @keeltown\/core\/ports/, /imports \.\.\/adapters\/driven\/system\.ts/],
};

describe.each(allChecks.map((check) => [check.name, check] as const))("%s", (name, check) => {
  it("passes on the real tree, having read enough files and the canary", async () => {
    const result = await check.run(root);
    expect(result.violations).toEqual([]);
    expect(result.canarySeen).toBe(true);
    expect(result.filesScanned).toBeGreaterThan(0);
  });

  it("goes red on its control fixture, for the reasons it exists", async () => {
    const result = await check.run(join(root, "test/controls", name), {
      skip: [],
      vacuity: { minFiles: 1, canary: check.controlCanary },
    });
    const messages = result.violations.map((v) => v.message);
    expect(messages.filter((m) => m.startsWith("vacuous:"))).toEqual([]);
    for (const pattern of EXPECTED[name] ?? [/^$/]) expect(messages).toContainEqual(expect.stringMatching(pattern));
  });

  it("goes red when pointed at a directory with nothing to read", async () => {
    const result = await check.run(empty);
    expect(result.violations.map((v) => v.message)).toEqual(expect.arrayContaining([expect.stringMatching(/^vacuous:/)]));
  });
});

it("every check has its expected control reasons written down", () => {
  expect(allChecks.map((c) => c.name).toSorted()).toEqual(Object.keys(EXPECTED).toSorted());
});
