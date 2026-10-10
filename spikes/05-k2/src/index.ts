// keel-spike-05-log
//
// LogProducer: a SQLite DO that writes ~300-byte JSON ops records to K2 through the
// `k2` binding (env.OPS.send), one record per call or batched, timing every call.
// Each record carries a per-entity sequence number the producer persists.
//
// Projector: the nudged consumer. nudge() arms an alarm only if none is set; each
// alarm pulls batch(es) from a K2 subscription over HTTP with the consume token,
// checks per-entity order and duplicates, records lag, acks, and re-arms only while
// the last pull returned records. An empty pull ends the loop until the next nudge.
//
// /k2/* is a thin authenticated pass-through to the stream endpoint (it adds the
// consume token), used by scripts/lease.ts for the lease-expiry and nack probes.
// Every route requires the x-spike-key header to match the SPIKE_KEY secret.
import { DurableObject } from "cloudflare:workers";
import { check, newState, summarise, type CheckState, type Obs } from "./check.ts";

type Secrets = { SPIKE_KEY: string; K2_CONSUME_TOKEN?: string };
type E = Env & Secrets;

const enc = new TextEncoder();

let coloCache: string | undefined;
async function colo(): Promise<string> {
  if (coloCache) return coloCache;
  const t = await (await fetch("https://www.cloudflare.com/cdn-cgi/trace")).text();
  coloCache = /colo=(\w+)/.exec(t)?.[1] ?? "?";
  return coloCache;
}

function hex40(n: number): string {
  let x = (n * 2654435761) >>> 0;
  let s = "";
  while (s.length < 40) {
    x = (x * 1103515245 + 12345) >>> 0;
    s += x.toString(16).padStart(8, "0");
  }
  return s.slice(0, 40);
}

// ~300 bytes of JSON, padded to exactly 300.
function makeRecord(run: string, entity: string, seq: number, gseq: number): string {
  const r = {
    v: 1,
    id: `${run}:${entity}:${seq}`,
    run,
    entity,
    seq,
    gseq,
    kind: "ref.updated",
    at: Date.now(),
    actor: `agent-${gseq % 7}`,
    ref: "refs/heads/main",
    old: hex40(gseq),
    new: hex40(gseq + 1),
    pad: "",
  };
  r.pad = "x".repeat(Math.max(0, 300 - JSON.stringify(r).length));
  return JSON.stringify(r);
}

function junk(bytes: number, i: number): Uint8Array {
  const head = `{"junk":${i},"pad":"`;
  return enc.encode(head + "x".repeat(Math.max(0, bytes - head.length - 2)) + `"}`);
}

type ProduceOpts = {
  run: string;
  mode: "single" | "batch";
  count: number;
  batchSize?: number;
  entities?: number;
  nudge?: string; // projector name to nudge after each successful send
  gapMs?: number; // pause between sends (paced produce for the lag test)
  lanes?: number; // concurrent senders; each owns a disjoint set of entities and sends in order
  ns?: string; // entity name prefix, so producers with separate seq state never share an entity
};

export class LogProducer extends DurableObject<E> {
  sql = this.ctx.storage.sql;

  constructor(ctx: DurableObjectState, env: E) {
    super(ctx, env);
    this.sql.exec("CREATE TABLE IF NOT EXISTS seqs(entity TEXT PRIMARY KEY, seq INTEGER NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v INTEGER NOT NULL)");
  }

