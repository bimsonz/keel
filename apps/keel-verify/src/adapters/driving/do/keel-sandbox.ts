import { CiSandbox } from "./ci-sandbox.js";

type BackupOptions = Parameters<CiSandbox["createBackup"]>[0];
type BackupHandle = Parameters<CiSandbox["restoreBackup"]>[0];

/** The one host family a sandbox may reach: virtual, answered here, never on the internet. */
export const BUNDLE_HOSTS = "*.keel.internal";

/** Where a candidate bundle lives in the BUNDLES bucket, by its sha256 hex. */
export const bundleKey = (sha256: string): string => `bundles/${sha256}`;

/**
 * Answers `GET <anything>.keel.internal/<sha256>` with that bundle, read from
 * BUNDLES. keel-verify only ever reads BUNDLES (guard: readonly-bundles), and
 * no URL or token for it exists outside this handler.
 */
export async function serveBundle(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response("bundles are read-only", { status: 405 });
  const sha256 = new URL(request.url).pathname.replace(/^\/+/, "");
  if (!/^[0-9a-f]{64}$/.test(sha256)) return new Response("not a bundle hash", { status: 400 });
  const object = await env.BUNDLES.get(bundleKey(sha256));
  if (object === null) return new Response("no such bundle", { status: 404 });
  return new Response(request.method === "HEAD" ? null : object.body, {
    headers: {
      "content-type": "application/gzip",
      "content-length": String(object.size),
      etag: object.httpEtag,
    },
  });
}

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
}

// Assigned, never declared as a static class field: a field would define an own
// property and bypass Container's registry setter, silently dropping both
// handlers. The first matching glob wins, so the bundle hosts come before `*`.
KeelSandbox.outboundByHost = {
  [BUNDLE_HOSTS]: (request, env) => serveBundle(request, env),
  "*": (request) => refuseEgress(request),
};
