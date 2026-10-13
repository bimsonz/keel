import { namespaceKey, type ProbeRun, readProbeRun } from "@keeltown/core/application/verification";
import type { ContentHash, NamespaceId } from "@keeltown/core/kernel";
import {
  BundleUnreadable,
  type BundleFile,
  depsNeed,
  LOCKFILE,
  MountRefused,
  probeWorkerFiles,
  readBundle,
  type Semaphore,
  sha256Hex,
} from "@keeltown/runner-protocol";
import { type BundledProbe, BundlerFenced, bundleProbe, ProbeUnbundlable } from "./bundle.ts";

/** Isolates a VerifierDO runs at once: the 5th Dynamic Worker call per request throws (spike S14). */
export const PROBE_SLOTS = 4;

/** Wall-clock bound on one run, from its slot to the isolate check. `cpuMs` is advisory on a fresh isolate. */
export const PROBE_DEADLINE_MS = 30_000;

/** Rule R13's one compatibility date, for the isolates too. */
const COMPATIBILITY_DATE = "2026-10-01";

/** The bindings a probe run uses, each called in place so the readonly-bundles and loader-spec guards read every use. */
export type Tier1Env = Pick<Env, "BUNDLES" | "LOADER">;

/** What a VerifierDO needs to run probes: the bundle store (read only), the loader, its slots and its deadline. */
export interface Tier1 {
  readonly env: Tier1Env;
  readonly slots: Semaphore;
  readonly deadlineMs: number;
}

/** One run: a namespace's probe bundle against one of its world bundles. */
export interface Tier1Request {
  readonly namespace: NamespaceId;
  readonly probe: ContentHash;
  readonly worldBundle: ContentHash;
}

/** The isolate that answered, as its entry reports it: a fresh one has served exactly one request. */
export interface IsolateSeen {
  readonly instance: string;
  readonly served: number;
}

export type Tier1Answer =
  | {
      readonly _tag: "answered";
      readonly run: ProbeRun;
      readonly queued: boolean;
      readonly instance?: string;
    }
  | { readonly _tag: "unavailable"; readonly reason: string };

/** Bundles already built for a (probe, world), so each world's three runs bundle once. */
export type BundleCache = Map<string, Promise<BundledProbe>>;

/** The runner could not run the probe at all: no answer, and nothing about the probe. */
class Unavailable extends Error {}

/** The probe or its harness broke: an answer, never a cell. */
class HarnessError extends Error {}

const hexOf = (hash: ContentHash): string => hash.slice("sha256:".length);

/** A namespace's bundle from the store, checked against the hash it is keyed by. */
async function fetchVerified(
  env: Tier1Env,
  namespace: NamespaceId,
  hex: string,
  what: string,
): Promise<BundleFile[]> {
  const key = namespaceKey(namespace, "bundles", hex);
  const object = await env.BUNDLES.get(key);
  if (object === null) throw new Unavailable(`${what} ${key} is not in the bundle store`);
  const bytes = new Uint8Array(await object.arrayBuffer());
  if ((await sha256Hex(bytes)) !== hex)
    throw new Unavailable(`${what} ${key} does not hash to its key`);
  try {
    return await readBundle(bytes);
  } catch (error) {
    if (error instanceof BundleUnreadable)
      throw new Unavailable(`${what} ${key}: ${error.message}`);
    throw error;
  }
}

/**
 * The world's deps bundle: the namespace's `probe-deps/<lockfile sha256>`
 * names a bundle of that namespace by its hash, and that bundle carries the
 * very lockfile it was installed from. None for a world with no runtime
 * dependencies. This pointer is made by hand (hoisted, production only, one
 * readable bundle); the `deps` family holds another artifact for the same
 * lockfile, the pointer a deps box writes to a Tier 2 build's parts, so the
 * two never share a slot.
 */
async function depsFor(
  env: Tier1Env,
  namespace: NamespaceId,
  world: readonly BundleFile[],
): Promise<BundleFile[] | undefined> {
  const need = await depsNeed(world);
  if (need._tag === "none") return undefined;
  if (need._tag === "unkeyed") throw new Unavailable(`lockfile-diverged: ${need.reason}`);
  const pointerKey = namespaceKey(namespace, "probe-deps", need.sha256);
  const pointer = await env.BUNDLES.get(pointerKey);
  if (pointer === null)
    throw new Unavailable(`lockfile-diverged: no deps bundle for ${LOCKFILE} ${need.sha256}`);
  const hex = (await pointer.text()).trim();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Unavailable(`${pointerKey} does not name a bundle`);
  const deps = await fetchVerified(env, namespace, hex, "deps bundle");
  const lockfile = deps.find((file) => file.path === LOCKFILE);
  if (lockfile === undefined || (await sha256Hex(lockfile.bytes)) !== need.sha256)
    throw new Unavailable(
      `lockfile-diverged: deps bundle ${hex} was not installed from ${LOCKFILE} ${need.sha256}`,
    );
  return deps;
}

/** Whether a probe could run against a world as the namespace's store stands, and why not. */
export type WorldReadiness =
  | { readonly _tag: "Ready" }
  | { readonly _tag: "Unready"; readonly reason: string };

/**
 * Whether a probe could run against this world as the namespace's store
 * stands: the world bundle is read and its deps bundle found and checked,
 * the reads `build` makes before it bundles, so what is unready here is what
 * every run would be refused for. Nothing is bundled and no isolate runs.
 */
