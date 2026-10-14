import { env, exports } from "cloudflare:workers";
import { ProbeRunner, ProbeRunnerUnavailable } from "@keeltown/core/ports";
import { ContentHash, NamespaceId } from "@keeltown/core/kernel";
import { probeWorkerFiles, Semaphore, sha256Hex } from "@keeltown/runner-protocol";
import { describeProbeRunnerContract } from "@keeltown/testing";
import { Effect, Exit, Layer, Schema } from "effect";
import { beforeAll, describe, expect, it } from "vitest";
import { bundleProbe, BundlerFenced } from "../../src/adapters/driving/do/tier1/bundle.ts";
import {
  judgeIsolate,
  runProbe,
  type Tier1,
} from "../../src/adapters/driving/do/tier1/run-probe.ts";
import { decodeExit, ProbeRunRequest, VerifierCodecs, verifierName } from "../../src/rpc/index.ts";
import {
  askWorldReady,
  egress,
  FLAG_WORLD,
  PROBES,
  putBundle,
  putDeps,
  TINY_DEPS,
  TINY_LOCK,
  TINY_PROBE,
  TINY_WORLD,
} from "./support/probes.ts";

/** keel-verify's own front door, as keel's VERIFIER service binding reaches it. */
const entry: unknown = exports.default;

const runsProbes = (x: unknown): x is { runProbe(request: unknown): Promise<unknown> } =>
  typeof Reflect.get(Object(x), "runProbe") === "function";

/** One probe run through the real entrypoint, the real VerifierDO and the real LOADER. */
const viaEntrypoint = async (request: ProbeRunRequest) => {
  if (!runsProbes(entry)) throw new Error("keel-verify's entrypoint has no runProbe");
  return decodeExit(
    VerifierCodecs.runProbe,
    await entry.runProbe(Schema.encodeSync(ProbeRunRequest)(request)),
  );
};

const request = (
  probe: ContentHash,
  worldBundle: ContentHash,
  run = 1,
  namespace: NamespaceId = NAMESPACE,
): ProbeRunRequest => ({
  namespace,
  probe,
  world: "A",
  worldBundle,
  run,
});

/** The namespace the bundles below are kept for, and another that holds none of them. */
const NAMESPACE = Schema.decodeUnknownSync(NamespaceId)("org_01JZ8PT2C4E6G8J0M2N4Q6S8V0");
const OTHER = Schema.decodeUnknownSync(NamespaceId)("org_01JZ8PT2C4E6G8J0M2N4Q6S8V1");

const answered = async (r: ProbeRunRequest) => {
  const exit = await viaEntrypoint(r);
  if (Exit.isFailure(exit)) throw new Error(`unavailable: ${JSON.stringify(exit.cause)}`);
  return exit.value;
};

const reasonOf = async (r: ProbeRunRequest): Promise<string> => {
  const exit = await viaEntrypoint(r);
  if (Exit.isSuccess(exit)) return `answered ${JSON.stringify(exit.value.run)}`;
  return JSON.stringify(exit.cause);
};

let world: ContentHash;
const stored = new Map<string, ContentHash>();

/** The stored bundle of one of PROBES. */
const probes = (name: keyof typeof PROBES): ContentHash => {
  const hash = stored.get(name);
  if (hash === undefined) throw new Error("a probe of PROBES was not stored before the tests ran");
  return hash;
};

beforeAll(async () => {
  world = await putBundle(FLAG_WORLD);
  for (const [name, files] of Object.entries(PROBES)) stored.set(name, await putBundle(files));
}, 120_000);

