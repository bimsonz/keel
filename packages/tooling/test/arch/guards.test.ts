import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { guards } from "../../src/registry.ts";
import { repoRoot } from "../../src/scan.ts";

const root = repoRoot(import.meta.dirname);
const empty = mkdtempSync(join(tmpdir(), "keel-guard-empty-"));
afterAll(() => rmSync(empty, { recursive: true, force: true }));

describe.each(guards.map((guard) => [guard.name, guard] as const))("guard %s", (_name, guard) => {
  it("passes on the real tree, having read enough files and the canary", () => {
    const result = guard.run(root);
    expect(result.violations).toEqual([]);
    expect(result.canarySeen).toBe(true);
    expect(result.filesScanned).toBeGreaterThan(0);
  });

  it("goes red on its control fixture, for the violation itself", () => {
    const result = guard.run(join(root, "test/controls", guard.name), {
      skip: [],
      vacuity: { minFiles: 1, canary: guard.controlCanary },
    });
    const real = result.violations.filter((v) => !v.message.startsWith("vacuous:"));
    expect(real.length).toBeGreaterThan(0);
    expect(result.violations.filter((v) => v.message.startsWith("vacuous:"))).toEqual([]);
  });

  it("goes red when pointed at a directory with nothing to read", () => {
    const result = guard.run(empty);
    expect(result.violations.map((v) => v.message)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^vacuous: read 0 file/)]),
    );
  });
});
