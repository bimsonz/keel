// keel-spike-06-trigger: records every Workflow instance started by the
// namespace-wide `triggers.events` rule on cf.artifacts.repo.pushed, and every
// message from a per-repo Queue event subscription, into D1 (keel-spike-06-log).
//
// Every HTTP route needs the `x-spike-key` header. Tokens are returned only by
// /create (the local push driver needs them) and are never stored.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

interface Env {
  ARTIFACTS: Artifacts;
  LOG: D1Database;
  SPIKE_KEY: string;
}

type PushEvent = {
  type?: string;
  source?: { type?: string; namespace?: string; repoName?: string };
  payload?: { ref?: string; before?: string; after?: string; commits?: unknown[] };
  metadata?: { eventTimestamp?: string };
};

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

const scrub = (raw: string) =>
  raw
    .replace(/"accountId":"[0-9a-f]{32}"/g, '"accountId":"<acct>"')
    .replace(/[0-9a-f]{32}\.artifacts/g, "<acct>.artifacts")
    .replace(/art_v\d+_[A-Za-z0-9_?=]+/g, "<token>")
    .slice(0, 4000);

function parse(body: unknown): { ev: PushEvent; raw: string } {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  try {
    return { ev: (typeof body === "string" ? JSON.parse(body) : body) as PushEvent, raw };
  } catch {
    return { ev: {}, raw };
  }
}

export class PushEventWorkflow extends WorkflowEntrypoint<Env, unknown> {
  async run(event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<void> {
    const startedAt = Date.now(); // instance start, before any step
    const { ev, raw } = parse(event.payload);
    await step.do("record", async () => {
      await this.env.LOG.prepare(
        `INSERT OR IGNORE INTO instances (instance_id, started_at, wf_ts, type, ns, repo, ref, before, after, event_ts, payload_type, raw)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
        .bind(
          event.instanceId,
          startedAt,
          event.timestamp.getTime(),
          ev.type ?? null,
          ev.source?.namespace ?? null,
          ev.source?.repoName ?? null,
          ev.payload?.ref ?? null,
          ev.payload?.before ?? null,
          ev.payload?.after ?? null,
          ev.metadata?.eventTimestamp ?? null,
          typeof event.payload,
          scrub(raw),
        )
        .run();
    });
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

      case "/create": {
        const names = (p.get("names") ?? "").split(",").filter(Boolean);
        const out = await Promise.all(
          names.map(async (name) => {
            const t = Date.now();
            try {
              const r = await env.ARTIFACTS.create(name);
              return { name, remote: r.remote, token: r.token, createdAt: Date.now(), createMs: Date.now() - t };
            } catch (e) {
              return { name, error: String((e as { code?: string }).code ?? e) };
            }
          }),
        );
        return json({ colo, out });
      }

      // Does populating a fork look like a push to the namespace trigger?
      case "/fork": {
        const src = p.get("src") ?? "";
        const name = p.get("name") ?? "";
        const t = Date.now();
        try {
          const repo = await env.ARTIFACTS.get(src);
          await repo.fork(name);
          const [head] = await repo.log({ limit: 1 });
          return json({ colo, src, name, forkedAt: Date.now(), forkMs: Date.now() - t, head: head?.hash ?? null });
        } catch (e) {
          return json({ colo, src, name, error: String((e as { code?: string }).code ?? e) }, 500);
        }
      }

      case "/delete": {
        const names = (p.get("names") ?? "").split(",").filter(Boolean);
        const out = await Promise.all(
          names.map(async (name) => {
            try {
              return { name, deleted: await env.ARTIFACTS.delete(name) };
            } catch (e) {
              return { name, error: String((e as { code?: string }).code ?? e) };
            }
          }),
        );
        return json({ colo, out });
      }

      case "/list": {
        const repos: string[] = [];
        let cursor: string | undefined;
        let total = 0;
        do {
          const page = await env.ARTIFACTS.list({ limit: 200, cursor });
          total = page.total;
          repos.push(...page.repos.map((r) => r.name));
          cursor = page.cursor;
        } while (cursor);
        return json({ colo, total, repos });
      }

      case "/events": {
        const since = Number(p.get("since") ?? 0);
        const inst = await env.LOG.prepare(
          "SELECT instance_id, started_at, wf_ts, type, ns, repo, ref, before, after, event_ts, payload_type FROM instances WHERE started_at >= ? ORDER BY started_at",
        )
          .bind(since)
          .all();
        const q = await env.LOG.prepare(
          "SELECT recv_at, msg_ts, type, ns, repo, ref, before, after, event_ts, body_type FROM qevents WHERE recv_at >= ? ORDER BY recv_at",
        )
          .bind(since)
          .all();
        return json({ colo, instances: inst.results, qevents: q.results });
      }

      case "/sample": {
        const r = await env.LOG.prepare("SELECT raw FROM instances ORDER BY id LIMIT 1").first<{ raw: string }>();
        const q = await env.LOG.prepare("SELECT raw FROM qevents ORDER BY id LIMIT 1").first<{ raw: string }>();
        return json({ instance: r?.raw ?? null, qevent: q?.raw ?? null });
      }
    }
    return json({ error: "not found" }, 404);
  },

  // Per-repo `artifacts.repo` subscription (events: pushed) delivered to a Queue.
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    const recvAt = Date.now();
    const stmts = batch.messages.map((m) => {
      const { ev, raw } = parse(m.body);
      return env.LOG.prepare(
        `INSERT INTO qevents (recv_at, msg_ts, msg_id, type, ns, repo, ref, before, after, event_ts, body_type, raw)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(
        recvAt,
        m.timestamp.getTime(),
        m.id,
        ev.type ?? null,
        ev.source?.namespace ?? null,
        ev.source?.repoName ?? null,
        ev.payload?.ref ?? null,
        ev.payload?.before ?? null,
        ev.payload?.after ?? null,
        ev.metadata?.eventTimestamp ?? null,
        typeof m.body,
        scrub(raw),
      );
    });
    await env.LOG.batch(stmts);
    batch.ackAll();
  },
} satisfies ExportedHandler<Env>;
