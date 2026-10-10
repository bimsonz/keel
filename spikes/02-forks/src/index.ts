// keel-spike-02-forker: measures Artifacts fork latency and time-to-ready.
//
// Every route needs the `x-spike-key` header. Remote URLs are returned with the
// account host redacted; tokens are never returned.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { checkReady, dispose, errCode, type Readiness } from "./ready";

interface Env {
  ARTIFACTS: Artifacts;
  SPIKE_KEY: string;
  LOG?: D1Database;
}

type ArtifactsEvent = {
  type?: string;
  source?: { namespace?: string; repoName?: string };
  payload?: { namespace?: string; repoName?: string };
  metadata?: { eventTimestamp?: string };
};

function insertEvent(db: D1Database, recvAt: number, msgTs: number | null, body: unknown, via: string) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  let ev: ArtifactsEvent = {};
  try {
    ev = typeof body === "string" ? JSON.parse(body) : (body as ArtifactsEvent);
  } catch {
    // keep raw
  }
  return db
    .prepare(
      "INSERT INTO events (recv_at, msg_ts, type, ns, repo, target_ns, target_repo, event_ts, body_type, raw) VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(
      recvAt,
      msgTs,
      ev.type ?? null,
      ev.source?.namespace ?? null,
      ev.source?.repoName ?? null,
      ev.payload?.namespace ?? null,
      ev.payload?.repoName ?? null,
      ev.metadata?.eventTimestamp ?? null,
      `${via}:${typeof body}`,
      raw.replace(/"accountId":"[0-9a-f]{32}"/g, '"accountId":"<acct>"').slice(0, 4000),
    );
}

