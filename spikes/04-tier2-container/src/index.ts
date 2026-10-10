// keel-spike-04-tier2: the Tier 2 container backstop (MergeBox / ExecBox) on the
// Containers Durable Object API (`ctx.container`, `durable_object` scheduling
// policy). The container never holds an Artifacts token: the Durable Object
// mints one with the binding and an HTTPS intercept on the Artifacts host adds
// it to each git request on its way out.
import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { CHECK_SCRIPT, EGRESS_SCRIPT, PLANT_CANARY_SCRIPT, TRACE_SCRIPT, TRUST_SCRIPT, VERIFY_SCRIPT, VITEST_SCRIPT } from './scripts';

type Env = {
  BOX: DurableObjectNamespace<Tier2Box>;
  ARTIFACTS: Artifacts;
  SPIKE_KEY: string;
};

const REPO = 'forge';
const INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000;
const TOKEN_TTL_S = 600;

/** How the box reaches the outside world. Only `locked` is the design; the others are can-fail controls. */
type Egress =
  | 'locked' // enableInternet false; one HTTPS intercept on the Artifacts host, which injects the token
  | 'no-inject' // as locked, but the intercept forwards without a token
  | 'open-internet' // as locked, but enableInternet true
  | 'open-intercept'; // as locked, plus a `*` HTTPS intercept that passes everything through

type EgressProps = { host: string; repoPath: string; token: string | null; passthrough: boolean };

/**
 * Outbound HTTPS from the container lands here (in the Workers runtime, outside
 * the container). Requests to the one repo get the Bearer token; anything else
 * is refused unless this is the passthrough control.
 */
export class ArtifactsEgress extends WorkerEntrypoint<Env, EgressProps> {
  override async fetch(request: Request): Promise<Response> {
    const props = this.ctx.props;
    const url = new URL(request.url);
    if (props.passthrough) return fetch(request);
    if (url.hostname !== props.host || !url.pathname.startsWith(props.repoPath)) {
      return new Response('egress denied by ArtifactsEgress', { status: 403 });
    }
    url.protocol = 'https:';
    const forwarded = new Request(url.toString(), request);
    forwarded.headers.delete('authorization');
    if (props.token) forwarded.headers.set('authorization', `Bearer ${props.token}`);
    const upstream = await fetch(forwarded);
    const response = new Response(upstream.body, upstream);
    response.headers.set('x-keel-egress', props.token ? 'injected' : 'no-token');
    return response;
  }
}

type ExecResult = { exitCode: number; ms: number; stdout: string; stderr: string };

const BASE_ENV: Record<string, string> = {
  HOME: '/root',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'keel-mergebox',
  GIT_AUTHOR_EMAIL: 'mergebox@keel.invalid',
  GIT_COMMITTER_NAME: 'keel-mergebox',
  GIT_COMMITTER_EMAIL: 'mergebox@keel.invalid',
  GIT_AUTHOR_DATE: '2026-10-10T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-10-10T00:00:00Z',
  CI: '1',
  npm_config_update_notifier: 'false',
};

const decoder = new TextDecoder();

/** Redact tokens (art_v1_/art_v2_ forms) and the account id from anything returned. */
export function redact(text: string, secrets: (string | null | undefined)[] = []): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join('<token>');
  return out
    .replace(/art_v\d+_[A-Za-z0-9_]+(\?expires=\d+)?/g, '<token>')
    .replace(/\b[0-9a-f]{32}\b/g, '<acct>');
}

