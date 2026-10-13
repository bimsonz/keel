import { namespaceKey } from "@keeltown/core/application/verification";
import { NamespaceId } from "@keeltown/core/kernel";
import { bundleUrlSigned, DEPS_HOST, depsPartUrlSigned } from "@keeltown/runner-protocol";
import { Schema } from "effect";
import { CiSandbox } from "./ci-sandbox.js";

type BackupOptions = Parameters<CiSandbox["createBackup"]>[0];
type BackupHandle = Parameters<CiSandbox["restoreBackup"]>[0];
type ExecOptions = Parameters<CiSandbox["execWithSessionToken"]>[2];

/** The one host family a sandbox may reach: virtual, answered here, never on the internet. */
export const BUNDLE_HOSTS = "*.keel.internal";

/** An object's address on a host: `/<namespace id>/<sha256 hex>`, and nothing else. A bundle's and a deps part's alike. */
const BUNDLE_PATH = /^\/([^/]+)\/([0-9a-f]{64})$/;

const isNamespace = Schema.is(NamespaceId);

/**
 * One bundle read as the handler saw it, logged when its stream ends: what R2
 * said the object was, and what was actually read from it. A read that ends
 * short, errors, or hashes wrong is an R2 fault; a full, correct read that
 * still hydrates wrong is a fault between here and the sandbox's extract.
 */
export interface BundleServed {
  readonly event: "keel.bundle.served";
  readonly containerId: string;
  readonly namespace: string;
  readonly requested: string;
  readonly etag: string;
  readonly size: number;
  readonly bytesRead: number;
  readonly sha256Read: string;
  /** `end` when the body was read to its end, `cancel` when the reader hung up first. */
  readonly ended: "end" | "error" | "cancel";
  readonly error?: string;
  readonly ms: number;
}

/** The engine's archive checkout, which never checks its own exit code: logged here so a hydration fault has a cause on record. */
export interface BundleCheckout {
  readonly event: "keel.bundle.checkout";
  readonly containerId: string;
  readonly requested: string;
  readonly exitCode: number;
  readonly stderr: string;
  readonly ms: number;
}

const hex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");

const describeError = (error: unknown): string =>
  error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : JSON.stringify(error);

/** Passes `body` through unchanged, counting and hashing what it reads, and reports once it ends. */
function measured(
  body: ReadableStream<Uint8Array>,
  report: (read: Pick<BundleServed, "bytesRead" | "sha256Read" | "ended" | "error">) => void,
): ReadableStream<Uint8Array> {
  const digest = new crypto.DigestStream("SHA-256");
  const sink = digest.getWriter();
  const reader = body.getReader();
  let bytesRead = 0;
  let finished = false;
  const finish = async (ended: BundleServed["ended"], error?: unknown) => {
    if (finished) return;
    finished = true;
    await sink.close();
    report({
      bytesRead,
      sha256Read: hex(await digest.digest),
      ended,
      ...(error === undefined ? {} : { error: describeError(error) }),
    });
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          await finish("end");
          controller.close();
          return;
        }
        bytesRead += chunk.value.byteLength;
        await sink.write(chunk.value);
        controller.enqueue(chunk.value);
      } catch (error) {
        await finish("error", error);
        controller.error(error);
      }
    },
    async cancel(reason) {
      await finish("cancel", reason);
      await reader.cancel(reason);
    },
  });
}

/**
 * Answers `GET <anything>.keel.internal/<namespace id>/<sha256>?exp=…&sig=…`
 * with that namespace's bundle, read from BUNDLES at the namespace's own key:
 * a hash kept for one namespace is not there under another's id. Any other
 * path is refused, the bare `/<sha256>` of before namespaces included.
 *
 * Nothing is read until the URL carries Keel's signature for exactly this
 * namespace and bundle, still in date (403 otherwise). keel signs a URL only
 * for the job it starts, so a sandbox holds one for its own bundle and can
 * make none: knowing another namespace's id and a bundle's hash fetches
 * nothing. The check needs only BUNDLE_URL_PUBLIC_KEY, which signs nothing,
 * so keel-verify still holds no secret.
 *
 * A bundle is only ever read here: keel-verify writes nothing to BUNDLES but
 * a deps build's parts and pointer, from the deps box alone (guard:
 * readonly-bundles), and no URL or token for a bundle exists outside this
 * handler. Each read is logged as a `BundleServed` once its body ends.
 */
export async function serveBundle(
  request: Request,
  env: Env,
  ctx: { readonly containerId: string },
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response("bundles are read-only", { status: 405 });
  const url = new URL(request.url);
  const [, namespace, sha256] = BUNDLE_PATH.exec(url.pathname) ?? [];
  if (namespace === undefined || sha256 === undefined || !isNamespace(namespace))
    return new Response("not a namespace's bundle", { status: 400 });
  const signed = await bundleUrlSigned(
    env.BUNDLE_URL_PUBLIC_KEY,
    namespace,
    sha256,
    url.searchParams,
    Math.floor(Date.now() / 1000),
  );
  if (!signed) return new Response("not a bundle URL Keel signed", { status: 403 });
  const started = Date.now();
  const object = await env.BUNDLES.get(namespaceKey(namespace, "bundles", sha256));
  if (object === null) return new Response("no such bundle", { status: 404 });
  const body =
    request.method === "HEAD"
      ? null
      : measured(object.body, (read) =>
          console.log(
            JSON.stringify({
              event: "keel.bundle.served",
              containerId: ctx.containerId,
              namespace,
              requested: sha256,
              etag: object.etag,
              size: object.size,
              ...read,
              ms: Date.now() - started,
            } satisfies BundleServed),
          ),
        );
  return new Response(body, {
    headers: {
      "content-type": "application/gzip",
      "content-length": String(object.size),
      etag: object.httpEtag,
    },
  });
}

