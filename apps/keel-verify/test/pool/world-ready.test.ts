import { env, exports } from "cloudflare:workers";
import { ContentHash } from "@keeltown/core/kernel";
import { sha256Hex } from "@keeltown/runner-protocol";
import { Cause, Exit, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { decodeExit, VerifierCodecs } from "../../src/rpc/index.ts";
import {
  askWorldReady,
  FLAG_WORLD,
  putBundle,
  putDeps,
  TINY_DEPS,
  TINY_LOCK,
  TINY_PROBE,
  TINY_WORLD,
} from "./support/probes.ts";

/** Namespaces of this file's own, so no other file's deps pointer answers for them. */
const NAMESPACE = "org_01JZ8PT2C4E6G8J0M2N4Q6S8W0";
const BARE = "org_01JZ8PT2C4E6G8J0M2N4Q6S8W1";

const readiness = async (worldBundle: string, namespace: string) => {
  const exit = await askWorldReady(worldBundle, namespace);
  if (Exit.isFailure(exit)) throw new Error(`no answer: ${JSON.stringify(exit.cause)}`);
  return exit.value;
};

/** Why keel-verify's `runProbe` could not run a probe against the world at all, through the same front door. */
const runRefusal = async (probe: ContentHash, worldBundle: ContentHash, namespace: string) => {
  const entry: unknown = exports.default;
  const served: unknown = Reflect.get(Object(entry), "runProbe");
  if (typeof served !== "function") throw new Error("keel-verify's entrypoint has no runProbe");
  const raw: unknown = await Reflect.apply(served, entry, [
    { namespace, probe, world: "trunk", worldBundle, run: 1 },
  ]);
  const exit = decodeExit(VerifierCodecs.runProbe, raw);
  if (Exit.isSuccess(exit)) return `answered ${JSON.stringify(exit.value.run)}`;
  return Option.match(Cause.findErrorOption(exit.cause), {
    onNone: () => "a defect",
    onSome: (e) => e.reason,
  });
};

describe("keel-verify's worldReady", () => {
  it("[tier1.world-ready] a world with no dependencies is ready, and so is one whose lockfile has its deps bundle", async () => {
    const flag = await putBundle(FLAG_WORLD, NAMESPACE);
    expect(await readiness(flag, NAMESPACE)).toEqual({ _tag: "Ready" });
    await putDeps(TINY_LOCK, TINY_DEPS, NAMESPACE);
    const tiny = await putBundle(TINY_WORLD, NAMESPACE);
    expect(await readiness(tiny, NAMESPACE)).toEqual({ _tag: "Ready" });
  });

  it("[tier1.world-unready] a world whose lockfile has no deps bundle in its namespace is unready, in the words a run would be refused with", async () => {
    // BARE holds the world and a probe, and no deps bundle; NAMESPACE's own pointer says nothing for it.
    await putDeps(TINY_LOCK, TINY_DEPS, NAMESPACE);
    const tiny = await putBundle(TINY_WORLD, BARE);
    const lock = await sha256Hex(new TextEncoder().encode(TINY_LOCK));
    expect(await readiness(tiny, BARE)).toEqual({
      _tag: "Unready",
      reason: `lockfile-diverged: no deps bundle for pnpm-lock.yaml ${lock}`,
    });
    const probe = await putBundle(TINY_PROBE, BARE);
    expect(await runRefusal(probe, tiny, BARE)).toBe(
      `lockfile-diverged: no deps bundle for pnpm-lock.yaml ${lock}`,
    );
  });

  it("[tier1.world-unready-deps] a pointer that names a bundle installed from another lockfile leaves the world unready", async () => {
    const otherLock = `${TINY_LOCK}# another resolution\n`;
    const world = await putBundle({ ...TINY_WORLD, "pnpm-lock.yaml": otherLock }, NAMESPACE);
    const installed = await putBundle({ ...TINY_DEPS, "pnpm-lock.yaml": TINY_LOCK }, NAMESPACE);
    const lock = await sha256Hex(new TextEncoder().encode(otherLock));
    await env.BUNDLES.put(`ns/${NAMESPACE}/deps/${lock}`, installed.slice("sha256:".length));
    expect(await readiness(world, NAMESPACE)).toEqual({
      _tag: "Unready",
      reason: `lockfile-diverged: deps bundle ${installed.slice("sha256:".length)} was not installed from pnpm-lock.yaml ${lock}`,
    });
  });

  it("[tier1.world-unready-missing] a world bundle that is not in the namespace's store is unready, by its key", async () => {
    const absent = Schema.decodeUnknownSync(ContentHash)(`sha256:${"a".repeat(64)}`);
    expect(await readiness(absent, NAMESPACE)).toEqual({
      _tag: "Unready",
      reason: `world bundle ns/${NAMESPACE}/bundles/${"a".repeat(64)} is not in the bundle store`,
    });
  });

  it("[tier1.world-ready-undecoded] a request that does not decode is no answer about any world", async () => {
    const exit = await askWorldReady("not a hash", NAMESPACE);
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("the world readiness request did not decode");
  });
});