/** Started by `triggers.events` on cf.artifacts.repo.forked; records the event. */
export class ForkedEventWorkflow extends WorkflowEntrypoint<Env, unknown> {
  async run(event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<void> {
    const startedAt = Date.now();
    await step.do("record", async () => {
      if (!this.env.LOG) return;
      await insertEvent(this.env.LOG, startedAt, event.timestamp.getTime(), event.payload, `wf:${event.instanceId}`).run();
    });
  }
}

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

const redact = (s: string | null | undefined) =>
  s == null ? s : s.replace(/[0-9a-f]{32}\.artifacts/g, "<acct>.artifacts").replace(/art_v\d+_[A-Za-z0-9_?=]+/g, "<token>");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Attempt = { at: number; ms: number; reason: string };

async function headOf(env: Env, src: string): Promise<string> {
  const repo = await env.ARTIFACTS.get(src);
  try {
    const [c] = await repo.log({ limit: 1 });
    if (!c) throw new Error(`source ${src} has no commits`);
    return c.hash;
  } finally {
    dispose(repo);
  }
}

/**
 * Fork `src` to `name` and poll readiness from the moment fork() is called,
 * concurrently with it, so a fork that becomes visible before fork() returns
 * (or after) is observed either way.
 */
async function forkOnce(env: Env, src: string, name: string, head: string, pollMs: number, timeoutMs: number, opts: Record<string, unknown>) {
  const srcRepo = await env.ARTIFACTS.get(src);
  const t0 = Date.now();
  let forkReturnedMs: number | null = null;
  let forkError: string | null = null;
  let forkResult: Record<string, unknown> | null = null;

  const forkP = (async () => {
    try {
      const r = (await srcRepo.fork(name, opts)) as unknown as Record<string, unknown>;
      forkReturnedMs = Date.now() - t0;
      forkResult = {};
      for (const [k, v] of Object.entries(r)) {
        if (k === "token") forkResult[k] = typeof v === "string" ? "<token>" : typeof v;
        else forkResult[k] = typeof v === "string" ? redact(v) : v;
      }
    } catch (e) {
      forkReturnedMs = Date.now() - t0;
      forkError = errCode(e);
    }
  })();

  const attempts: Attempt[] = [];
  let readyMs: number | null = null;
  let firstReadyAttemptStartMs: number | null = null;
  while (Date.now() - t0 < timeoutMs) {
    const start = Date.now() - t0;
    const r: Readiness = await checkReady(env.ARTIFACTS, name, head);
    const end = Date.now() - t0;
    attempts.push({ at: start, ms: end - start, reason: r.ready ? "READY" : r.reason });
    if (r.ready) {
      readyMs = end;
      firstReadyAttemptStartMs = start;
      break;
    }
    if (forkError) break;
    await sleep(pollMs);
  }
  await forkP;
  dispose(srcRepo);

  let info: Record<string, unknown> | null = null;
  if (readyMs !== null) {
    const repo = await env.ARTIFACTS.get(name);
    try {
      const i = await repo.info();
      info = { name: i.name, source: i.source, defaultBranch: i.defaultBranch, readOnly: i.readOnly, remote: redact(i.remote), createdAt: i.createdAt };
    } finally {
      dispose(repo);
    }
  }

  const reasons: Record<string, number> = {};
  for (const a of attempts) reasons[a.reason] = (reasons[a.reason] ?? 0) + 1;
  return {
    name,
    src,
    head,
    t0,
    forkReturnedMs,
    forkError,
    forkResult,
    readyMs,
    firstReadyAttemptStartMs,
    readyBeforeForkReturned: readyMs !== null && forkReturnedMs !== null ? readyMs < forkReturnedMs : null,
    attemptCount: attempts.length,
    firstAttempt: attempts[0] ?? null,
    reasons,
    attempts: attempts.slice(0, 80),
    info,
  };
}

async function deleteTimed(env: Env, name: string) {
  const t = Date.now();
  try {
    const ok = await env.ARTIFACTS.delete(name);
    return { deleted: ok, deleteMs: Date.now() - t };
  } catch (e) {
    return { deleted: false, deleteMs: Date.now() - t, deleteError: errCode(e) };
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.headers.get("x-spike-key") !== env.SPIKE_KEY) return json({ error: "forbidden" }, 403);
    const url = new URL(req.url);
    const p = url.searchParams;
    const colo = (req.cf as { colo?: string } | undefined)?.colo ?? null;

    switch (url.pathname) {
      case "/now":
        return json({ now: Date.now(), colo });

      // One fork; optional immediate delete once timing is captured.
      case "/fork": {
        const src = p.get("src") ?? "src-1m";
        const name = p.get("name");
        if (!name) return json({ error: "name required" }, 400);
        const poll = Number(p.get("poll") ?? 150);
        const timeout = Number(p.get("timeout") ?? 120_000);
        const opts: Record<string, unknown> = {};
        if (p.has("dbo")) opts.defaultBranchOnly = p.get("dbo") === "1";
        if (p.has("xns")) opts.namespace = p.get("xns"); // not in the typed API: probe whether it is honoured
        const tHead = Date.now();
        const head = p.get("head") ?? (await headOf(env, src));
        const headMs = Date.now() - tHead;
        const out = await forkOnce(env, src, name, head, poll, timeout, opts);
        const del = p.get("del") === "1" ? await deleteTimed(env, name) : null;
        return json({ colo, headMs, ...out, del });
      }

      // N forks from inside one request with bounded concurrency (in-Worker fan-out).
      case "/bulk": {
        const src = p.get("src") ?? "src-1m";
        const prefix = p.get("prefix") ?? `b${Date.now().toString(36)}`;
        const n = Number(p.get("n") ?? 20);
        const conc = Number(p.get("conc") ?? n);
        const poll = Number(p.get("poll") ?? 200);
        const head = await headOf(env, src);
        const results: unknown[] = Array.from({ length: n });
        let next = 0;
        const worker = async () => {
          while (next < n) {
            const i = next++;
            const name = `${prefix}-${i}`;
            const r = await forkOnce(env, src, name, head, poll, 180_000, {});
            const del = p.get("del") === "1" ? await deleteTimed(env, name) : null;
            results[i] = { ...r, attempts: undefined, del };
          }
        };
        const t = Date.now();
        await Promise.all(Array.from({ length: Math.min(conc, n) }, worker));
        return json({ colo, n, conc, totalMs: Date.now() - t, results });
      }

      case "/check": {
        const name = p.get("name") ?? "";
        const head = p.get("head") ?? "";
        const t = Date.now();
        const r = await checkReady(env.ARTIFACTS, name, head);
        return json({ colo, name, head, ...r, ms: Date.now() - t });
      }

      // Can-fail: fork, then check readiness immediately (no poll), and again after it settles.
      case "/canfail": {
        const src = p.get("src") ?? "src-1m";
        const name = p.get("name") ?? `cf-${Date.now().toString(36)}`;
        const head = await headOf(env, src);
        const srcRepo = await env.ARTIFACTS.get(src);
        const t0 = Date.now();
        const forkP = srcRepo.fork(name).then(
          () => ({ ok: true, ms: Date.now() - t0 }),
          (e) => ({ ok: false, ms: Date.now() - t0, err: errCode(e) }),
        );
        const during = await checkReady(env.ARTIFACTS, name, head); // issued before fork() resolves
        const duringAt = Date.now() - t0;
        const fork = await forkP;
        const rightAfter = await checkReady(env.ARTIFACTS, name, head); // first check after fork() resolves
        const wrongHead = await checkReady(env.ARTIFACTS, name, "0".repeat(40)); // readCommit leg must fail
        let settled: Readiness = rightAfter;
        let polls = 0;
        while (!settled.ready && polls < 400) {
          await sleep(150);
          settled = await checkReady(env.ARTIFACTS, name, head);
          polls++;
        }
        dispose(srcRepo);
        const del = await deleteTimed(env, name);
        const afterDelete = await checkReady(env.ARTIFACTS, name, head);
        return json({ colo, name, during, duringAt, fork, rightAfter, wrongHead, settled, settledAfterPolls: polls, del, afterDelete });
      }

      // Can-fail: an empty repo (create, no push) must read as not ready for the source head.
      case "/empty": {
        const name = p.get("name") ?? `empty-${Date.now().toString(36)}`;
        const head = p.get("head") ?? "";
        await env.ARTIFACTS.create(name);
        const r = await checkReady(env.ARTIFACTS, name, head);
        const del = await deleteTimed(env, name);
        return json({ colo, name, ...r, del });
      }

      case "/info": {
        const name = p.get("name") ?? "";
        try {
          const repo = await env.ARTIFACTS.get(name);
          try {
            const i = await repo.info();
            const log = await repo.log({ limit: 5 });
            return json({ colo, ...i, remote: redact(i.remote), log: log.map((c) => c.hash) });
          } finally {
            dispose(repo);
          }
        } catch (e) {
          return json({ colo, name, error: errCode(e) }, 404);
        }
      }

      // Read every tree and blob reachable from HEAD: proves a fork's objects are
      // all present (e.g. after its parent was deleted).
      case "/verify": {
        const name = p.get("name") ?? "";
        const t = Date.now();
        try {
          const repo = await env.ARTIFACTS.get(name);
          try {
            const [c] = await repo.log({ limit: 1 });
            if (!c) return json({ colo, name, ok: false, error: "no HEAD" });
            let trees = 0;
            let blobs = 0;
            let bytes = 0;
            let missing = 0;
            const walk = async (h: string): Promise<void> => {
              const entries = await repo.readTree(h);
              if (!entries) {
                missing++;
                return;
              }
              trees++;
              await Promise.all(
                entries.map(async (e) => {
                  if (e.type === "tree") return walk(e.hash);
                  const b = await repo.readBlob(e.hash);
                  if (!b) missing++;
                  else {
                    blobs++;
                    bytes += b.size;
                  }
                }),
              );
            };
            await walk(c.treeHash);
            return json({ colo, name, ok: missing === 0, head: c.hash, trees, blobs, bytes, missing, ms: Date.now() - t });
          } finally {
            dispose(repo);
          }
        } catch (e) {
          return json({ colo, name, ok: false, error: errCode(e) });
        }
      }

      case "/delete": {
        const names = (p.get("names") ?? "").split(",").filter(Boolean);
        const out = await Promise.all(names.map(async (n) => ({ name: n, ...(await deleteTimed(env, n)) })));
        return json({ colo, out });
      }

      case "/list": {
        const repos: { name: string; source: string | null; createdAt: string }[] = [];
        let cursor: string | undefined;
        let total = 0;
        do {
          const page = await env.ARTIFACTS.list({ limit: 200, cursor });
          total = page.total;
          for (const r of page.repos) repos.push({ name: r.name, source: r.source, createdAt: r.createdAt });
          cursor = page.cursor;
        } while (cursor);
        return json({ colo, total, repos });
      }

      case "/events": {
        if (!env.LOG) return json({ error: "no LOG binding" }, 400);
        const since = Number(p.get("since") ?? 0);
        const rows = await env.LOG.prepare("SELECT * FROM events WHERE recv_at >= ? ORDER BY recv_at").bind(since).all();
        return json({ colo, rows: rows.results });
      }
    }
    return json({ error: "not found" }, 404);
  },

  // Account-level Artifacts events (repo.forked etc.) via a Queue event subscription.
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    const recvAt = Date.now();
    if (!env.LOG) {
      batch.ackAll();
      return;
    }
    const db = env.LOG;
    const stmts = batch.messages.map((m) => insertEvent(db, recvAt, m.timestamp.getTime(), m.body, "queue"));
    await env.LOG.batch(stmts);
    batch.ackAll();
  },
} satisfies ExportedHandler<Env>;
