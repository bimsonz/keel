// keel-spike-15-ci: KeelVerify extends CIWorkflow unmodified, plus an HTTP
// trigger that starts a run and reports instance status.
import { CIWorkflow, cloudflareArtifacts, type CiContext, type CiParams, type CloudflareArtifacts } from '@cloudflare/ci';
import { startCiRun, type CiSandbox } from '@cloudflare/ci/worker';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';

type Env = {
  ARTIFACTS: Artifacts;
  BACKUP_BUCKET: R2Bucket;
  BACKUP_BUCKET_NAME: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  SANDBOX: DurableObjectNamespace<CiSandbox>;
  CI_WORKFLOW: Workflow<CiParams<CloudflareArtifacts>>;
  CI_WORKFLOW_BUNDLE: Workflow<CiParams<CloudflareArtifacts>>;
  BUNDLE_HASH: string;
  BUNDLE_BASE: string;
  LOADER: {
    get(name: string | null, getCode: () => unknown): { getEntrypoint(): { fetch(req: Request): Promise<Response> } };
  };
  RESULTS: R2Bucket;
  SPIKE_KEY: string;
  CF_TOKEN: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
};

type ScenarioPayload = CiParams<CloudflareArtifacts> & {
  scenario?: string;
  planId?: string;
  worldId?: string;
};

// A trivial Tier 1 worker loaded with globalOutbound: null (no network).
const TIER1_SOURCE = `export default { async fetch() {
  let total = 0; for (let i = 1; i <= 1000; i++) total += i;
  return Response.json({ tier1: true, total, ts: Date.now() });
} };`;

/**
 * Keel's verification Workflow. Subclasses CIWorkflow with no engine changes;
 * all behaviour lives in pipeline(). Scenario is read from the extra payload
 * fields that CIWorkflow.run() forwards unchanged.
 */
