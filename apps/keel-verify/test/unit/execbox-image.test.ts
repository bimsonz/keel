import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEPS_TOOLCHAIN } from "@keeltown/core/application/verification";
import { describe, expect, it } from "vitest";

const IMAGE = join(import.meta.dirname, "../../containers/sandbox");
const dockerfile = readFileSync(join(IMAGE, "Dockerfile"), "utf8");

describe("the sandbox image", () => {
  it("builds on the sandbox runtime @cloudflare/ci pins", () => {
    expect(dockerfile).toMatch(/^FROM docker\.io\/cloudflare\/sandbox:0\.12\.1$/m);
  });

  it("[image.toolchain] installs the pnpm DEPS_TOOLCHAIN names, and states its toolchain in DEPS_TOOLCHAIN's own form", () => {
    // A deps box prints /etc/keel-toolchain, and its object keeps a build only when
    // that is DEPS_TOOLCHAIN: an image that drifts from the constant builds nothing.
    const [, node, pnpm] =
      /^node (v\d+\.\d+\.\d+) pnpm (\d+\.\d+\.\d+)$/.exec(DEPS_TOOLCHAIN) ?? [];
    if (node === undefined || pnpm === undefined)
      throw new Error(`DEPS_TOOLCHAIN is not "node v<x.y.z> pnpm <x.y.z>": ${DEPS_TOOLCHAIN}`);
    const installed = /^RUN npm install -g pnpm@(\S+) /m.exec(dockerfile)?.[1];
    expect(installed).toBe(pnpm);
    // The line that writes the file, with each command replaced by what it prints
    // in the pinned image. Node comes with the base image, so its version is the
    // one thing here that is read from the constant alone.
    const [, written, ...more] =
      /^RUN echo "(.*)" > \/etc\/keel-toolchain$/m.exec(dockerfile) ?? [];
    expect(more).toEqual([]);
    expect(
      written?.replace("$(node --version)", node).replace("$(pnpm --version)", installed ?? ""),
    ).toBe(DEPS_TOOLCHAIN);
  });

  it("bakes no project's dependencies: a deps box builds them, and a suite box fetches them", () => {
    expect(existsSync(join(IMAGE, "forge-deps"))).toBe(false);
    expect(dockerfile).not.toMatch(/pnpm install|COPY /);
  });
});