/**
 * Answers `GET deps.keel.internal/<namespace id>/<sha256>?exp=…&sig=…` with
 * that part of a deps bundle, read from BUNDLES at the namespace's own
 * `deps-parts` key: a part kept for one namespace is not there under
 * another's id.
 *
 * Nothing is read until the URL carries Keel's signature for exactly this
 * namespace and part, still in date (403 otherwise). A part URL's signature
 * names its family, so a bundle's signed URL opens no part and a part's opens
 * no bundle. A suite box only reads here: anything but GET or HEAD is
 * refused (405), so a suite, which runs a candidate's code, can never put a
 * part where another run would fetch it. A HEAD asks R2 for the part's size
 * alone, and no body is read for it.
 */
export async function serveDepsPart(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response("deps parts are read-only", { status: 405 });
  const url = new URL(request.url);
  const [, namespace, sha256] = BUNDLE_PATH.exec(url.pathname) ?? [];
  if (namespace === undefined || sha256 === undefined || !isNamespace(namespace))
    return new Response("not a namespace's deps part", { status: 400 });
  const signed = await depsPartUrlSigned(
    env.BUNDLE_URL_PUBLIC_KEY,
    namespace,
    sha256,
    url.searchParams,
    Math.floor(Date.now() / 1000),
  );
  if (!signed) return new Response("not a deps part URL Keel signed", { status: 403 });
  const key = namespaceKey(namespace, "deps-parts", sha256);
  if (request.method === "HEAD") return partAnswer(await env.BUNDLES.head(key), null);
  const part = await env.BUNDLES.get(key);
  return partAnswer(part, part === null ? null : part.body);
}

/** What a suite box is told of a deps part: not found, or its size and etag over `body`, which a HEAD leaves null. */
const partAnswer = (part: R2Object | null, body: ReadableStream | null): Response =>
  part === null
    ? new Response("no such deps part", { status: 404 })
    : new Response(body, {
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(part.size),
          etag: part.httpEtag,
        },
      });

/** @cloudflare/ci's archive checkout (`curl … '<url>' | tar -xz …`) for a bundle host, capturing the bundle's hash. */
const ARCHIVE_CHECKOUT =
  /https:\/\/[a-z0-9.-]+\.keel\.internal\/[A-Za-z0-9_]+\/([0-9a-f]{64})(?:\?[^' ]*)?'? \| tar -xz /;

/** How much of a checkout's stderr is logged: curl's and tar's last words, never a workspace's worth. */
const CHECKOUT_STDERR = 2_000;

/** Everything that is not a bundle host: refused at once, rather than left to hang on DNS. */
export function refuseEgress(request: Request): Response {
  return new Response(`egress to ${new URL(request.url).hostname} is denied`, { status: 403 });
}

/**
 * KeelSandbox (ExecBox): the Tier 2 runner KeelVerify's `ci.runner` steps run
 * in. Backups and restores go through the BACKUP_BUCKET binding
 * (`localBucket`), so no R2 S3 keys reach the container. Never put a credential
 * in a container's start environment: it lands on disk and in /proc.
 *
 * Egress: the internet is off and the only allowed hosts are `*.keel.internal`.
 * Setting an allowlist puts the container in intercept-all mode, so every
 * outbound HTTP request (`interceptAllOutboundHttp`) and every HTTPS request
 * (`interceptOutboundHttps('*')`) reaches the handlers below. Dependencies are
 * fetched, never baked into the image and never installed here: a deps box
 * (KeelDepsBox) built them, and a suite box reads their parts from
 * `deps.keel.internal` by the signed URLs it is handed. So no registry is
 * reachable from a suite box, and it can write nothing: both hosts only read.
 */
export class KeelSandbox extends CiSandbox {
  override enableInternet = false;
  override interceptHttps = true;
  override allowedHosts = [BUNDLE_HOSTS];

  override async createBackup(options: BackupOptions) {
    return super.createBackup({ ...options, localBucket: true });
  }

  override async restoreBackup(backup: BackupHandle) {
    return super.restoreBackup({ ...backup, localBucket: true });
  }

  /**
   * The engine runs every command through here (it disables the default
   * session). Its archive checkout's exit code and stderr are dropped by the
   * engine, so they are logged as a `BundleCheckout`; nothing else is touched.
   */
  override async execWithSessionToken(command: string, sessionId: string, options?: ExecOptions) {
    const started = Date.now();
    const result = await super.execWithSessionToken(command, sessionId, options);
    const checkout = ARCHIVE_CHECKOUT.exec(command);
    if (checkout !== null)
      console.log(
        JSON.stringify({
          event: "keel.bundle.checkout",
          containerId: this.ctx.id.toString(),
          requested: checkout[1] ?? "",
          exitCode: result.exitCode,
          stderr: result.stderr.slice(-CHECKOUT_STDERR),
          ms: Date.now() - started,
        } satisfies BundleCheckout),
      );
    return result;
  }
}

// Assigned, never declared as a static class field: a field would define an own
// property and bypass Container's registry setter, silently dropping every
// handler. An exact host wins over a glob, so the deps host is answered by its
// own handler and every other `*.keel.internal` host by the bundle host's. The
// first matching glob wins, so the bundle hosts come before `*`.
KeelSandbox.outboundByHost = {
  [DEPS_HOST]: (request, env) => serveDepsPart(request, env),
  [BUNDLE_HOSTS]: (request, env, ctx) => serveBundle(request, env, ctx),
  "*": (request) => refuseEgress(request),
};