export class KeelVerify extends CIWorkflow<CloudflareArtifacts, Env> {
  protected async pipeline(
    event: WorkflowEvent<CiParams<CloudflareArtifacts>>,
    step: WorkflowStep,
    ci: CiContext,
  ): Promise<void> {
    const payload = event.payload as ScenarioPayload;
    const scenario = payload.scenario ?? 'runner';
    const record = async (key: string, value: unknown) => {
      await this.env.RESULTS.put(`${event.instanceId}/${key}.json`, JSON.stringify(value, null, 2));
    };

    // Check 1: prove the extra payload fields survived into pipeline().
    await step.do('observe-payload', async () => {
      const seen = {
        scenario,
        planId: payload.planId ?? null,
        worldId: payload.worldId ?? null,
        ref: payload.ref,
        sha: payload.sha,
        owner: payload.owner,
        repo: payload.repo,
        providerData: payload.providerData,
      };
      await record('payload', seen);
      return seen;
    });

    if (scenario === 'tier-mix') {
      // Check 3: a Tier 1 LOADER.get child (globalOutbound: null) in a step.do,
      // then a Tier 2 ci.runner, both landing in this one instance.
      const tier1 = await step.do('tier1-compute', async () => {
        const stub = this.env.LOADER.get('keel-spike-15-tier1', () => ({
          compatibilityDate: '2026-10-01',
          mainModule: 'main.js',
          modules: { 'main.js': TIER1_SOURCE },
          globalOutbound: null,
        }));
        const res = await stub.getEntrypoint().fetch(new Request('https://tier1.internal/'));
        return (await res.json()) as { tier1: boolean; total: number; ts: number };
      });
      const tier2 = await ci.runner({
        name: 'tier2-test',
        command: 'node --version && npm ci --no-audit --no-fund >/dev/null 2>&1 && node node_modules/vitest/vitest.mjs run 2>&1 | tail -4',
      });
      await record('tier-mix', { tier1, tier2Exit: tier2.exitCode });
      return;
    }

    if (scenario === 'logs') {
      // Check 5: a runner echoes a fake secret; the pipeline redacts after.
      const FAKE = 'FAKE-SECRET-123';
      const result = await ci.runner({
        name: 'echo-secret',
        command: `echo "boundary ${FAKE} boundary"; echo "token-env:[${'$'}{SOURCE_CONTROL_TOKEN:-unset}]"; echo "git-config:"; cat /workspace/.git/config 2>/dev/null | tr -d "\\n" | head -c 400; echo; echo "environ-dump:"; cat /proc/1/environ 2>/dev/null | tr "\\0" "\\n" | grep -i -E "token|secret|auth" | sed -E "s/=.*/=<value>/" || echo none`,
      });
      const toStr = (v: unknown) => (typeof v === 'string' ? v : '[stream]');
      const raw = { stdout: toStr(result.logs.stdout), stderr: toStr(result.logs.stderr) };
      const redacted = {
        stdout: raw.stdout.split(FAKE).join('[REDACTED]'),
        stderr: raw.stderr.split(FAKE).join('[REDACTED]'),
      };
      await record('logs-raw-from-pipeline', raw);
      await record('logs-redacted-r2', redacted);
      return;
    }

    if (scenario === 'cache-trusted') {
      // Check 4(i): a trusted install from the base lockfile, producing a snapshot.
      const install = await ci.runner({
        name: 'trusted-install',
        command: 'npm ci --no-audit --no-fund 2>&1 | tail -2',
        cache: { inputs: ['package-lock.json', 'package.json'] },
      });
      // 4(ii): chain the candidate test from that snapshot. Time the json run.
      const test = await install.runner({
        name: 'candidate-test',
        command:
          'S=$(date +%s%N); node node_modules/vitest/vitest.mjs run --reporter=json --outputFile=/workspace/vitest-report.json >/dev/null 2>&1; E=$(date +%s%N); echo "VITEST_JSON_MS=$(( (E - S) / 1000000 ))"; echo "===JSON==="; cat /workspace/vitest-report.json',
      });
      const toStr = (v: unknown) => (typeof v === 'string' ? v : '[stream]');
      const out = toStr(test.logs.stdout);
      const jsonPart = out.split('===JSON===')[1]?.trim() ?? '';
      const msMatch = out.match(/VITEST_JSON_MS=(\d+)/);
      await record('cache-trusted', {
        scope: payload.ref,
        installExit: install.exitCode,
        installStdout: toStr(install.logs.stdout).slice(0, 400),
        installCachePointer: install.cachePointer ?? null,
        testExit: test.exitCode,
        vitestJsonMs: msMatch ? Number(msMatch[1]) : null,
        vitestJson: jsonPart,
      });
      return;
    }

    if (scenario === 'hydrate') {
      // Check 6: try to hydrate from an R2 bundle with sourceControlCredentials
      // off, and probe what token the sandbox can see.
      const result = await ci.runner({
        name: 'hydrate-probe',
        sourceControlCredentials: false,
        command: `echo "scm-token:[${'$'}{SOURCE_CONTROL_TOKEN:-unset}]"; ls -la /workspace | head; echo "env-tokens:"; env | grep -i -E "token|secret" | sed -E "s/=.*/=<value>/" || echo none`,
      });
      const toStr = (v: unknown) => (typeof v === 'string' ? v : '[stream]');
      await record('hydrate', { exit: result.exitCode, stdout: toStr(result.logs.stdout) });
      return;
    }

    // Default: a single runner (checks 2 cross-script binding + timings).
    const t0 = Date.now();
    const cold = await ci.runner({ name: 'cold-run', command: 'node --version && echo cold-ok' });
    const coldMs = Date.now() - t0;
    const t1 = Date.now();
    const warm = await cold.runner({ name: 'warm-run', command: 'echo warm-ok' });
    const warmMs = Date.now() - t1;
    const toStr = (v: unknown) => (typeof v === 'string' ? v : '[stream]');
    await record('runner', {
      coldExit: cold.exitCode,
      coldMs,
      coldStdout: toStr(cold.logs.stdout),
      warmExit: warm.exitCode,
      warmMs,
    });
  }
}