  async produce(o: ProduceOpts) {
    const seqs = new Map<string, number>();
    for (const row of this.sql.exec<{ entity: string; seq: number }>("SELECT entity, seq FROM seqs")) seqs.set(row.entity, row.seq);
    let gseq = this.sql.exec<{ v: number }>("SELECT v FROM meta WHERE k = 'gseq'").toArray()[0]?.v ?? 0;
    const entities = o.entities ?? 50;
    const batchSize = o.mode === "single" ? 1 : (o.batchSize ?? 100);
    const projector = o.nudge ? this.env.PROJECTOR.get(this.env.PROJECTOR.idFromName(o.nudge)) : undefined;

    const lat: number[] = [];
    const nudgeLat: number[] = [];
    const errors: { at: number; code: number; message: string; retryable: boolean }[] = [];
    const lanes = Math.max(1, Math.min(o.lanes ?? 1, entities));
    const perLane = Math.ceil(entities / lanes);
    const t0 = Date.now();
    let claimed = 0;
    let sent = 0;
    let bytes = 0;
    // Lane L owns entities L, L + lanes, L + 2*lanes, ...: one in-flight send per entity,
    // so per-entity order at the producer is send order even with lanes > 1.
    const lane = async (l: number) => {
      while (claimed < o.count) {
        const n = Math.min(batchSize, o.count - claimed);
        claimed += n;
        const recs: { content: Uint8Array; headers: Record<string, string> }[] = [];
        for (let i = 0; i < n; i++) {
          let idx = l + lanes * Math.floor(Math.random() * perLane);
          if (idx >= entities) idx = l;
          const entity = `${o.ns ? `${o.ns}/` : ""}repo-${String(idx).padStart(3, "0")}`;
          const seq = (seqs.get(entity) ?? 0) + 1;
          seqs.set(entity, seq);
          gseq++;
          const content = enc.encode(makeRecord(o.run, entity, seq, gseq));
          bytes += content.byteLength;
          recs.push({ content, headers: { entity, seq: String(seq), run: o.run } });
        }
        let attempt = 0;
        for (;;) {
          const a = Date.now();
          const r = await this.env.OPS.send(recs);
          const b = Date.now();
          lat.push(b - a);
          if (r.success) break;
          errors.push({ at: sent, ...r.error });
          if (!r.error.retryable || ++attempt > 3) break;
          await scheduler.wait(100 * 2 ** attempt);
        }
        sent += n;
        if (projector) {
          const c = Date.now();
          await projector.nudge();
          nudgeLat.push(Date.now() - c);
        }
        if (o.gapMs) await scheduler.wait(o.gapMs);
      }
    };
    await Promise.all(Array.from({ length: lanes }, (_, l) => lane(l)));
    const wallMs = Date.now() - t0;
    for (const [entity, seq] of seqs) this.sql.exec("INSERT INTO seqs(entity, seq) VALUES (?, ?) ON CONFLICT(entity) DO UPDATE SET seq = excluded.seq", entity, seq);
    this.sql.exec("INSERT INTO meta(k, v) VALUES ('gseq', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", gseq);
    return {
      run: o.run,
      mode: o.mode,
      batchSize,
      lanes,
      records: sent,
      calls: lat.length,
      bytes,
      wallMs,
      recordsPerSec: Math.round((sent / wallMs) * 1000),
      latency: summarise(lat),
      nudge: nudgeLat.length ? summarise(nudgeLat) : null,
      lat,
      errors,
      colo: await colo(),
    };
  }

  async colo() {
    return colo();
  }

  // Fallback comparison: the same records sent to a Queue, timing send()/sendBatch().
  async produceQueue(o: { run: string; count: number; batchSize: number; entities?: number }) {
    const entities = o.entities ?? 50;
    const seqs = new Map<string, number>();
    const lat: number[] = [];
    const errors: string[] = [];
    let gseq = 0;
    const t0 = Date.now();
    for (let sent = 0; sent < o.count; ) {
      const n = Math.min(o.batchSize, o.count - sent);
      const bodies: unknown[] = [];
      for (let i = 0; i < n; i++) {
        const entity = `${o.run}/repo-${String(Math.floor(Math.random() * entities)).padStart(3, "0")}`;
        const seq = (seqs.get(entity) ?? 0) + 1;
        seqs.set(entity, seq);
        bodies.push(JSON.parse(makeRecord(o.run, entity, seq, ++gseq)));
      }
      const a = Date.now();
      try {
        if (o.batchSize === 1) await this.env.FALLBACK_Q.send(bodies[0], { contentType: "json" });
        else await this.env.FALLBACK_Q.sendBatch(bodies.map((body) => ({ body, contentType: "json" as const })));
      } catch (e) {
        errors.push(String(e));
      }
      lat.push(Date.now() - a);
      sent += n;
    }
    const wallMs = Date.now() - t0;
    return { run: o.run, records: o.count, batchSize: o.batchSize, calls: lat.length, wallMs, recordsPerSec: Math.round((o.count / wallMs) * 1000), latency: summarise(lat), lat, errors, colo: await colo() };
  }

