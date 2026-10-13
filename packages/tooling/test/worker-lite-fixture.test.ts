/**
 * worker-lite's suite and build run on the dependencies Keel's suite image
 * holds, which are forge-lite's: the box refuses a lockfile whose sha256 is not
 * the baked one's. So the two fixtures keep the same lockfile, byte for byte,
 * and declare the same dependencies.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const fixtureFile = (fixture: string, path: string): Buffer =>
  readFileSync(new URL(`../../../fixtures/${fixture}/${path}`, import.meta.url));

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

const declared = (fixture: string): unknown => {
  const manifest: unknown = JSON.parse(fixtureFile(fixture, "package.json").toString("utf8"));
  return {
    dependencies: Reflect.get(Object(manifest), "dependencies"),
    devDependencies: Reflect.get(Object(manifest), "devDependencies"),
  };
};

describe("the worker-lite fixture", () => {
  it("[fixture.worker-lite-lock] has forge-lite's lockfile, byte for byte", () => {
    expect(sha256(fixtureFile("worker-lite", "pnpm-lock.yaml"))).toBe(
      sha256(fixtureFile("forge-lite", "pnpm-lock.yaml")),
    );
  });

  it("[fixture.worker-lite-deps] declares forge-lite's dependencies", () => {
    expect(declared("worker-lite")).toEqual(declared("forge-lite"));
  });
});