/**
 * Check 6 / fork reason #2: hydrate the workspace from a content-addressed R2
 * bundle with NO git token, using CIWorkflow's public getProvider() seam and
 * the sandbox runner's native archive-checkout kind. No engine fork.
 */
export class KeelVerifyBundle extends KeelVerify {
  static override getProvider() {
    const base = cloudflareArtifacts({ owner: 'keel-spike-15', repo: 'forge' });
    // Wrap the stock adapter; replace only getSourceCheckout with an archive URL.
    return {
      ...base,
      create(env: Env) {
        const provider = base.create(env as never);
        // Base URL of this CI Worker's /bundle route, injected at deploy time.
        const bundleUrl = `${env.BUNDLE_BASE}/bundle/${env.BUNDLE_HASH}`;
        return new Proxy(provider, {
          get(target, prop, receiver) {
            if (prop === 'getSourceCheckout') {
              return async () => ({ kind: 'archive' as const, url: bundleUrl });
            }
            const value = Reflect.get(target, prop, receiver);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
    };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url0 = new URL(request.url);
    if (url0.pathname.startsWith('/bundle/')) {
      // Public source bundle: non-secret content, served by content hash.
      const hash = url0.pathname.slice('/bundle/'.length);
      if (!/^[0-9a-f]{64}$/.test(hash)) return new Response('bad hash', { status: 400 });
      const object = await env.RESULTS.get(`bundles/${hash}.tar.gz`);
      if (!object) return new Response('not found', { status: 404 });
      return new Response(object.body, { headers: { 'content-type': 'application/gzip' } });
    }
    if (request.headers.get('x-spike-key') !== env.SPIKE_KEY) return new Response('forbidden', { status: 403 });
    const url = new URL(request.url);

    if (url.pathname === '/start' && request.method === 'POST') {
      const body = (await request.json()) as Partial<ScenarioPayload> & { branch?: string; bundle?: boolean };
      const branch = body.branch ?? 'cand-safe';
      const sha = body.sha as string;
      const params = {
        provider: 'cloudflare-artifacts' as const,
        providerData: { namespace: 'keel-spike-15' },
        event: { type: 'push' as const },
        owner: 'keel-spike-15',
        repo: 'forge',
        sha,
        remote: 'cloudflare' as const,
        trigger: 'push' as const,
        ref: body.ref ?? `refs/heads/${branch}`,
        branch,
        scenario: body.scenario,
        planId: body.planId,
        worldId: body.worldId,
      } as ScenarioPayload;
      const wf = body.bundle ? env.CI_WORKFLOW_BUNDLE : env.CI_WORKFLOW;
      const id = await startCiRun({ CI_WORKFLOW: wf } as never, params as never);
      return Response.json({ started: id, params });
    }

    if (url.pathname === '/status') {
      const id = url.searchParams.get('id');
      if (!id) return new Response('missing id', { status: 400 });
      const wf = url.searchParams.get('bundle') ? env.CI_WORKFLOW_BUNDLE : env.CI_WORKFLOW;
      const instance = await wf.get(id);
      const status = await instance.status();
      return Response.json({ id, status });
    }

    if (url.pathname === '/results') {
      const id = url.searchParams.get('id');
      if (!id) return new Response('missing id', { status: 400 });
      const list = await env.RESULTS.list({ prefix: `${id}/` });
      const out: Record<string, unknown> = {};
      for (const obj of list.objects) {
        const got = await env.RESULTS.get(obj.key);
        out[obj.key] = got ? JSON.parse(await got.text()) : null;
      }
      return Response.json(out);
    }

    return new Response('not found', { status: 404 });
  },
};
