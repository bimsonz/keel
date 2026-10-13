import { env } from "cloudflare:workers";
import type { ContentHash } from "@keeltown/core/kernel";
import { sha256Hex, signedBundleUrl, writeBundle } from "@keeltown/runner-protocol";

const enc = new TextEncoder();

/** The namespace the pool's bundles are kept for unless a case names another, by id. */
export const NAMESPACE = "org_01JZ8PT2C4E6G8J0M2N4Q6S8V0";

/**
 * The URL keel hands a sandbox for a namespace's bundle (its sha256 hex),
 * signed with the pool's key and good for `ttl` seconds from now.
 */
export const signedUrl = (hex: string, namespace: string = NAMESPACE, ttl = 600): Promise<string> =>
  signedBundleUrl(
    env.TEST_BUNDLE_URL_SIGNING_KEY,
    namespace,
    `sha256:${hex}`,
    Math.floor(Date.now() / 1000) + ttl,
  );

/** Stores files as a content-addressed bundle among a namespace's bundles, at the key keel's BundleStore writes. */
export async function putBundle(
  files: Record<string, string>,
  namespace: string = NAMESPACE,
): Promise<ContentHash> {
  const bytes = await writeBundle(
    Object.entries(files).map(([path, text]) => ({ path, bytes: enc.encode(text) })),
  );
  const hex = await sha256Hex(bytes);
  await env.BUNDLES.put(`ns/${namespace}/bundles/${hex}`, bytes);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- sha256Hex returns 64 lowercase hex characters
  return `sha256:${hex}` as ContentHash;
}

/** Points a namespace's `deps/<lockfile sha256>` at a deps bundle of that namespace, as the deps-bundle script does. */
export async function putDeps(
  lockfile: string,
  files: Record<string, string>,
  namespace: string = NAMESPACE,
): Promise<void> {
  const bundle = await putBundle({ ...files, "pnpm-lock.yaml": lockfile }, namespace);
  await env.BUNDLES.put(
    `ns/${namespace}/deps/${await sha256Hex(enc.encode(lockfile))}`,
    bundle.slice("sha256:".length),
  );
}

/** What keel-verify sent out so far, as the pool's outbound recorder saw it (vitest.config.ts). */
export async function egress(): Promise<string[]> {
  const recorded: unknown = await (await fetch("https://keel-egress-record.invalid/")).json();
  return Array.isArray(recorded) ? recorded.map(String) : [];
}

/** A world with no dependencies: one module with one value. */
export const FLAG_WORLD = {
  "package.json": JSON.stringify({ name: "flag-world", type: "module" }),
  "src/flag.ts": "export const flag: number = 1;\n",
};

const probe = (body: string) => ({
  ".keel/flag.test.ts": [
    `import { describe, expect, it } from "vitest";`,
    `import { flag } from "../src/flag.ts";`,
    ``,
    body,
  ].join("\n"),
});

/** A probe per answer, each against FLAG_WORLD. */
export const PROBES = {
  pass: probe(
    `describe("flag", () => it("is one", () => {\n  console.log("[probe] flag -> " + flag + " (expected 1)");\n  expect(flag).toBe(1);\n}));`,
  ),
  fail: probe(
    `describe("flag", () => it("is two", () => {\n  console.log("[probe] flag -> " + flag + " (expected 2)");\n  expect(flag).toBe(2);\n}));`,
  ),
  "n/a": probe(
    `describe("flag", () => it("needs a flag route", () => {\n  console.log("[probe] flag -> " + flag);\n  throw new Error("probe not applicable: no flag route in this world");\n}));`,
  ),
  "harness-error": probe(
    `it("one", () => console.log("[probe] one"));\nit("two", () => console.log("[probe] two"));`,
  ),
  sleeps: probe(
    `it("sleeps", async () => {\n  await new Promise((resolve) => setTimeout(resolve, 600_000));\n  console.log("[probe] woke");\n});`,
  ),
  naps: probe(
    `it("naps", async () => {\n  await new Promise((resolve) => setTimeout(resolve, 400));\n  console.log("[probe] flag -> " + flag + " (expected 1)");\n  expect(flag).toBe(1);\n});`,
  ),
  usesVi: {
    ".keel/flag.test.ts": `import { it, vi } from "vitest";\nit("spies", () => { vi.fn(); console.log("[probe] spied"); });`,
  },
  outsideKeel: {
    "flag.test.ts": `import { it } from "vitest";\nit("x", () => console.log("[probe] x"));`,
  },
} as const;

/** A world that declares a dependency, and a probe that imports it. */
export const TINY_LOCK = "lockfileVersion: '9.0'\npackages:\n  tiny@1.0.0: {}\n";
export const TINY_WORLD = {
  "package.json": JSON.stringify({
    name: "tiny-world",
    type: "module",
    dependencies: { tiny: "1.0.0" },
  }),
  "pnpm-lock.yaml": TINY_LOCK,
};
export const TINY_DEPS = {
  "node_modules/tiny/package.json": JSON.stringify({
    name: "tiny",
    version: "1.0.0",
    type: "module",
    main: "index.js",
  }),
  "node_modules/tiny/index.js": "export const tiny = 'tiny';\n",
};
export const TINY_PROBE = {
  ".keel/tiny.test.ts": [
    `import { expect, it } from "vitest";`,
    `import { tiny } from "tiny";`,
    `it("imports tiny", () => {`,
    `  console.log("[probe] tiny -> " + tiny);`,
    `  expect(tiny).toBe("tiny");`,
    `});`,
  ].join("\n"),
};