  // How send() reports bad input: returned error object or thrown exception.
  // Payloads are valid JSON tagged "junk" in case K2 unexpectedly accepts one.
  async errorProbes() {
    const cases: [string, () => unknown[]][] = [
      ["empty batch []", () => []],
      ["one record of 1,000,001 bytes", () => [{ content: junk(1_000_001, 1) }]],
      ["6 records of 900,000 bytes (5.4 MB batch)", () => Array.from({ length: 6 }, (_, i) => ({ content: junk(900_000, i) }))],
      ["string content", () => [{ content: '{"junk":"string"}' }]],
      ["33 headers on one record", () => [{ content: junk(100, 9), headers: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`h${i}`, "v"])) }]],
    ];
    const out: { case: string; ms: number; result?: unknown; threw?: string }[] = [];
    for (const [name, make] of cases) {
      const a = Date.now();
      try {
        const result = await this.env.OPS.send(make() as Parameters<Env["OPS"]["send"]>[0]);
        out.push({ case: name, ms: Date.now() - a, result });
      } catch (e) {
        out.push({ case: name, ms: Date.now() - a, threw: String(e) });
      }
    }
    return out;
  }
}

type K2Rec = { timestamp_ms: number; content: string; headers?: Record<string, string> };
type K2Resp<T> = { success: boolean; result: T; errors?: { code: number; message: string }[] };
type ConsumeResult = { batch_id: string | null; leased_until_ms: number | null; records: K2Rec[] };

