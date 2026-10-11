import { CiSandbox } from "./ci-sandbox.js";

type BackupOptions = Parameters<CiSandbox["createBackup"]>[0];
type BackupHandle = Parameters<CiSandbox["restoreBackup"]>[0];
type ExecOptions = Parameters<CiSandbox["execWithSessionToken"]>[2];

/** The one host family a sandbox may reach: virtual, answered here, never on the internet. */
export const BUNDLE_HOSTS = "*.keel.internal";

/** Where a candidate bundle lives in the BUNDLES bucket, by its sha256 hex. */
export const bundleKey = (sha256: string): string => `bundles/${sha256}`;

/**
 * One bundle read as the handler saw it, logged when its stream ends: what R2
 * said the object was, and what was actually read from it. A read that ends
 * short, errors, or hashes wrong is an R2 fault; a full, correct read that
 * still hydrates wrong is a fault between here and the sandbox's extract.
 */
export interface BundleServed {
  readonly event: "keel.bundle.served";
  readonly containerId: string;
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
 * Answers `GET <anything>.keel.internal/<sha256>` with that bundle, read from
 * BUNDLES. keel-verify only ever reads BUNDLES (guard: readonly-bundles), and
 * no URL or token for it exists outside this handler. Each read is logged as
 * a `BundleServed` once its body ends.
 */
export async function serveBundle(
  request: Request,
  env: Env,
  ctx: { readonly containerId: string },
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response("bundles are read-only", { status: 405 });
  const sha256 = new URL(request.url).pathname.replace(/^\/+/, "");
  if (!/^[0-9a-f]{64}$/.test(sha256)) return new Response("not a bundle hash", { status: 400 });
  const started = Date.now();
  const object = await env.BUNDLES.get(bundleKey(sha256));
  if (object === null) return new Response("no such bundle", { status: 404 });
  const body =
    request.method === "HEAD"
      ? null
      : measured(object.body, (read) =>
          console.log(
            JSON.stringify({
              event: "keel.bundle.served",
              containerId: ctx.containerId,
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

/** @cloudflare/ci's archive checkout (`curl … '<url>' | tar -xz …`) for a bundle host, capturing the bundle's hash. */
const ARCHIVE_CHECKOUT = /https:\/\/[a-z0-9.-]+\.keel\.internal\/([0-9a-f]{64})'? \| tar -xz /;

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
 * (`interceptOutboundHttps('*')`) reaches the handlers below; dependencies are
 * baked into the image, so no registry is reachable.
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
// property and bypass Container's registry setter, silently dropping both
// handlers. The first matching glob wins, so the bundle hosts come before `*`.
KeelSandbox.outboundByHost = {
  [BUNDLE_HOSTS]: (request, env, ctx) => serveBundle(request, env, ctx),
  "*": (request) => refuseEgress(request),
};