export async function worldReady(
  env: Tier1Env,
  request: Pick<Tier1Request, "namespace" | "worldBundle">,
): Promise<WorldReadiness> {
  try {
    const world = await fetchVerified(
      env,
      request.namespace,
      hexOf(request.worldBundle),
      "world bundle",
    );
    await depsFor(env, request.namespace, world);
    return { _tag: "Ready" };
  } catch (error) {
    if (error instanceof Unavailable) return { _tag: "Unready", reason: error.message };
    throw error;
  }
}

async function build(env: Tier1Env, request: Tier1Request): Promise<BundledProbe> {
  const [probe, world] = await Promise.all([
    fetchVerified(env, request.namespace, hexOf(request.probe), "probe bundle"),
    fetchVerified(env, request.namespace, hexOf(request.worldBundle), "world bundle"),
  ]);
  const deps = await depsFor(env, request.namespace, world);
  try {
    return await bundleProbe(probeWorkerFiles(world, probe, deps));
  } catch (error) {
    if (error instanceof MountRefused || error instanceof ProbeUnbundlable)
      throw new HarnessError(error.message);
    if (error instanceof BundlerFenced) throw new Unavailable(error.message);
    throw error;
  }
}

/**
 * Whether the isolate that ran the probe is the one that was checked after:
 * it must have been fresh (served 1) and still be there (same instance,
 * served 2). A replaced isolate, say after a memory overrun that still
 * answered ok (spike S14), makes the run a harness error.
 */
export function judgeIsolate(run: IsolateSeen, check: IsolateSeen): string | undefined {
  if (run.served !== 1)
    return `the probe ran on an isolate that had already served ${run.served - 1} request(s)`;
  if (check.instance !== run.instance)
    return `the isolate was replaced during the run (${run.instance}, then ${check.instance})`;
  if (check.served !== 2)
    return `the isolate served ${check.served} request(s) by its check, not 2`;
  return undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

async function reply(response: Response): Promise<Record<string, unknown> & IsolateSeen> {
  const text = await response.text();
  if (!response.ok)
    throw new HarnessError(`the isolate answered HTTP ${response.status}: ${text.slice(0, 300)}`);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HarnessError(`the isolate answered something other than JSON: ${text.slice(0, 300)}`);
  }
  if (!isRecord(body) || typeof body["instance"] !== "string" || typeof body["served"] !== "number")
    throw new HarnessError(`the isolate did not say which isolate it is: ${text.slice(0, 300)}`);
  return { ...body, instance: body["instance"], served: body["served"] };
}

async function withDeadline<T>(ms: number, work: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new HarnessError(`the probe ran past its ${ms} ms deadline`)),
      ms,
    );
  });
  try {
    return await Promise.race([work(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** One run on a fresh isolate (a new random id every time: warm reuse leaks module state), with no network. */
async function runIsolate(tier1: Tier1, bundled: BundledProbe) {
  const stub = tier1.env.LOADER.get(crypto.randomUUID(), () => ({
    compatibilityDate: COMPATIBILITY_DATE,
    mainModule: bundled.mainModule,
    modules: bundled.modules,
    globalOutbound: null,
  }));
  return withDeadline(tier1.deadlineMs, async () => {
    const entry = stub.getEntrypoint();
    let ran: Awaited<ReturnType<typeof reply>>;
    let check: IsolateSeen;
    try {
      ran = await reply(await entry.fetch("https://probe.invalid/run"));
      check = await reply(await entry.fetch("https://probe.invalid/instance"));
    } catch (error) {
      if (error instanceof HarnessError) throw error;
      throw new HarnessError(
        `the isolate failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
      );
    }
    const replaced = judgeIsolate(ran, check);
    if (replaced !== undefined) throw new HarnessError(replaced);
    const stdout = typeof ran["stdout"] === "string" ? ran["stdout"] : undefined;
    const exit = typeof ran["exit"] === "number" ? ran["exit"] : undefined;
    return { run: readProbeRun(stdout, exit), instance: ran.instance };
  });
}

const harnessError = (error: HarnessError, queued: boolean): Tier1Answer => ({
  _tag: "answered",
  run: { _tag: "harness-error", reason: error.message, observations: [] },
  queued,
});

/**
 * Runs a probe against one world in Tier 1: the namespace's bundles verified
 * by their hashes, the world's deps from the deps bundle its lockfile names
 * in that namespace, bundled
 * once per (probe, world), then run on a fresh isolate with no network
 * inside one of the DO's slots, under a deadline, with the isolate checked
 * after. What the probe reported is read by `readProbeRun`.
 */
export async function runProbe(
  tier1: Tier1,
  cache: BundleCache,
  request: Tier1Request,
): Promise<Tier1Answer> {
  const key = `${request.namespace}:${request.probe}:${request.worldBundle}`;
  let bundled: BundledProbe;
  try {
    let pending = cache.get(key);
    if (pending === undefined) {
      pending = build(tier1.env, request);
      cache.set(key, pending);
      pending.catch(() => cache.delete(key));
    }
    bundled = await pending;
  } catch (error) {
    if (error instanceof Unavailable) return { _tag: "unavailable", reason: error.message };
    if (error instanceof HarnessError) return harnessError(error, false);
    throw error;
  }
  const slot = await tier1.slots.acquire();
  try {
    const { run, instance } = await runIsolate(tier1, bundled);
    return { _tag: "answered", run, queued: slot.queued, instance };
  } catch (error) {
    if (error instanceof HarnessError) return harnessError(error, slot.queued);
    throw error;
  } finally {
    slot.release();
  }
}
