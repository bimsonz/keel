// Drives keel-spike-04-tier2 on the live edge and writes redacted results.
//
//   SPIKE_URL=https://<worker>.workers.dev SPIKE_KEY=... node scripts/drive.mjs <experiment> [n]
//
// Experiments: call <box> <method> [json-args] | cold [n] | restart [n] | warm [n]
//              | snapshot [n] | concurrent [n] | instances [n] | controls
//
// The cap on live containers lives here, because the durable_object scheduling
// policy rejects max_instances: experiments run one or two containers at a
// time, and only `concurrent` goes up to 10.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const URL_BASE = process.env.SPIKE_URL;
const KEY = process.env.SPIKE_KEY;
if (!URL_BASE || !KEY) throw new Error('SPIKE_URL and SPIKE_KEY are required');
const RESULTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'results');
const CAP_CONCURRENT = 10;

const redact = (s) =>
  s
    .replace(/art_v\d+_[A-Za-z0-9_]+(\?expires=\d+)?/g, '<token>')
    .replace(/\b[0-9a-f]{32}\b/g, '<acct>')
    .replace(/https:\/\/[a-z0-9.-]+\.workers\.dev/g, '<worker-url>');

async function call(box, method, args = []) {
  const t0 = Date.now();
  const res = await fetch(`${URL_BASE}/box/${box}/${method}`, {
    method: 'POST',
    headers: { 'x-spike-key': KEY, 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(redact(text));
  } catch {
    body = { ok: false, status: res.status, error: redact(text.slice(0, 500)) };
  }
  return { clientMs: Date.now() - t0, ...body };
}

const stats = (xs) => {
  const s = [...xs].filter((x) => typeof x === 'number').sort((a, b) => a - b);
  if (!s.length) return null;
  const mid = Math.floor(s.length / 2);
  const p50 = s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
  return { n: s.length, p50, min: s[0], max: s[s.length - 1] };
};

function save(name, data) {
  mkdirSync(RESULTS, { recursive: true });
  const file = join(RESULTS, `${name}.json`);
  writeFileSync(file, redact(JSON.stringify(data, null, 2)) + '\n');
  console.log(`wrote results/${name}.json`);
}

const stamp = () => Date.now().toString(36);
const log = (...a) => console.log(redact(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')));

/** New Durable Object (so a new container) per sample: boot from the image, then destroy. */
async function cold(n = 6) {
  const samples = [];
  for (let i = 0; i < n; i++) {
    const box = `cold-${stamp()}-${i}`;
    const boot = await call(box, 'boot', [{}]);
    log('cold', box, boot);
    const destroy = await call(box, 'destroy');
    samples.push({ box, boot, destroy });
  }
  const ok = samples.filter((s) => s.boot.ok);
  const summary = {
    readyAtMs: stats(ok.map((s) => s.boot.result.readyAtMs)),
    firstExecAtMs: stats(ok.map((s) => s.boot.result.firstExecAtMs)),
    clientMs: stats(ok.map((s) => s.boot.clientMs)),
    failures: samples.length - ok.length,
  };
  save('cold', { summary, samples });
  log('summary', summary);
}

/** Same Durable Object: destroy the container and start it again. */
async function restart(n = 5) {
  const box = `restart-${stamp()}`;
  const first = await call(box, 'boot', [{}]);
  log('first', first);
  const samples = [];
  for (let i = 0; i < n; i++) {
    const destroy = await call(box, 'destroy');
    const boot = await call(box, 'boot', [{}]);
    log('restart', i, destroy, boot);
    samples.push({ destroy, boot });
  }
  await call(box, 'destroy');
  const ok = samples.filter((s) => s.boot.ok);
  const summary = {
    readyAtMs: stats(ok.map((s) => s.boot.result.readyAtMs)),
    destroyMs: stats(samples.map((s) => s.destroy.result?.ms)),
    failures: samples.length - ok.length,
  };
  save('restart', { box, first, summary, samples });
  log('summary', summary);
}

/** A running container: exec latency, then the full verify n times. */
async function warm(n = 6) {
  const box = `warm-${stamp()}`;
  const boot = await call(box, 'boot', [{}]);
  log('boot', boot);
  const exec = await call(box, 'execLatency', [10]);
  log('exec', exec);
  const runs = [];
  for (let i = 0; i < n; i++) {
    const v = await call(box, 'verify', [`run-${i}`]);
    log('verify', i, v.ok, v.result?.totalMs, v.result?.result);
    runs.push(v);
  }
  await call(box, 'destroy');
  const ok = runs.filter((r) => r.ok && r.result.exitCode === 0 && r.result.result.passed === 214);
  const phase = (k) => stats(ok.map((r) => r.result.result[k]));
  const summary = {
    execLatencyMs: stats(exec.result.samples),
    verifyTotalMs: stats(ok.map((r) => r.result.totalMs)),
    verifyClientMs: stats(ok.map((r) => r.clientMs)),
    cloneMs: phase('cloneMs'),
    mergeTreeMs: phase('mergeTreeMs'),
    checkoutMs: phase('checkoutMs'),
    depsMs: phase('depsMs'),
    testMs: phase('testMs'),
    trees: [...new Set(runs.map((r) => r.result?.result?.tree))],
    passed: [...new Set(runs.map((r) => r.result?.result?.passed))],
    failures: runs.length - ok.length,
  };
  save('warm', { box, boot, exec, summary, runs });
  log('summary', summary);
}

/** Snapshot a booted container, then start new Durable Objects from the snapshot. */
async function snapshot(n = 5) {
  const src = `snapsrc-${stamp()}`;
  const boot = await call(src, 'boot', [{}]);
  log('source boot', boot);
  // Clone once so the snapshot carries a workspace, as a warm MergeBox would.
  const seedVerify = await call(src, 'verify', ['seed']);
  log('source verify', seedVerify.ok, seedVerify.result?.totalMs);
  const snap = await call(src, 'snapshot', [`keel-spike-04-${stamp()}`]);
  log('snapshot', snap);
  await call(src, 'destroy');
  if (!snap.ok) return save('snapshot', { boot, snap });
  const samples = [];
  for (let i = 0; i < n; i++) {
    const box = `fromsnap-${stamp()}-${i}`;
    const b = await call(box, 'boot', [{ snapshotId: snap.result.id }]);
    const v = i < 3 ? await call(box, 'verify', [`snaprun-${i}`]) : null;
    log('from snapshot', box, b, v?.result?.totalMs, v?.result?.result?.passed);
    await call(box, 'destroy');
    samples.push({ box, boot: b, verify: v });
  }
  const ok = samples.filter((s) => s.boot.ok);
  const summary = {
    snapshotMs: snap.result.ms,
    snapshotBytes: snap.result.size,
    readyAtMs: stats(ok.map((s) => s.boot.result.readyAtMs)),
    verifyTotalMs: stats(samples.filter((s) => s.verify?.ok).map((s) => s.verify.result.totalMs)),
    failures: samples.length - ok.length,
  };
  save('snapshot', { source: { boot, seedVerify }, snap, summary, samples });
  log('summary', summary);
}

/** n new Durable Objects at once, each: boot from the image + full verify + destroy. */
async function concurrent(n = 10) {
  if (n > CAP_CONCURRENT) throw new Error(`cap is ${CAP_CONCURRENT}`);
  const tag = stamp();
  const t0 = Date.now();
  const runs = await Promise.all(
    Array.from({ length: n }, async (_, i) => {
      const box = `conc-${tag}-${i}`;
      const s = Date.now();
      const boot = await call(box, 'boot', [{}]);
      const verify = boot.ok ? await call(box, 'verify', [`conc-${i}`]) : null;
      const destroy = await call(box, 'destroy');
      return { box, startOffsetMs: s - t0, endToEndMs: Date.now() - s, boot, verify, destroy };
    }),
  );
  const wallMs = Date.now() - t0;
  const good = runs.filter((r) => r.verify?.ok && r.verify.result.exitCode === 0 && r.verify.result.result.passed === 214);
  const summary = {
    n,
    wallMs,
    passed: good.length,
    failures: n - good.length,
    errors: runs.filter((r) => !good.includes(r)).map((r) => r.boot.error ?? r.verify?.error ?? r.verify?.result?.stderrTail),
    readyAtMs: stats(runs.filter((r) => r.boot.ok).map((r) => r.boot.result.readyAtMs)),
    verifyTotalMs: stats(good.map((r) => r.verify.result.totalMs)),
    testMs: stats(good.map((r) => r.verify.result.result.testMs)),
    cloneMs: stats(good.map((r) => r.verify.result.result.cloneMs)),
    endToEndMs: stats(runs.map((r) => r.endToEndMs)),
    trees: [...new Set(good.map((r) => r.verify.result.result.tree))],
  };
  save(`concurrent-${n}`, { summary, runs });
  log('summary', summary);
}

/**
 * Per instance type: one new container, the first verify (cold vitest), then
 * warm verifies and plain `vitest run` on the same checkout.
 */
async function instances(n = 3) {
  const out = {};
  for (const instance of ['standard-1', 'standard-2', 'standard-3']) {
    const box = `inst-${instance}-${stamp()}`;
    const boot = await call(box, 'boot', [{ instance }]);
    const coldVerify = await call(box, 'verify', ['first']);
    const warmVerifies = [];
    for (let i = 0; i < n; i++) warmVerifies.push(await call(box, 'verify', [`w${i}`]));
    const vitest = await call(box, 'vitest', [`w${n - 1}`, n]);
    await call(box, 'destroy');
    const ok = (v) => v.ok && v.result.exitCode === 0 && v.result.result.passed === 214;
    out[instance] = {
      summary: {
        readyAtMs: boot.result?.readyAtMs,
        coldVerifyMs: coldVerify.result?.totalMs,
        coldTestMs: coldVerify.result?.result?.testMs,
        coldPassed: coldVerify.result?.result?.passed,
        warmVerifyMs: stats(warmVerifies.filter(ok).map((v) => v.result.totalMs)),
        warmTestMs: stats(warmVerifies.filter(ok).map((v) => v.result.result.testMs)),
        plainVitestMs: stats((vitest.result?.samples ?? []).filter((s) => s.exitCode === 0).map((s) => s.ms)),
        failures: [coldVerify, ...warmVerifies].filter((v) => !ok(v)).length,
        cpu: vitest.result?.cpu,
      },
      boot,
      coldVerify,
      warmVerifies,
      vitest,
    };
    log(instance, out[instance].summary, vitest.result?.samples?.[0]?.tail);
  }
  save('instances', out);
}

/** Can-fail controls: a planted canary, no injection, and egress opened two ways. */
async function controls() {
  const out = {};
  const tag = stamp();
  // A fake token in the shape of a real one, planted everywhere the checks look.
  const canary = `art_v2_x_${'c0ffee'.repeat(10)}cafe?expires=1999999999`;

  const real = `ctl-real-${tag}`;
  out.real = {
    boot: await call(real, 'boot', [{}]),
    verify: await call(real, 'verify', ['r']),
    trace: await call(real, 'trace'),
    checks: await call(real, 'tokenChecks', [{}]),
    egress: await call(real, 'egressProbe'),
  };
  await call(real, 'destroy');
  log('real', out.real.checks, out.real.egress);

  const c = `ctl-canary-${tag}`;
  out.canary = {
    boot: await call(c, 'boot', [{ canary }]),
    verify: await call(c, 'verify', ['c']),
    checks: await call(c, 'tokenChecks', [{ canary }]),
  };
  await call(c, 'destroy');
  log('canary', out.canary.checks);

  const ni = `ctl-noinject-${tag}`;
  out.noInject = {
    boot: await call(ni, 'boot', [{ egress: 'no-inject' }]),
    verify: await call(ni, 'verify', ['n']),
    trace: await call(ni, 'trace'),
  };
  await call(ni, 'destroy');
  log('no-inject', out.noInject.verify, out.noInject.trace);

  for (const egress of ['open-internet', 'open-intercept']) {
    const b = `ctl-${egress}-${tag}`;
    out[egress] = { boot: await call(b, 'boot', [{ egress }]), egress: await call(b, 'egressProbe') };
    await call(b, 'destroy');
    log(egress, out[egress].egress);
  }
  save('controls', out);
}

const [exp, ...rest] = process.argv.slice(2);
const n = rest[0] ? Number(rest[0]) : undefined;
const experiments = { cold, restart, warm, snapshot, concurrent, instances, controls };
if (exp === 'call') {
  const [box, method, json] = rest;
  console.log(JSON.stringify(await call(box, method, json ? JSON.parse(json) : []), null, 2));
} else if (experiments[exp]) {
  if (exp !== 'concurrent' && (n ?? 0) > 50) throw new Error('too many samples');
  await experiments[exp](n);
} else {
  console.error('usage: drive.mjs call|cold|restart|warm|snapshot|concurrent|controls [n]');
  process.exit(2);
}
