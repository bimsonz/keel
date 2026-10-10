import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = join(import.meta.dirname, "../../..");
const IMAGE = "apps/keel-verify/containers/sandbox";

describe("the ExecBox image", () => {
  it("[image.lock-identical] bakes forge-lite's dependencies from byte-identical manifests", () => {
    // The suite command links the baked node_modules only when the candidate's
    // lockfile hashes to the image's; a copy that drifts would abstain every run.
    for (const file of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
      const baked = readFileSync(join(REPO, IMAGE, "forge-deps", file), "utf8");
      const fixture = readFileSync(join(REPO, "fixtures/forge-lite", file), "utf8");
      expect({ file, same: baked === fixture }).toEqual({ file, same: true });
    }
  });

  it("builds on the sandbox runtime @cloudflare/ci pins, and installs from the frozen lockfile", () => {
    const dockerfile = readFileSync(join(REPO, IMAGE, "Dockerfile"), "utf8");
    expect(dockerfile).toMatch(/^FROM docker\.io\/cloudflare\/sandbox:0\.12\.1$/m);
    expect(dockerfile).toContain("pnpm install --frozen-lockfile");
    expect(dockerfile).toContain("> .lock-sha");
  });
});
