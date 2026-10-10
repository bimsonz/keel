// forge-lite as candidate bundles, for KeelVerify's live proofs: the base, a seeded
// failure, and a canary that dumps the runner's environment and plants a
// token-shaped string. Built with the same writer keel uses.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type BundleFile, sha256Hex, writeBundle } from "@keeltown/runner-protocol";

const REPO = join(import.meta.dirname, "../../../..");
const FIXTURE = "fixtures/forge-lite";

/** A token-shaped string no real credential will ever equal: the grep's can-fail arm. */
export const CANARY_TOKEN = "art_v1_KEELCANARYd1d1d1d1d1d1d1d1d1d1?expires=1760140800";
/** A start-env style variable planted in a child process, read back from its /proc/self/environ. */
export const CANARY_ENV = "KEEL_CANARY_ENV=art_v2_x_KEELCANARYenvenvenvenv?expires=1760140800";

export type Variant = "base" | "red" | "canary";

/** The fixture's tracked files, as a bundle sees them: paths relative to forge-lite. */
const fixtureFiles = (): BundleFile[] =>
  execFileSync("git", ["-C", REPO, "ls-files", FIXTURE], { encoding: "utf8" })
    .split("\n")
    .filter((p) => p.length > 0)
    .map((p) => ({
      path: p.slice(FIXTURE.length + 1),
      bytes: new Uint8Array(readFileSync(join(REPO, p))),
      executable: execFileSync("git", ["-C", REPO, "ls-files", "-s", p], {
        encoding: "utf8",
      }).startsWith("100755"),
    }));

const enc = new TextEncoder();

const replaceIn = (files: BundleFile[], path: string, from: string, to: string): BundleFile[] =>
  files.map((f) => {
    if (f.path !== path) return f;
    const text = new TextDecoder().decode(f.bytes);
    if (!text.includes(from)) throw new Error(`${path} no longer contains ${JSON.stringify(from)}`);
    return { ...f, bytes: enc.encode(text.replace(from, to)) };
  });

/** A test that fails on purpose so vitest keeps its output: the env, PID 1's environ, a planted env and the canary. */
const CANARY_TEST = `import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("dumps the runner's environment for the credential proof", () => {
  const environ = (path: string) => readFileSync(path, "utf8").split("\\0").filter(Boolean).join("\\n");
  const planted = execFileSync("sh", ["-c", "cat /proc/self/environ"], {
    env: { ...process.env, ${JSON.stringify(CANARY_ENV.split("=")[0])}: ${JSON.stringify(CANARY_ENV.slice(CANARY_ENV.indexOf("=") + 1))} },
    encoding: "utf8",
  }).split("\\0").filter(Boolean).join("\\n");
  const dump = [
    "== exec env ==", Object.entries(process.env).map(([k, v]) => k + "=" + v).join("\\n"),
    "== /proc/1/environ ==", environ("/proc/1/environ"),
    "== planted child environ ==", planted,
    "== canary ==", ${JSON.stringify(CANARY_TOKEN)},
  ].join("\\n");
  expect(dump).toBe("no dump: this test fails on purpose so its output is kept");
});
`;

/** The variant's files. `red` stops the manual clock, which every session-expiry test needs. */
export const variantFiles = (variant: Variant): BundleFile[] => {
  const base = fixtureFiles();
  if (variant === "red")
    return replaceIn(base, "src/clock.ts", "this.#now += ms;", "this.#now += 0;");
  if (variant === "canary")
    return [...base, { path: "test/keel-canary.test.ts", bytes: enc.encode(CANARY_TEST) }];
  return base;
};

export interface Bundle {
  readonly variant: Variant;
  readonly hash: string;
  readonly bytes: Uint8Array;
}

export const buildBundle = async (variant: Variant): Promise<Bundle> => {
  const bytes = await writeBundle(variantFiles(variant));
  return { variant, bytes, hash: `sha256:${await sha256Hex(bytes)}` };
};
