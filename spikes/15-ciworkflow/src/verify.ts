// keel-spike-15-verify: owns the Sandbox Durable Object classes and their
// containers. keel-spike-15-ci reaches them through cross-script DO bindings.
import { CiSandbox } from '@cloudflare/ci/worker';
import { getSandbox, type Sandbox } from '@cloudflare/sandbox';

// The sandbox SDK's ContainerProxy must be exported for outbound interception.
export { ContainerProxy } from '@cloudflare/sandbox';

type Env = {
  SANDBOX: DurableObjectNamespace<KeelSandbox>;
  SANDBOX_EGRESS: DurableObjectNamespace<KeelSandboxEgress>;
  ARTIFACTS: Artifacts;
  BACKUP_BUCKET: R2Bucket;
  BACKUP_BUCKET_NAME: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  FORCE_LOCAL_BACKUP?: string;
  SPIKE_KEY: string;
  CF_TOKEN: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
};

type BackupOptions = Parameters<Sandbox['createBackup']>[0];
type BackupHandle = Parameters<Sandbox['restoreBackup']>[0];

/**
 * CiSandbox plus one switch: FORCE_LOCAL_BACKUP=1 routes every backup and
 * restore through the BACKUP_BUCKET binding instead of presigned S3 URLs, so
 * no R2 S3 keys are needed. Off by default, which is unmodified CiSandbox.
 */
export class KeelSandbox extends CiSandbox {
  override async createBackup(options: BackupOptions) {
    const local = (this.env as unknown as Env).FORCE_LOCAL_BACKUP === '1';
    return super.createBackup(local ? { ...options, localBucket: true } : options);
  }

  override async restoreBackup(backup: BackupHandle) {
    const local = (this.env as unknown as Env).FORCE_LOCAL_BACKUP === '1';
    return super.restoreBackup(local ? { ...backup, localBucket: true } : backup);
  }
}

const BUNDLE_HOST = 'bundles.keel.internal';
const PROBE_HOST = 'egress-probe.keel.internal';

/**
 * Same sandbox with the internet off. Egress is limited to the npm registry,
 * a bundle host served from R2, a probe host, and the Artifacts git host,
 * where a read token is injected at the edge so none enters the container.
 */
export class KeelSandboxEgress extends KeelSandbox {
  override enableInternet = false;
  override interceptHttps = true;
  override allowedHosts = ['registry.npmjs.org', BUNDLE_HOST, PROBE_HOST, '*.artifacts.cloudflare.net'];
}

// Assigned, not declared as static fields: a class field would define an own
// property and bypass the registry setter on Container.
KeelSandboxEgress.outboundByHost = {
  [PROBE_HOST]: async (req: Request) =>
    Response.json({
      intercepted: true,
      url: req.url,
      method: req.method,
      authorization: req.headers.get('authorization'),
    }),
  [BUNDLE_HOST]: async (req: Request, env: unknown) => {
    const hash = new URL(req.url).pathname.replace(/^\/+/, '');
    if (!/^[0-9a-f]{64}$/.test(hash)) return new Response('bad hash', { status: 400 });
    const object = await (env as Env).BACKUP_BUCKET.get(`bundles/${hash}.tar.gz`);
    if (!object) return new Response('no such bundle', { status: 404 });
    return new Response(object.body, { headers: { 'content-type': 'application/gzip' } });
  },
  '*.artifacts.cloudflare.net': async (req: Request, env: unknown) => {
    // Mint a short read token for the repo named in the path and inject it.
    const match = new URL(req.url).pathname.match(/^\/git\/([^/]+)\/([^/]+?)\.git\//);
    if (!match) return new Response('unexpected path', { status: 403 });
    const repo = await (env as Env).ARTIFACTS.get(match[2]);
    const token = await repo.createToken('read', 300);
    const headers = new Headers(req.headers);
    headers.set('authorization', `Bearer ${token.plaintext}`);
    return fetch(new Request(req, { headers }));
  },
};

async function sandboxExec(sandbox: ReturnType<typeof getSandbox>, cmd: string) {
  const t0 = Date.now();
  const r = await sandbox.exec(cmd, { timeout: 60_000 });
  return { cmd, exitCode: r.exitCode, ms: Date.now() - t0, stdout: r.stdout.slice(0, 2000), stderr: r.stderr.slice(0, 2000) };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.headers.get('x-spike-key') !== env.SPIKE_KEY) return new Response('forbidden', { status: 403 });
    const url = new URL(request.url);
    const egress = url.searchParams.get('class') === 'egress';
    const ns = (egress ? env.SANDBOX_EGRESS : env.SANDBOX) as unknown as DurableObjectNamespace<CiSandbox>;

    if (url.pathname === '/probe') {
      // Direct Sandbox SDK probe: FUSE presence and outbound behaviour.
      const sandbox = getSandbox(ns, `probe-${crypto.randomUUID()}`, { transport: 'rpc', enableDefaultSession: false });
      const results = [];
      try {
        const remote = `https://${env.CLOUDFLARE_ACCOUNT_ID}.artifacts.cloudflare.net/git/keel-spike-15/forge.git`;
        const cmds = [
          'test -c /dev/fuse && echo fuse-present || echo fuse-absent',
          `curl -sS -m 10 http://${PROBE_HOST}/plain-http`,
          `curl -sS -m 10 https://${PROBE_HOST}/https`,
          'curl -sS -m 10 -o /dev/null -w "%{http_code}" https://example.com/',
          'curl -sS -m 10 -o /dev/null -w "%{http_code}" https://registry.npmjs.org/hono',
          `GIT_TERMINAL_PROMPT=0 git ls-remote ${remote} 2>&1 | head -3`,
          'env | grep -i -E "cert|ca_|intercept" | sed -E "s/=.{0,6}.*/=…/"',
        ];
        for (const cmd of cmds) results.push(await sandboxExec(sandbox, cmd));
      } finally {
        await sandbox.destroy();
      }
      return Response.json({ class: egress ? 'KeelSandboxEgress' : 'KeelSandbox', results });
    }
    return new Response('not found', { status: 404 });
  },
};
