import { Sandbox } from "@cloudflare/sandbox";
import {
  DEPS_INSTALL_SECONDS,
  DEPS_PART_BYTES,
  DEPS_TOOLCHAIN,
  type DepsAnswer,
  type DepsPart,
  DepsPointer,
  type DepsRefused,
  depsRefusal,
  type DepsUnavailable,
  type Locked,
  namespaceKey,
  parseDepsBuild,
  pointerServes,
} from "@keeltown/core/application/verification";
import type { NamespaceId } from "@keeltown/core/kernel";
import { BUNDLE_HOST, DEPS_BUILD_COMMAND, DEPS_HOST, sha256Hex } from "@keeltown/runner-protocol";
import { Exit, Option, Schema } from "effect";
import {
  type DepsBoxRpc,
  DepsBuilding,
  DepsBuildRequest,
  DepsCodecs,
  encodeExit,
} from "../../../rpc/index.ts";
import { BUNDLE_HOSTS, refuseEgress, serveBundle } from "./keel-sandbox.ts";

/** The one host off Keel a deps box reaches: the public registry, read through `passRegistry` and never directly. */
export const REGISTRY_HOST = "registry.npmjs.org";

/** A part's address on the upload host: `/<sha256 hex>`, and nothing else. The namespace is never in the path. */
const PART_PATH = /^\/([0-9a-f]{64})$/;

/** Where the object keeps the (namespace, install digest) it was first asked for. */
const OWNER_KEY = "keel.deps.owner";

/**
 * How long the whole command may run: the install's own bound, and three
 * minutes around it for fetching the bundle, packing and uploading the parts.
 */
const COMMAND_TIMEOUT_MS = (DEPS_INSTALL_SECONDS + 180) * 1_000;

/**
 * What the deps box's command is started with, and nothing else: exec passes
 * on only PATH, so HOME is given explicitly. Never a credential: the box
 * reaches its bundle by a signed URL and uploads through its own handler.
 */
export interface DepsInstallEnv {
  readonly HOME: string;
  readonly KEEL_BUNDLE_URL: string;
  readonly KEEL_INSTALL: string;
  readonly KEEL_INSTALL_INPUTS: string;
  readonly KEEL_DEPS_UPLOAD: string;
}

/**
 * One build as its object saw it, logged when it answers: `built` by this
 * box's own install, `reused` from the pointer already kept, `refused` with
 * why when only a change to the candidate ends it, or `unavailable` with why.
 * A caller that joined a build in flight logs nothing of its own.
 */
export interface DepsBuilt {
  readonly event: "keel.deps.built";
  readonly namespace: string;
  readonly install: string;
  readonly outcome: "built" | "reused" | "refused" | "unavailable";
  readonly parts?: number;
  readonly bytes?: number;
  readonly files?: number;
  readonly installMs?: number;
  readonly reason?: string;
  readonly ms: number;
}

const decodeBuild = Schema.decodeUnknownExit(DepsBuildRequest);
const decodeOwner = Schema.decodeUnknownOption(DepsBuilding);
const decodePointer = Schema.decodeUnknownOption(DepsPointer);

const describeError = (error: unknown): string =>
  error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : JSON.stringify(error);

const unavailable = (reason: string): DepsUnavailable => ({ _tag: "DepsUnavailable", reason });

const totalBytes = (parts: readonly DepsPart[]): number =>
  parts.reduce((total, part) => total + part.bytes, 0);

/**
 * Whether `bundleUrl` is one of this namespace's bundles on the bundle host.
 * The bundle host checks the signature when the box fetches; this only keeps
 * a build for one namespace from being started on another's bundle.
 */
function isBundleOf(namespace: NamespaceId, bundleUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(bundleUrl);
  } catch {
    return false;
  }
  return url.hostname === BUNDLE_HOST && url.pathname.startsWith(`/${namespace}/`);
}

/**
 * Answers a deps box's `GET registry.npmjs.org/<path>` by fetching the same
 * path and query from the registry over HTTPS and passing the response
 * through. The box has no HTTPS of its own, so pnpm speaks plain HTTP to this
 * handler and still checks every tarball against the lockfile's integrity
 * hash. Every GET passes, not only tarballs: pnpm also reads packuments and
 * attestations. Nothing but GET does, so the box can publish nothing, and no
 * header of the box's is sent on but `accept`: a token a candidate's `.npmrc`
 * sets never leaves Keel. A redirect is passed through as it is and never
 * followed: following one here would fetch from whatever host it names, for a
 * box that can reach none but the registry itself.
 */