export class Tier2Box extends DurableObject<Env> {
  private token: string | null = null;
  /** Every token minted for this container, so the checks can look for any of them. */
  private minted: string[] = [];
  private remote: string | null = null;
  private egress: Egress = 'locked';
  private monitorError: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const container = ctx.container;
    if (container?.running) {
      void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS));
    }
  }

  private get container(): Container {
    const c = this.ctx.container;
    if (!c) throw new Error('no container binding on this Durable Object');
    return c;
  }

  private async exec(script: string, args: string[] = [], env: Record<string, string> = {}): Promise<ExecResult> {
    const t0 = Date.now();
    const proc = await this.container.exec(['bash', '-c', script, 'box', ...args], { env: { ...BASE_ENV, ...env } });
    const out = await proc.output();
    return {
      exitCode: out.exitCode,
      ms: Date.now() - t0,
      stdout: decoder.decode(out.stdout),
      stderr: decoder.decode(out.stderr),
    };
  }

  /** Mint a fresh repo-scoped write token and (re)register the intercepts. The token stays in this isolate. */
  private async registerEgress(): Promise<{ mintMs: number; interceptMs: number; host: string }> {
    const t0 = Date.now();
    const repo = await this.env.ARTIFACTS.get(REPO);
    if (!this.remote) this.remote = (await repo.info()).remote;
    const minted = await repo.createToken('write', TOKEN_TTL_S);
    this.minted.push(minted.plaintext);
    this.token = this.egress === 'no-inject' ? null : minted.plaintext;
    const t1 = Date.now();
    const remote = new URL(this.remote);
    const props: EgressProps = {
      host: remote.hostname,
      repoPath: remote.pathname,
      token: this.token,
      passthrough: false,
    };
    // Hostname intercepts first; a `*` registered afterwards only catches the rest.
    // ctx.exports holds loopback bindings for this Worker's own exports.
    const exports = this.ctx.exports as unknown as { ArtifactsEgress: (o: { props: EgressProps }) => Fetcher };
    await this.container.interceptOutboundHttps(remote.hostname, exports.ArtifactsEgress({ props }));
    if (this.egress === 'open-intercept') {
      await this.container.interceptOutboundHttps('*', exports.ArtifactsEgress({ props: { ...props, passthrough: true } }));
    }
    return { mintMs: t1 - t0, interceptMs: Date.now() - t1, host: '<acct>.artifacts.cloudflare.net' };
  }

  /**
   * Start a container (from the image, or from a snapshot) and time each step
   * until it runs commands and trusts the intercept CA.
   */
  async boot(opts: { egress?: Egress; snapshotId?: string; instance?: string; canary?: string } = {}) {
    const container = this.container;
    if (container.running) return { alreadyRunning: true };
    this.egress = opts.egress ?? 'locked';
    this.monitorError = null;
    const instance = (opts.instance ?? 'standard-2') as 'standard-2';
    const t0 = Date.now();
    const env = opts.canary ? { ARTIFACTS_TOKEN: opts.canary } : undefined;
    if (opts.snapshotId) {
      container.start({ containerSnapshot: { id: opts.snapshotId }, enableInternet: this.egress === 'open-internet', instance, env });
    } else {
      container.start({ image: container.images.base, enableInternet: this.egress === 'open-internet', instance, env });
    }
    const startCallMs = Date.now() - t0;
    this.ctx.waitUntil(
      container.monitor().catch((err: unknown) => {
        this.monitorError = String(err);
      }),
    );
    const egress = await this.registerEgress();
    // exec() waits for a container that is still starting; retry if it is not up yet.
    let firstExec: ExecResult | null = null;
    let attempts = 0;
    let lastError = '';
    while (!firstExec && Date.now() - t0 < 180_000) {
      attempts++;
      try {
        firstExec = await this.exec('true');
      } catch (err) {
        lastError = String(err);
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    if (!firstExec) throw new Error(`container never ran a command: ${lastError} monitor=${this.monitorError}`);
    const firstExecAtMs = Date.now() - t0;
    const trust = await this.exec(TRUST_SCRIPT);
    if (trust.exitCode !== 0) throw new Error(`trust failed: ${trust.stderr}`);
    const readyAtMs = Date.now() - t0;
    await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
    return {
      from: opts.snapshotId ? 'snapshot' : 'image',
      instance,
      egress: this.egress,
      startCallMs,
      tokenMintMs: egress.mintMs,
      interceptRegisterMs: egress.interceptMs,
      firstExecAtMs,
      execAttempts: attempts,
      trustMs: trust.ms,
      readyAtMs,
    };
  }

  /** Latency of a new exec on the running container. */
  async execLatency(n = 5) {
    const samples: number[] = [];
    for (let i = 0; i < n; i++) samples.push((await this.exec('true')).ms);
    return { samples };
  }

  /** clone + merge-tree + checkout + pnpm test, timed per phase, with no token in the container. */
  async verify(run: string) {
    const t0 = Date.now();
    const egress = await this.registerEgress(); // a fresh 10-minute token for every verify
    const r = await this.exec(VERIFY_SCRIPT, [this.remote ?? '', run]);
    const last = r.stdout.trim().split('\n').pop() ?? '';
    let result: unknown = null;
    try {
      result = JSON.parse(last);
    } catch {
      result = { parseError: true };
    }
    return {
      totalMs: Date.now() - t0,
      tokenMintMs: egress.mintMs,
      interceptRegisterMs: egress.interceptMs,
      execMs: r.ms,
      exitCode: r.exitCode,
      result,
      stderrTail: redact(r.stderr.slice(-1500), [this.token]),
    };
  }

  /** git ls-remote with curl tracing: what the container itself sends and receives. */
  async trace() {
    await this.registerEgress();
    const r = await this.exec(TRACE_SCRIPT, [this.remote ?? '']);
    return { exitCode: r.exitCode, out: redact((r.stdout + r.stderr).slice(-6000), [this.token]) };
  }

  /**
   * Look for the token everywhere in the container. With a canary, first plant
   * it in env, a file, .git/config and ~/.git-credentials, and treat it as the
   * secret, so the same checks must find it.
   */
  async tokenChecks(opts: { canary?: string } = {}) {
    // Compare on the part before "?expires=", which is what grep -o prints.
    const secrets = (opts.canary ? [opts.canary] : this.minted).map((t) => t.split('?')[0]);
    let planted: ExecResult | null = null;
    const env: Record<string, string> = opts.canary ? { ARTIFACTS_TOKEN: opts.canary } : {};
    if (opts.canary) planted = await this.exec(PLANT_CANARY_SCRIPT, [opts.canary]);
    const r = await this.exec(CHECK_SCRIPT, [], env);
    const sections: Record<string, { hits: number; containsSecret: boolean; lines: string[] }> = {};
    let current = '';
    for (const line of r.stdout.split('\n')) {
      const m = line.match(/^=== (\S+)/);
      if (m) {
        current = m[1];
        sections[current] = { hits: 0, containsSecret: false, lines: [] };
        continue;
      }
      if (!current || line.trim() === '' || line.startsWith('# ')) continue;
      const s = sections[current];
      s.hits++;
      if (secrets.some((t) => line.includes(t))) s.containsSecret = true;
      if (s.lines.length < 8) s.lines.push(redact(line.slice(0, 300), secrets));
    }
    return {
      mode: opts.canary ? 'canary' : 'real-token',
      secretsCompared: secrets.length,
      plantExit: planted?.exitCode ?? null,
      checkExit: r.exitCode,
      checkMs: r.ms,
      sections,
      stderrTail: redact(r.stderr.slice(-500), secrets),
    };
  }

  async egressProbe() {
    await this.registerEgress();
    const remote = new URL(this.remote ?? 'https://invalid/');
    const r = await this.exec(EGRESS_SCRIPT, [remote.hostname, remote.pathname]);
    return { egress: this.egress, exitCode: r.exitCode, out: redact(r.stdout + r.stderr, [this.token]) };
  }

  /** Time the suite alone in an existing checkout: plain `vitest run`, n times. */
  async vitest(run: string, n = 3) {
    const samples: { ms: number; exitCode: number; tail: string }[] = [];
    for (let i = 0; i < n; i++) {
      const r = await this.exec(VITEST_SCRIPT, [run]);
      samples.push({ ms: r.ms, exitCode: r.exitCode, tail: redact((r.stdout + r.stderr).trim().split('\n').slice(-4).join(' | ')) });
    }
    const cpu = await this.exec('nproc; grep -m1 "model name" /proc/cpuinfo; free -m | sed -n 2p');
    return { samples, cpu: cpu.stdout.trim() };
  }

  /** Debug: run a command (output redacted). */
  async sh(cmd: string) {
    const r = await this.exec(cmd);
    return { exitCode: r.exitCode, ms: r.ms, out: redact((r.stdout + r.stderr).slice(-6000), this.minted) };
  }

  async snapshot(name: string) {
    const t0 = Date.now();
    const snap = await this.container.snapshotContainer({ name });
    return { ms: Date.now() - t0, id: snap.id, size: snap.size, name: snap.name };
  }

  async destroy() {
    const t0 = Date.now();
    const wasRunning = this.container.running;
    if (wasRunning) await this.container.destroy();
    this.token = null;
    this.minted = [];
    return { wasRunning, ms: Date.now() - t0 };
  }

  async status() {
    const info = await this.container.inspect();
    return { running: this.container.running, image: info ? redact(info.image) : null, monitorError: this.monitorError };
  }
}

const METHODS = new Set(['sh', 'vitest', 'boot', 'execLatency', 'verify', 'trace', 'tokenChecks', 'egressProbe', 'snapshot', 'destroy', 'status']);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.headers.get('x-spike-key') !== env.SPIKE_KEY) return new Response('forbidden', { status: 403 });
    // POST /box/<name>/<method> with a JSON array of arguments.
    const m = new URL(request.url).pathname.match(/^\/box\/([A-Za-z0-9_-]{1,64})\/([A-Za-z]+)$/);
    if (!m || !METHODS.has(m[2])) return new Response('not found', { status: 404 });
    const args = request.method === 'POST' ? ((await request.json()) as unknown[]) : [];
    const stub = env.BOX.getByName(m[1]) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    const t0 = Date.now();
    try {
      const result = await stub[m[2]](...args);
      return Response.json({ ok: true, wallMs: Date.now() - t0, result });
    } catch (err) {
      return Response.json({ ok: false, wallMs: Date.now() - t0, error: redact(String(err)) }, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