async function k2(env: E, method: string, path: string, body?: unknown) {
  if (!env.K2_CONSUME_TOKEN) throw new Error("K2_CONSUME_TOKEN secret is not set");
  const r = await fetch(env.K2_ENDPOINT + path, {
    method,
    headers: { authorization: `Bearer ${env.K2_CONSUME_TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: r.status, text, json };
}

const RETRYABLE = new Set([10211, 10214, 10216, 10217]);

type Cfg = {
  sub: string;
  workerId: string;
  maxRecords: number;
  batchesPerAlarm: number;
  chaos: "none" | "shuffle" | "dup";
  maxBatches: number; // 0 = unlimited
  baselineFromFirst: boolean;
};

export class Projector extends DurableObject<E> {
  sql = this.ctx.storage.sql;
  st: CheckState | undefined;

  constructor(ctx: DurableObjectState, env: E) {
    super(ctx, env);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS obs(id TEXT, entity TEXT, seq INTEGER, produced_at INTEGER, k2_ts INTEGER, consumed_at INTEGER, batch INTEGER);
      CREATE TABLE IF NOT EXISTS seen(id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS last(entity TEXT PRIMARY KEY, seq INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS batches(i INTEGER PRIMARY KEY AUTOINCREMENT, alarm INTEGER, n INTEGER, bytes INTEGER,
        t_start INTEGER, t_consumed INTEGER, t_acked INTEGER, findings INTEGER, ack_status INTEGER);
      CREATE TABLE IF NOT EXISTS findings(kind TEXT, id TEXT, entity TEXT, seq INTEGER, expected INTEGER, batch INTEGER);
      CREATE TABLE IF NOT EXISTS events(t INTEGER, kind TEXT, detail TEXT);
    `);
  }

  private get(k: string): string | undefined {
    return this.sql.exec<{ v: string }>("SELECT v FROM kv WHERE k = ?", k).toArray()[0]?.v;
  }
  private put(k: string, v: string) {
    this.sql.exec("INSERT INTO kv(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, v);
  }
  private bump(k: string) {
    this.put(k, String(Number(this.get(k) ?? 0) + 1));
  }
  private event(kind: string, detail: unknown) {
    this.sql.exec("INSERT INTO events(t, kind, detail) VALUES (?, ?, ?)", Date.now(), kind, JSON.stringify(detail));
  }
  private cfg(): Cfg | undefined {
    const c = this.get("cfg");
    return c ? (JSON.parse(c) as Cfg) : undefined;
  }
  private state(cfg: Cfg): CheckState {
    if (this.st) return this.st;
    const st = newState(cfg.baselineFromFirst);
    for (const r of this.sql.exec<{ id: string }>("SELECT id FROM seen")) st.seen.add(r.id);
    for (const r of this.sql.exec<{ entity: string; seq: number }>("SELECT entity, seq FROM last")) st.last.set(r.entity, r.seq);
    this.st = st;
    return st;
  }

  async reset(cfg: Cfg) {
    await this.ctx.storage.deleteAlarm();
    this.sql.exec("DELETE FROM kv; DELETE FROM obs; DELETE FROM seen; DELETE FROM last; DELETE FROM batches; DELETE FROM findings; DELETE FROM events;");
    this.st = undefined;
    this.put("cfg", JSON.stringify(cfg));
    return { ok: true, cfg };
  }

  // The nudge: arm an alarm now unless one is already pending. Cheap and idempotent.
  async nudge() {
    this.bump("nudges");
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now());
      this.bump("armed");
    }
  }

  async alarm() {
    const cfg = this.cfg();
    if (!cfg) return;
    this.bump("alarms");
    const st = this.state(cfg);
    for (let k = 0; k < cfg.batchesPerAlarm; k++) {
      const done = Number(this.sql.exec<{ c: number }>("SELECT count(*) AS c FROM batches").one().c);
      if (cfg.maxBatches && done >= cfg.maxBatches) {
        this.event("max-batches", { done });
        return;
      }
      const tStart = Date.now();
      const res = await k2(this.env, "POST", `/subscriptions/${cfg.sub}/consume`, { worker_id: cfg.workerId, max_records: cfg.maxRecords });
      const tConsumed = Date.now();
      const body = res.json as K2Resp<ConsumeResult> | null;
      if (res.status !== 200 || !body?.success) {
        const code = body?.errors?.[0]?.code ?? 0;
        this.event("consume-error", { status: res.status, code, text: res.text.slice(0, 300) });
        if (RETRYABLE.has(code)) await this.ctx.storage.setAlarm(Date.now() + 1000);
        return;
      }
      const { batch_id, records } = body.result;
      if (records.length === 0 || !batch_id) {
        this.bump("empty");
        this.put("idle_at", String(tConsumed));
        return; // backlog drained: do not re-arm; the next nudge restarts the loop
      }
      const batchNo = Number(this.get("batch_seq") ?? 0) + 1;
      this.put("batch_seq", String(batchNo));
      let decoded: (Obs & { at: number; ts: number })[] = [];
      for (const r of records) {
        try {
          const j = JSON.parse(atob(r.content)) as { id?: string; entity?: string; seq?: number; at?: number };
          if (typeof j.id === "string" && typeof j.entity === "string" && typeof j.seq === "number" && typeof j.at === "number")
            decoded.push({ id: j.id, entity: j.entity, seq: j.seq, at: j.at, ts: r.timestamp_ms });
          else this.bump("foreign");
        } catch {
          this.bump("foreign");
        }
      }
      if (cfg.chaos === "shuffle") {
        decoded = [...decoded];
        for (let i = decoded.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [decoded[i], decoded[j]] = [decoded[j]!, decoded[i]!];
        }
      } else if (cfg.chaos === "dup" && decoded.length) {
        decoded = [...decoded, decoded[0]!];
      }
      const touched = new Set(decoded.map((d) => d.entity));
      const found = check(decoded, st);
      for (const d of decoded) this.sql.exec("INSERT INTO obs VALUES (?, ?, ?, ?, ?, ?, ?)", d.id, d.entity, d.seq, d.at, d.ts, tConsumed, batchNo);
      for (const d of decoded) this.sql.exec("INSERT OR IGNORE INTO seen(id) VALUES (?)", d.id);
      for (const entity of touched) {
        const seq = st.last.get(entity);
        if (seq !== undefined) this.sql.exec("INSERT INTO last(entity, seq) VALUES (?, ?) ON CONFLICT(entity) DO UPDATE SET seq = excluded.seq", entity, seq);
      }
      for (const f of found) this.sql.exec("INSERT INTO findings VALUES (?, ?, ?, ?, ?, ?)", f.kind, f.id, f.entity, f.seq, f.expected, batchNo);
      const ack = await k2(this.env, "POST", `/subscriptions/${cfg.sub}/batches/${batch_id}/ack`, { worker_id: cfg.workerId });
      const tAcked = Date.now();
      this.sql.exec(
        "INSERT INTO batches(alarm, n, bytes, t_start, t_consumed, t_acked, findings, ack_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        Number(this.get("alarms")),
        records.length,
        res.text.length,
        tStart,
        tConsumed,
        tAcked,
        found.length,
        ack.status,
      );
      if (ack.status !== 200) {
        this.event("ack-error", { status: ack.status, text: ack.text.slice(0, 300) });
        return;
      }
    }
    await this.ctx.storage.setAlarm(Date.now()); // the last pull had records: assume a backlog
  }

  // Queue fallback sink: rows from the queue() handler, checked like K2 records.
  async sinkQueue(rows: { id: string; entity: string; seq: number; at: number; attempts: number }[], consumedAt: number) {
    this.sql.exec("CREATE TABLE IF NOT EXISTS qobs(id TEXT, entity TEXT, seq INTEGER, produced_at INTEGER, consumed_at INTEGER, attempts INTEGER)");
    const st = this.st ?? (this.st = newState(false));
    const found = check(rows, st);
    for (const r of rows) this.sql.exec("INSERT INTO qobs VALUES (?, ?, ?, ?, ?, ?)", r.id, r.entity, r.seq, r.at, consumedAt, r.attempts);
    for (const f of found) this.sql.exec("INSERT INTO findings VALUES (?, ?, ?, ?, ?, ?)", f.kind, f.id, f.entity, f.seq, f.expected, 0);
    this.bump("qbatches");
  }

  async queueStats() {
    this.sql.exec("CREATE TABLE IF NOT EXISTS qobs(id TEXT, entity TEXT, seq INTEGER, produced_at INTEGER, consumed_at INTEGER, attempts INTEGER)");
    const rows = this.sql.exec<{ lag: number; attempts: number }>("SELECT consumed_at - produced_at AS lag, attempts FROM qobs").toArray();
    const c = this.sql.exec<{ total: number; uniq: number; first: number; last: number }>(
      "SELECT count(*) AS total, count(DISTINCT id) AS uniq, min(produced_at) AS first, max(consumed_at) AS last FROM qobs",
    ).one();
    const fk = this.sql.exec<{ kind: string; c: number }>("SELECT kind, count(*) AS c FROM findings GROUP BY kind").toArray();
    return {
      colo: await colo(),
      batches: Number(this.get("qbatches") ?? 0),
      total: c.total,
      unique: c.uniq,
      firstProducedToLastConsumedMs: c.last - c.first,
      lag: summarise(rows.map((r) => r.lag)),
      retried: rows.filter((r) => r.attempts > 1).length,
      findings: Object.fromEntries(fk.map((r) => [r.kind, r.c])),
      firstFindings: this.sql.exec("SELECT * FROM findings LIMIT 8").toArray(),
    };
  }

  async stats() {
    const kv = Object.fromEntries(this.sql.exec<{ k: string; v: string }>("SELECT k, v FROM kv").toArray().map((r) => [r.k, r.v]));
    const b = this.sql
      .exec<{ n: number; bytes: number; t_start: number; t_consumed: number; t_acked: number; findings: number; ack_status: number }>(
        "SELECT n, bytes, t_start, t_consumed, t_acked, findings, ack_status FROM batches ORDER BY i",
      )
      .toArray();
    const lags = this.sql
      .exec<{ e2e: number; store: number; deliver: number }>("SELECT consumed_at - produced_at AS e2e, k2_ts - produced_at AS store, consumed_at - k2_ts AS deliver FROM obs")
      .toArray();
    const counts = this.sql.exec<{ total: number; uniq: number }>("SELECT count(*) AS total, count(DISTINCT id) AS uniq FROM obs").one();
    const fk = this.sql.exec<{ kind: string; c: number }>("SELECT kind, count(*) AS c FROM findings GROUP BY kind").toArray();
    const firstFindings = this.sql.exec("SELECT * FROM findings LIMIT 8").toArray();
    const events = this.sql.exec("SELECT * FROM events ORDER BY t LIMIT 20").toArray();
    const records = b.reduce((a, x) => a + x.n, 0);
    const spanMs = b.length ? b.at(-1)!.t_acked - b[0]!.t_start : 0;
    const busyMs = b.reduce((a, x) => a + (x.t_acked - x.t_start), 0);
    return {
      colo: await colo(),
      cfg: kv.cfg ? JSON.parse(kv.cfg) : null,
      counters: { nudges: Number(kv.nudges ?? 0), armed: Number(kv.armed ?? 0), alarms: Number(kv.alarms ?? 0), empty: Number(kv.empty ?? 0), foreign: Number(kv.foreign ?? 0) },
      alarmPending: await this.ctx.storage.getAlarm(),
      batches: b.length,
      records,
      uniqueIds: counts.uniq,
      totalObs: counts.total,
      bytes: b.reduce((a, x) => a + x.bytes, 0),
      spanMs,
      recordsPerSec: spanMs ? Math.round((records / spanMs) * 1000) : 0,
      busyRecordsPerSec: busyMs ? Math.round((records / busyMs) * 1000) : 0,
      batchSize: summarise(b.map((x) => x.n)),
      consumeMs: summarise(b.map((x) => x.t_consumed - x.t_start)),
      processAndAckMs: summarise(b.map((x) => x.t_acked - x.t_consumed)),
      gapBetweenBatchesMs: summarise(b.slice(1).map((x, i) => x.t_start - b[i]!.t_acked)),
      ackNon200: b.filter((x) => x.ack_status !== 200).length,
      lag: {
        produceToConsume: summarise(lags.map((l) => l.e2e)),
        produceToK2Timestamp: summarise(lags.map((l) => l.store)),
        k2TimestampToConsume: summarise(lags.map((l) => l.deliver)),
      },
      findings: Object.fromEntries(fk.map((r) => [r.kind, r.c])),
      firstFindings,
      events,
      idleAt: kv.idle_at ? Number(kv.idle_at) : null,
      firstStart: b[0]?.t_start ?? null,
      lastAck: b.at(-1)?.t_acked ?? null,
    };
  }
}