describeProbeRunnerContract("VerifierDO through keel-verify's runProbe", () => ({
  layer: Layer.succeed(
    ProbeRunner,
    ProbeRunner.of({
      ready: (r) =>
        Effect.promise(() => askWorldReady(r.worldBundle, r.namespace)).pipe(
          Effect.flatMap((exit) =>
            Exit.isSuccess(exit)
              ? Effect.succeed(exit.value)
              : Effect.fail(new ProbeRunnerUnavailable({ reason: JSON.stringify(exit.cause) })),
          ),
        ),
      run: (r) =>
        Effect.promise(() => viaEntrypoint(r)).pipe(
          Effect.flatMap((exit) =>
            Exit.isSuccess(exit)
              ? Effect.succeed(exit.value.run)
              : Effect.fail(new ProbeRunnerUnavailable({ reason: JSON.stringify(exit.cause) })),
          ),
        ),
    }),
  ),
  prepared: {
    pass: request(probes("pass"), world),
    fail: request(probes("fail"), world),
    "n/a": request(probes("n/a"), world),
    "harness-error": request(probes("harness-error"), world),
  },
}));

describe("the Tier 1 probe runner", () => {
  it("[tier1.reports] reads what the probe printed, with its observations and the reason it gave", async () => {
    expect((await answered(request(probes("fail"), world))).run).toEqual({
      _tag: "ran",
      outcome: "fail",
      reason: "flag -> 1 (expected 2)",
      observations: ["flag -> 1 (expected 2)"],
    });
    expect((await answered(request(probes("n/a"), world))).run).toMatchObject({
      _tag: "ran",
      outcome: "n/a",
      reason: "no flag route in this world",
    });
  });

  it("[tier1.zero-egress] bundles and runs a world with dependencies from its deps bundle, with not one outbound request", async () => {
    await putDeps(TINY_LOCK, TINY_DEPS);
    const tinyWorld = await putBundle(TINY_WORLD);
    const tinyProbe = await putBundle(TINY_PROBE);
    const before = await egress();
    expect((await answered(request(tinyProbe, tinyWorld))).run).toMatchObject({
      _tag: "ran",
      outcome: "pass",
    });
    expect(await egress()).toEqual(before);
  });

  it("[tier1.bundler-fenced] refuses to bundle files that still declare a dependency, before any fetch", async () => {
    const mounted = probeWorkerFiles(
      [],
      [{ path: ".keel/t.test.ts", bytes: new TextEncoder().encode("") }],
      undefined,
    );
    const files = {
      ...mounted.files,
      "package.json": JSON.stringify({ dependencies: { hono: "4.13.13" } }),
    };
    const before = await egress();
    await expect(bundleProbe({ ...mounted, files })).rejects.toBeInstanceOf(BundlerFenced);
    expect(await egress()).toEqual(before);
  });

  it("[tier1.fresh-isolate] runs every run on a fresh isolate", async () => {
    const first = await answered(request(probes("pass"), world, 1));
    const second = await answered(request(probes("pass"), world, 2));
    expect(first.run).toMatchObject({ _tag: "ran", outcome: "pass" });
    expect(second.run).toMatchObject({ _tag: "ran", outcome: "pass" });
    expect(first.instance).toBeDefined();
    expect(second.instance).not.toBe(first.instance);
  });

  it("[tier1.queues] answers five runs at once on one VerifierDO, the fifth after waiting for a slot", async () => {
    const answers = await Promise.all(
      [1, 2, 3, 4, 5].map((run) => answered(request(probes("naps"), world, run))),
    );
    expect(answers.map((a) => a.run)).toEqual(
      answers.map(() => expect.objectContaining({ _tag: "ran", outcome: "pass" })),
    );
    expect(answers.filter((a) => a.queued)).toHaveLength(1);
  });

  it("[tier1.bundle-verified] is unavailable for a probe bundle that does not hash to its key", async () => {
    const real = await env.BUNDLES.get(`ns/${NAMESPACE}/bundles/${probes("pass").slice(7)}`);
    const forged = Schema.decodeUnknownSync(ContentHash)(`sha256:${"0".repeat(63)}1`);
    await env.BUNDLES.put(`ns/${NAMESPACE}/bundles/${forged.slice(7)}`, await real!.arrayBuffer());
    expect(await reasonOf(request(forged, world))).toContain("does not hash to its key");
  });

  it("[tier1.deps-keyed] is unavailable, lockfile-diverged, when no deps bundle was installed from the world's lockfile", async () => {
    const otherLock = `${TINY_LOCK}# another resolution\n`;
    const unkeyed = await putBundle({ ...TINY_WORLD, "pnpm-lock.yaml": otherLock });
    const tinyProbe = await putBundle(TINY_PROBE);
    expect(await reasonOf(request(tinyProbe, unkeyed))).toContain(
      "lockfile-diverged: no deps bundle",
    );
    // A pointer for the other lockfile that names a bundle installed from TINY_LOCK.
    const installed = await putBundle({ ...TINY_DEPS, "pnpm-lock.yaml": TINY_LOCK });
    await env.BUNDLES.put(
      `ns/${NAMESPACE}/probe-deps/${await sha256Hex(new TextEncoder().encode(otherLock))}`,
      installed.slice(7),
    );
    expect(await reasonOf(request(tinyProbe, unkeyed))).toContain(
      "was not installed from pnpm-lock.yaml",
    );
  });

  it("[deps.pool.probe-deps-slot] reads its hand-made deps pointer from probe-deps, and takes nothing kept under the same hash in the deps family for it", async () => {
    const lock = `${TINY_LOCK}# a lockfile with something kept under its hash in each family\n`;
    // Tier 1's pointer is made by hand and keyed by the lockfile's own sha256: the hex it is looked up under.
    const hex = await sha256Hex(new TextEncoder().encode(lock));
    const lockedWorld = await putBundle({ ...TINY_WORLD, "pnpm-lock.yaml": lock });
    const tinyProbe = await putBundle(TINY_PROBE);
    // A deps box keys its pointer by an install digest, so none of a box's own sits under a lockfile's hash.
    // This one is put there by hand, in the shape a box writes: it is what a read of the wrong family would
    // find, and it names a Tier 2 build's parts, which is no bundle's hash.
    const inDeps = {
      format: "keel.deps/1",
      install: hex,
      toolchain: "node v22.22.3 pnpm 11.18.0 ubuntu 24.04",
      parts: [{ sha256: "f".repeat(64), bytes: 5 }],
      files: 1,
      installMs: 1,
    };
    await env.BUNDLES.put(`ns/${NAMESPACE}/deps/${hex}`, JSON.stringify(inDeps));
    expect(await reasonOf(request(tinyProbe, lockedWorld))).toContain(
      "lockfile-diverged: no deps bundle",
    );
    // With its own pointer in probe-deps the probe runs, and what was put in `deps` is as it was.
    await putDeps(lock, TINY_DEPS);
    expect((await answered(request(tinyProbe, lockedWorld))).run).toMatchObject({
      _tag: "ran",
      outcome: "pass",
    });
    const kept = await env.BUNDLES.get(`ns/${NAMESPACE}/deps/${hex}`);
    expect(JSON.parse((await kept?.text()) ?? "null")).toEqual(inDeps);
  });

  it("[t5.pool.verifier-other-namespace] is unavailable for a probe and world kept for another namespace, and for a deps bundle another namespace installed", async () => {
    // The pass probe and its world are NAMESPACE's: a run that names OTHER finds neither.
    expect(await reasonOf(request(probes("pass"), world, 1, OTHER))).toContain(
      `bundle ns/org_01JZ8PT2C4E6G8J0M2N4Q6S8V1/bundles/`,
    );
    expect((await answered(request(probes("pass"), world, 1))).run).toMatchObject({
      _tag: "ran",
      outcome: "pass",
    });
    // OTHER's own world and probe, with dependencies only NAMESPACE has a deps bundle for.
    await putDeps(TINY_LOCK, TINY_DEPS);
    const theirWorld = await putBundle(TINY_WORLD, OTHER);
    const theirProbe = await putBundle(TINY_PROBE, OTHER);
    expect(await reasonOf(request(theirProbe, theirWorld, 1, OTHER))).toContain(
      "lockfile-diverged: no deps bundle",
    );
    await putDeps(TINY_LOCK, TINY_DEPS, OTHER);
    expect((await answered(request(theirProbe, theirWorld, 1, OTHER))).run).toMatchObject({
      _tag: "ran",
      outcome: "pass",
    });
  });

  it("[t5.pool.verifier-per-namespace] gives each namespace its own VerifierDO: three runs each of one probe and world, at once, and none waits for a slot", async () => {
    // The same bytes kept for both namespaces: the same hashes, so only the namespace tells the DOs apart.
    await putBundle(FLAG_WORLD, OTHER);
    await putBundle(PROBES.naps, OTHER);
    const answers = await Promise.all(
      [NAMESPACE, OTHER].flatMap((namespace) =>
        [1, 2, 3].map((run) => answered(request(probes("naps"), world, run, namespace))),
      ),
    );
    expect(answers.map((a) => a.run)).toEqual(
      answers.map(() => expect.objectContaining({ _tag: "ran", outcome: "pass" })),
    );
    // One DO runs four at once and queues the rest: six runs on a shared DO would queue two.
    expect(answers.filter((a) => a.queued)).toHaveLength(0);
  });

  it("[tier1.harness-errors] answers a probe that will not mount or bundle as a harness error, with why", async () => {
    expect((await answered(request(probes("outsideKeel"), world))).run).toMatchObject({
      _tag: "harness-error",
      reason: "probe mount refused: flag.test.ts is outside .keel/",
    });
    const vi = await answered(request(probes("usesVi"), world));
    expect(vi.run).toMatchObject({ _tag: "harness-error" });
    expect(vi.run.reason).toMatch(/^the probe did not bundle: .*No matching export .* "vi"/);
  });

  it("[tier1.deadline] makes a probe that runs past its deadline a harness error", async () => {
    const tier1: Tier1 = { env, slots: new Semaphore(4), deadlineMs: 500 };
    const answer = await runProbe(tier1, new Map(), {
      namespace: NAMESPACE,
      probe: probes("sleeps"),
      worldBundle: world,
    });
    expect(answer).toMatchObject({
      _tag: "answered",
      run: { _tag: "harness-error", reason: "the probe ran past its 500 ms deadline" },
    });
  }, 20_000);
});