export async function passRegistry(request: Request): Promise<Response> {
  if (request.method !== "GET")
    return new Response("the registry is read-only from a deps box", { status: 405 });
  const url = new URL(request.url);
  const accept = request.headers.get("accept");
  // The host is written here, never taken from the request: a path cannot name another.
  return fetch(`https://${REGISTRY_HOST}${url.pathname}${url.search}`, {
    headers: accept === null ? {} : { accept },
    redirect: "manual",
  });
}

/**
 * The box's body, or null when it is over `limit`: by the length it declares,
 * before anything is read, or by what it sends, so no more than one part is
 * ever held.
 */
async function bodyWithin(request: Request, limit: number): Promise<Uint8Array | null> {
  if (Number(request.headers.get("content-length") ?? "0") > limit) return null;
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > limit) {
      await reader.cancel("the part is over its size");
      return null;
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Who the box with this container id is building for: null for an id that is no deps box's, or a box that is not building. */
async function buildingFor(env: Env, containerId: string): Promise<DepsBuilding | null> {
  let id: DurableObjectId;
  try {
    id = env.DEPSBOX.idFromString(containerId);
  } catch {
    return null;
  }
  return env.DEPSBOX.get(id).building();
}

/**
 * Answers a deps box's `PUT deps.keel.internal/<sha256>` by keeping the body
 * as that part of the namespace the box is building for, at the namespace's
 * own `deps-parts` key.
 *
 * The namespace is never read from the request. The proxy names the container
 * the request left, and that box's own object says who it is building for: a
 * box that is not building, or a container that is no deps box, is refused
 * (403), so a part lands under the building namespace whatever the box sends.
 *
 * The path is the part's address. R2 is told the sha256 and keeps nothing
 * whose bytes hash to another, so a part is always what its key says (400
 * otherwise). A part is at most DEPS_PART_BYTES (413).
 */
export async function uploadDepsPart(
  request: Request,
  env: Env,
  ctx: { readonly containerId: string },
): Promise<Response> {
  if (request.method !== "PUT")
    return new Response("a deps part is uploaded with PUT", { status: 405 });
  const [, sha256] = PART_PATH.exec(new URL(request.url).pathname) ?? [];
  if (sha256 === undefined) return new Response("not a part's address", { status: 400 });
  const building = await buildingFor(env, ctx.containerId);
  if (building === null)
    return new Response("no deps build is in flight for this box", { status: 403 });
  const bytes = await bodyWithin(request, DEPS_PART_BYTES);
  if (bytes === null)
    return new Response(`a part is at most ${DEPS_PART_BYTES} bytes`, { status: 413 });
  try {
    await env.BUNDLES.put(namespaceKey(building.namespace, "deps-parts", sha256), bytes, {
      sha256,
    });
  } catch (error) {
    // R2 refused and kept nothing. The digest is taken only to say why: R2's check is the one that holds.
    if ((await sha256Hex(bytes)) !== sha256)
      return new Response("the body is not the part its path names", { status: 400 });
    return new Response(`the part could not be kept: ${describeError(error)}`, { status: 502 });
  }
  return new Response(null, { status: 200 });
}

/** A build in flight: who it is for, and the answer every caller of it gets. */
interface Flight {
  readonly owner: DepsBuilding;
  readonly answer: Promise<DepsAnswer>;
}

/**
 * KeelDepsBox: installs a candidate's dependencies from its lockfile, once
 * for a namespace and an install digest, and keeps them in BUNDLES as parts
 * with a pointer. There is one object per (namespace, digest), and that is the
 * single-flight: the object remembers the pair it was first asked for and
 * refuses any other, callers that arrive while it builds join the build in
 * flight, and a pointer already kept is answered with no container started.
 *
 * The container runs the same image as KeelSandbox and holds no credential.
 * Egress: the internet is off, and nothing is intercepted over HTTPS, so the
 * box has no HTTPS at all. The allowed hosts are the registry and
 * `*.keel.internal`, which puts the container in intercept-all mode: every
 * plain HTTP request reaches the handlers below. An allowed host with no
 * handler would be handed to the Worker's own fetch, so every allowed host
 * has one and `*` refuses.
 *
 * The box is trusted with nothing: it uploads parts, each under its own
 * sha256, and reports. The object checks that every part the report names is
 * kept at the size reported, and only then writes the pointer itself.
 */
export class KeelDepsBox extends Sandbox<Env> implements DepsBoxRpc {
  override enableInternet = false;
  override interceptHttps = false;
  override allowedHosts = [REGISTRY_HOST, BUNDLE_HOSTS];

  /** The build in flight, if any. Cleared when it settles, so a call after a failure builds again. */
  private depsFlight: Flight | undefined;

  /** How many builds have settled: a pointer read that spans one is taken again. */
  private depsSettled = 0;

  async build(request: unknown) {
    const decoded = decodeBuild(request);
    const answer = Exit.isFailure(decoded)
      ? unavailable("the deps build request did not decode")
      : await this.answerFor(decoded.value);
    return encodeExit(DepsCodecs.build, Exit.succeed(answer));
  }

  async building(): Promise<DepsBuilding | null> {
    return this.depsFlight === undefined ? null : this.depsFlight.owner;
  }

  /**
   * The one place a container is started: the whole build, as the runner
   * protocol's command, which always exits 0 and reports on stdout. A pool
   * test stands in for it, since the pool runs no container.
   */
  protected async install(env: DepsInstallEnv): Promise<string> {
    const result = await this.exec(DEPS_BUILD_COMMAND, {
      timeout: COMMAND_TIMEOUT_MS,
      env: { ...env },
    });
    return result.stdout;
  }

  /** The pair this object was first asked for, kept so it is the same object's after an eviction. */
  private async ownerOr(asked: DepsBuilding): Promise<DepsBuilding> {
    const kept = decodeOwner(await this.ctx.storage.get(OWNER_KEY));
    if (Option.isSome(kept)) return kept.value;
    await this.ctx.storage.put(OWNER_KEY, asked);
    return asked;
  }

  /** The parts the namespace's pointer names for this install digest, when it is a pointer that serves the need. */
  private async kept(namespace: NamespaceId, need: Locked): Promise<DepsPointer | undefined> {
    const object = await this.env.BUNDLES.get(namespaceKey(namespace, "deps", need.install));
    if (object === null) return undefined;
    let json: unknown;
    try {
      json = JSON.parse(await object.text());
    } catch {
      return undefined;
    }
    const pointer = decodePointer(json);
    return Option.isSome(pointer) && pointerServes(pointer.value, need) ? pointer.value : undefined;
  }

  private async answerFor(request: DepsBuildRequest): Promise<DepsAnswer> {
    const { namespace, need } = request;
    const asked: DepsBuilding = { namespace, install: need.install };
    const owner = await this.ownerOr(asked);
    if (owner.namespace !== asked.namespace || owner.install !== asked.install)
      return unavailable(
        `this deps box builds ${owner.install} for ${owner.namespace}, and was asked for ${asked.install} for ${asked.namespace}`,
      );
    if (!isBundleOf(namespace, request.bundleUrl))
      return unavailable(`the bundle URL is not one of ${namespace}'s bundles`);
    for (;;) {
      const started = Date.now();
      const settled = this.depsSettled;
      const pointer = await this.kept(namespace, need);
      if (pointer !== undefined) {
        this.log(asked, started, {
          outcome: "reused",
          parts: pointer.parts.length,
          bytes: totalBytes(pointer.parts),
          files: pointer.files,
          installMs: pointer.installMs,
        });
        return { _tag: "DepsReady", install: pointer.install, parts: pointer.parts };
      }
      // The object builds for one digest, so the build in flight is this caller's too.
      const flight = this.depsFlight;
      if (flight !== undefined) return flight.answer;
      // A build ended while the pointer was being read: what it wrote may serve.
      if (this.depsSettled !== settled) continue;
      return this.launch(asked, request);
    }
  }

  /** Starts the one build, in the same turn that found none in flight, so no second caller can start another. */
  private launch(owner: DepsBuilding, request: DepsBuildRequest): Promise<DepsAnswer> {
    const answer = this.run(owner, request);
    const flight: Flight = { owner, answer };
    this.depsFlight = flight;
    const landed = () => {
      this.depsSettled += 1;
      if (this.depsFlight === flight) this.depsFlight = undefined;
    };
    answer.then(landed, landed);
    return answer;
  }

  /** One build, and the box destroyed after it whatever it answered: a container left up is billed, and holds a candidate's tree. */
  private async run(owner: DepsBuilding, request: DepsBuildRequest): Promise<DepsAnswer> {
    const started = Date.now();
    let answer: DepsAnswer;
    try {
      answer = await this.make(owner, request, started);
    } finally {
      // A teardown that fails changes nothing about the build: the answer stands, and the container sleeps by itself.
      await this.destroy().catch((error: unknown) =>
        console.warn(
          JSON.stringify({
            event: "keel.deps.box-left",
            namespace: owner.namespace,
            install: owner.install,
            error: describeError(error),
          }),
        ),
      );
    }
    return answer;
  }

  private async make(
    owner: DepsBuilding,
    request: DepsBuildRequest,
    started: number,
  ): Promise<DepsAnswer> {
    const { namespace, need } = request;
    const stop = (answer: DepsRefused | DepsUnavailable): DepsAnswer => {
      this.log(owner, started, {
        outcome: answer._tag === "DepsRefused" ? "refused" : "unavailable",
        reason: answer.reason,
      });
      return answer;
    };
    const refuse = (reason: string): DepsAnswer => stop(unavailable(reason));
    let stdout: string;
    try {
      stdout = await this.install({
        HOME: "/root",
        KEEL_BUNDLE_URL: request.bundleUrl,
        KEEL_INSTALL: need.install,
        KEEL_INSTALL_INPUTS: need.inputs,
        KEEL_DEPS_UPLOAD: `http://${DEPS_HOST}`,
      });
    } catch (error) {
      return refuse(`box-failed: ${describeError(error)}`);
    }
    const report = parseDepsBuild(stdout);
    // Only what the box itself refused is read for whose fault it was: output that is no report never is.
    if (report._tag === "refused") return stop(depsRefusal(report.reason));
    if (report._tag !== "built") return refuse(report.reason);
    // Another toolchain's node_modules is not what the pointer would say it is: nothing of it is kept.
    if (report.toolchain !== DEPS_TOOLCHAIN)
      return refuse(
        `toolchain-mismatch: the box built with ${report.toolchain}, not ${DEPS_TOOLCHAIN}`,
      );
    // The report is the box's word. Every part it names must be kept, at the size it names, before any pointer says so.
    for (const part of report.parts) {
      const stored = await this.env.BUNDLES.head(
        namespaceKey(namespace, "deps-parts", part.sha256),
      );
      if (stored === null || stored.size !== part.bytes)
        return refuse(`part-missing: ${part.sha256} is not kept at ${part.bytes} bytes`);
    }
    const pointer: DepsPointer = {
      format: "keel.deps/1",
      install: need.install,
      toolchain: report.toolchain,
      parts: report.parts,
      files: report.files,
      installMs: report.installMs,
    };
    await this.env.BUNDLES.put(
      namespaceKey(namespace, "deps", need.install),
      JSON.stringify(pointer),
    );
    this.log(owner, started, {
      outcome: "built",
      parts: pointer.parts.length,
      bytes: totalBytes(pointer.parts),
      files: pointer.files,
      installMs: pointer.installMs,
    });
    return { _tag: "DepsReady", install: pointer.install, parts: pointer.parts };
  }

  private log(
    owner: DepsBuilding,
    started: number,
    what: Omit<DepsBuilt, "event" | "namespace" | "install" | "ms">,
  ): void {
    console.log(
      JSON.stringify({
        event: "keel.deps.built",
        namespace: owner.namespace,
        install: owner.install,
        ...what,
        ms: Date.now() - started,
      } satisfies DepsBuilt),
    );
  }
}

// Assigned, never declared as a static class field: a field would define an own
// property and bypass Container's registry setter, silently dropping every
// handler. An exact host wins over a glob, and the first matching glob wins,
// so every `*.keel.internal` host but the two named here falls to `*`.
KeelDepsBox.outboundByHost = {
  [REGISTRY_HOST]: (request) => passRegistry(request),
  [BUNDLE_HOST]: (request, env, ctx) => serveBundle(request, env, ctx),
  [DEPS_HOST]: (request, env, ctx) => uploadDepsPart(request, env, ctx),
  "*": (request) => refuseEgress(request),
};