async function authorised(req: Request, env: E): Promise<boolean> {
  const a = enc.encode(req.headers.get("x-spike-key") ?? "");
  const b = enc.encode(env.SPIKE_KEY ?? "");
  return b.byteLength > 0 && a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v, null, 1), { status, headers: { "content-type": "application/json" } });

export default {
  async fetch(req, env): Promise<Response> {
    if (!(await authorised(req, env))) return new Response("forbidden", { status: 403 });
    const url = new URL(req.url);
    const p = url.pathname;

    if (p === "/colo") {
      const prod = env.PRODUCER.get(env.PRODUCER.idFromName(url.searchParams.get("producer") ?? "p"));
      return json({ edge: (req.cf as { colo?: string } | undefined)?.colo, worker: await colo(), producerDo: await prod.colo() });
    }
    if (p === "/token") return json({ consumeTokenSet: Boolean(env.K2_CONSUME_TOKEN) });
    if (p === "/error-probes" && req.method === "POST") return json(await env.PRODUCER.get(env.PRODUCER.idFromName("p-errors")).errorProbes());

    if (p === "/produce" && req.method === "POST") {
      const o = (await req.json()) as ProduceOpts;
      const hint = url.searchParams.get("hint") as DurableObjectLocationHint | null;
      const ns = env.PRODUCER;
      const prod = ns.get(ns.idFromName(url.searchParams.get("producer") ?? "p"), hint ? { locationHint: hint } : undefined);
      return json(await prod.produce(o));
    }

    if (p === "/produce-queue" && req.method === "POST") {
      const o = (await req.json()) as { run: string; count: number; batchSize: number };
      return json(await env.PRODUCER.get(env.PRODUCER.idFromName("p-queue")).produceQueue(o));
    }
    if (p === "/queue-stats") return json(await env.PROJECTOR.get(env.PROJECTOR.idFromName("qsink")).queueStats());

    const m = /^\/projector\/([\w-]+)\/(reset|nudge|stats)$/.exec(p);
    if (m) {
      const stub = env.PROJECTOR.get(env.PROJECTOR.idFromName(m[1]!));
      if (m[2] === "reset") return json(await stub.reset((await req.json()) as Cfg));
      if (m[2] === "nudge") {
        await stub.nudge();
        return json({ nudged: true });
      }
      return json(await stub.stats());
    }

    if (p.startsWith("/k2/")) {
      const body = req.method === "GET" || req.method === "DELETE" ? undefined : await req.json();
      const t0 = Date.now();
      const r = await k2(env, req.method, p.slice(3) + url.search, body);
      return new Response(r.text, { status: r.status, headers: { "content-type": "application/json", "x-k2-ms": String(Date.now() - t0) } });
    }
    return new Response("not found", { status: 404 });
  },

  async queue(batch, env): Promise<void> {
    const consumedAt = Date.now();
    const rows = batch.messages.map((m) => {
      const b = m.body as { id: string; entity: string; seq: number; at: number };
      return { id: b.id, entity: b.entity, seq: b.seq, at: b.at, attempts: m.attempts };
    });
    await env.PROJECTOR.get(env.PROJECTOR.idFromName("qsink")).sinkQueue(rows, consumedAt);
    batch.ackAll();
  },
} satisfies ExportedHandler<E>;