describe("verifierName", () => {
  it("[t5.verifier-name] names one VerifierDO per (namespace, probe, world)", () => {
    const [probe, worldBundle] = [
      Schema.decodeUnknownSync(ContentHash)(`sha256:${"a".repeat(64)}`),
      Schema.decodeUnknownSync(ContentHash)(`sha256:${"b".repeat(64)}`),
    ];
    expect(verifierName({ namespace: NAMESPACE, probe, world: "A", worldBundle, run: 1 })).toBe(
      `probe:org_01JZ8PT2C4E6G8J0M2N4Q6S8V0:${"a".repeat(64)}:${"b".repeat(64)}`,
    );
    expect(verifierName({ namespace: OTHER, probe, world: "A", worldBundle, run: 1 })).toBe(
      `probe:org_01JZ8PT2C4E6G8J0M2N4Q6S8V1:${"a".repeat(64)}:${"b".repeat(64)}`,
    );
  });
});

describe("judgeIsolate", () => {
  it("[tier1.isolate-check] accepts only the fresh isolate that is still there after the run", () => {
    expect(
      judgeIsolate({ instance: "a", served: 1 }, { instance: "a", served: 2 }),
    ).toBeUndefined();
    expect(judgeIsolate({ instance: "a", served: 2 }, { instance: "a", served: 3 })).toBe(
      "the probe ran on an isolate that had already served 1 request(s)",
    );
    expect(judgeIsolate({ instance: "a", served: 1 }, { instance: "b", served: 1 })).toBe(
      "the isolate was replaced during the run (a, then b)",
    );
    expect(judgeIsolate({ instance: "a", served: 1 }, { instance: "a", served: 3 })).toBe(
      "the isolate served 3 request(s) by its check, not 2",
    );
  });
});
