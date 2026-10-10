// Ordering families: fifo < per-key-fifo < unordered.
import { b, code, type Block, type Family } from "./types.ts";

const ALL = ["fifo", "per-key-fifo", "unordered"];

// ---------- TypeScript: webhook drain ----------
function tsOrder(fn: string, item: string, key: string, send: string, v: string, trap?: string): Block {
  const sig = `export async function ${fn}(pending: ${item}[]): Promise<void>`;
  if (trap === "group-then-sequential") {
    return b(code`
      ${sig} {
        const groups = Map.groupBy(pending, (d) => d.${key});
        await Promise.all([...groups.keys()].map((k) => warmConnection(k)));
        for (const d of pending) {
          await ${send}(d);
        }
      }`, [fn, "function"]);
  }
  switch (v) {
    case "fifo":
      return b(code`
        ${sig} {
          for (const d of pending) {
            await ${send}(d);
          }
        }`, [fn, "function"]);
    case "per-key-fifo":
      return b(code`
        ${sig} {
          const groups = Map.groupBy(pending, (d) => d.${key});
          await Promise.all(
            [...groups.values()].map(async (group) => {
              for (const d of group) await ${send}(d);
            }),
          );
        }`, [fn, "function"]);
    case "unordered":
      return b(code`
        ${sig} {
          await Promise.all(pending.map((d) => ${send}(d)));
        }`, [fn, "function"]);
  }
  throw new Error(v);
}

const orTs: Family = {
  id: "or-ts",
  predicate: "ordering",
  language: "typescript",
  subject: "webhooks.delivery",
  scope: "service:webhooks",
  anchor: "drainDeliveries",
  values: ALL,
  sibValues: ALL,
  baseline: "fifo",
  mech: {
    fifo: "drainDeliveries awaits each delivery in turn over the whole pending list",
    "per-key-fifo": "drainDeliveries groups by repoId and runs the groups concurrently, each group sequentially",
    unordered: "drainDeliveries starts every delivery at once with Promise.all",
  },
  traps: [
    {
      name: "group-then-sequential", value: "fifo", premise: "fifo",
      before: { s: "fifo", sib: "fifo" }, after: { s: "fifo", sib: "fifo", trap: "group-then-sequential" },
      why: "Map.groupBy and Promise.all are added, but only to warm one connection per repository; the deliveries themselves are still awaited one by one in list order: fifo.",
    },
  ],
  render({ s, sib, trap }) {
    return [{
      path: "src/webhooks/drain.ts",
      blocks: [
        b(`import { deliver, warmConnection, type Delivery } from "./deliver.ts";\nimport { notify, type Reminder } from "./notify.ts";`),
        tsOrder("drainDeliveries", "Delivery", "repoId", "deliver", s, trap),
        tsOrder("drainReminders", "Reminder", "userId", "notify", sib),
      ],
    }];
  },
};

// ---------- Go: audit writer ----------
function goOrder(typ: string, v: string): Block[] {
  switch (v) {
    case "fifo":
      return [
        b(code`
          func (w *${typ}) Start(ctx context.Context) {
              go w.loop(ctx, w.events)
          }`, [`${typ}.Start`, "method"]),
        b(code`
          func (w *${typ}) Submit(ev Event) {
              w.events <- ev
          }`, [`${typ}.Submit`, "method"]),
      ];
    case "per-key-fifo":
      return [
        b(code`
          func (w *${typ}) Start(ctx context.Context) {
              w.lanes = make([]chan Event, 8)
              for i := range w.lanes {
                  w.lanes[i] = make(chan Event, 64)
                  go w.loop(ctx, w.lanes[i])
              }
          }`, [`${typ}.Start`, "method"]),
        b(code`
          func (w *${typ}) Submit(ev Event) {
              h := fnv.New32a()
              h.Write([]byte(ev.TenantID))
              w.lanes[h.Sum32()%uint32(len(w.lanes))] <- ev
          }`, [`${typ}.Submit`, "method"]),
      ];
    case "unordered":
      return [
        b(code`
          func (w *${typ}) Start(ctx context.Context) {
              for i := 0; i < 8; i++ {
                  go w.loop(ctx, w.events)
              }
          }`, [`${typ}.Start`, "method"]),
        b(code`
          func (w *${typ}) Submit(ev Event) {
              w.events <- ev
          }`, [`${typ}.Submit`, "method"]),
      ];
  }
  throw new Error(v);
}

const goLoop = (typ: string, sink: string) => b(code`
  func (w *${typ}) loop(ctx context.Context, in <-chan Event) {
      for {
          select {
          case ev := <-in:
              if err := w.${sink}.Append(ctx, ev); err != nil {
                  log.Printf("${sink}: %v", err)
              }
          case <-ctx.Done():
              return
          }
      }
  }`, [`${typ}.loop`, "method"]);

const orGo: Family = {
  id: "or-go",
  predicate: "ordering",
  language: "go",
  subject: "audit.append",
  scope: "service:audit",
  anchor: "AuditWriter.Start",
  values: ALL,
  sibValues: ALL,
  baseline: "unordered",
  mech: {
    fifo: "one goroutine drains the single events channel",
    "per-key-fifo": "Submit hashes TenantID onto one of 8 lanes, each drained by its own goroutine",
    unordered: "8 goroutines drain the same events channel",
  },
  render({ s, sib }) {
    return [
      {
        path: "internal/audit/writer.go",
        blocks: [
          b(code`
            package audit

            import (
                "context"
                "hash/fnv"
                "log"
            )

            type AuditWriter struct {
                events chan Event
                lanes  []chan Event
                sink   Sink
            }`),
          ...goOrder("AuditWriter", s),
          goLoop("AuditWriter", "sink"),
        ],
      },
      {
        path: "internal/audit/metrics_writer.go",
        blocks: [
          b(code`
            package audit

            import (
                "context"
                "hash/fnv"
                "log"
            )

            type MetricsWriter struct {
                events chan Event
                lanes  []chan Event
                store  Sink
            }`),
          ...goOrder("MetricsWriter", sib),
          goLoop("MetricsWriter", "store"),
        ],
      },
    ];
  },
};

// ---------- Python: outbox relay ----------
function pyOrder(fn: string, table: string, v: string, trap?: string): Block[] {
  if (trap === "gather-fetch") {
    return [b(code`
      async def ${fn}(batch_size: int = 100) -> None:
          rows = await db.fetch_unsent("${table}", limit=batch_size)
          payloads = await asyncio.gather(*(render(row) for row in rows))
          for row, payload in zip(rows, payloads):
              await publish(row.topic, payload, key=row.aggregate_id)
              await db.mark_sent("${table}", row.id)`, [fn, "function"])];
  }
  switch (v) {
    case "fifo":
      return [b(code`
        async def ${fn}(batch_size: int = 100) -> None:
            rows = await db.fetch_unsent("${table}", limit=batch_size)
            for row in rows:
                await publish(row.topic, await render(row), key=row.aggregate_id)
                await db.mark_sent("${table}", row.id)`, [fn, "function"])];
    case "per-key-fifo":
      return [b(code`
        async def ${fn}(batch_size: int = 100) -> None:
            rows = await db.fetch_unsent("${table}", limit=batch_size)
            lanes: dict[str, list] = defaultdict(list)
            for row in rows:
                lanes[row.aggregate_id].append(row)

            async def drain(lane: list) -> None:
                for row in lane:
                    await publish(row.topic, await render(row), key=row.aggregate_id)
                    await db.mark_sent("${table}", row.id)

            await asyncio.gather(*(drain(lane) for lane in lanes.values()))`, [fn, "function"])];
    case "unordered":
      return [b(code`
        async def ${fn}(batch_size: int = 100) -> None:
            rows = await db.fetch_unsent("${table}", limit=batch_size)

            async def send(row) -> None:
                await publish(row.topic, await render(row), key=row.aggregate_id)
                await db.mark_sent("${table}", row.id)

            await asyncio.gather(*(send(row) for row in rows))`, [fn, "function"])];
  }
  throw new Error(v);
}

const orPy: Family = {
  id: "or-py",
  predicate: "ordering",
  language: "python",
  subject: "events.outbox-relay",
  scope: "service:outbox",
  anchor: "relay_events",
  values: ALL,
  sibValues: ALL,
  baseline: "fifo",
  mech: {
    fifo: "relay_events publishes the batch (fetched by id) one row at a time",
    "per-key-fifo": "relay_events splits the batch into lists by aggregate_id and drains the lists concurrently, each in turn",
    unordered: "relay_events publishes every row of the batch concurrently with asyncio.gather",
  },
  traps: [
    {
      name: "gather-fetch", value: "fifo", premise: "fifo",
      before: { s: "fifo", sib: "fifo" }, after: { s: "fifo", sib: "fifo", trap: "gather-fetch" },
      why: "asyncio.gather is added, but only to render payloads; publishing is a sequential loop over the rows in their fetched order: fifo.",
    },
  ],
  render({ s, sib, trap }) {
    return [{
      path: "outbox/relay.py",
      blocks: [
        b("import asyncio\nfrom collections import defaultdict\n\nfrom outbox.db import db\nfrom outbox.render import render\nfrom outbox.transport import publish"),
        ...pyOrder("relay_events", "event_outbox", s, trap),
        ...pyOrder("relay_emails", "email_outbox", sib),
      ],
    }];
  },
};

// ---------- HCL: Pub/Sub subscriptions ----------
function sub(name: string, topic: string, v: string): Block {
  return b(code`
    resource "google_pubsub_subscription" "${name}" {
      name                    = "${name.replaceAll("_", "-")}"
      topic                   = google_pubsub_topic.${topic}.id
      ack_deadline_seconds    = 30
      enable_message_ordering = ${v === "per-key-fifo" ? "true" : "false"}
    }`, [`google_pubsub_subscription.${name}`, "resource"]);
}

const orHcl: Family = {
  id: "or-hcl",
  predicate: "ordering",
  language: "hcl",
  subject: "billing.invoice-events-consumer",
  scope: "infra:pubsub",
  anchor: "google_pubsub_subscription.invoice_events",
  values: ["per-key-fifo", "unordered"],
  sibValues: ["per-key-fifo", "unordered"],
  baseline: "unordered",
  mech: {
    "per-key-fifo": "enable_message_ordering = true: Pub/Sub delivers in order per ordering key only",
    unordered: "enable_message_ordering = false: Pub/Sub gives no delivery order",
  },
  render({ s, sib }) {
    return [{ path: "infra/pubsub.tf", blocks: [sub("invoice_events", "invoices", s), sub("usage_export", "usage", sib)] }];
  },
};

// ---------- C: log writer threads ----------
const orC: Family = {
  id: "or-c",
  predicate: "ordering",
  language: "c",
  subject: "logd.write-path",
  scope: "daemon:logd",
  anchor: "writers_start",
  values: ["fifo", "unordered"],
  sibValues: [],
  baseline: "fifo",
  mech: {
    fifo: "writers_start creates one writer thread consuming the queue",
    unordered: "writers_start creates 4 writer threads consuming the same queue",
  },
  render({ s }) {
    const one = code`
      int writers_start(struct queue *q)
      {
          return pthread_create(&writer_threads[0], NULL, writer_main, q);
      }`;
    const four = code`
      int writers_start(struct queue *q)
      {
          for (int i = 0; i < 4; i++) {
              int rc = pthread_create(&writer_threads[i], NULL, writer_main, q);
              if (rc != 0)
                  return rc;
          }
          return 0;
      }`;
    return [{
      path: "src/writers.c",
      blocks: [
        b('#include <pthread.h>\n\n#include "queue.h"\n#include "sink.h"\n\nstatic pthread_t writer_threads[4];'),
        b(code`
          static void *writer_main(void *arg)
          {
              struct queue *q = arg;
              struct record *r;
              while ((r = queue_pop(q)) != NULL) {
                  sink_append(r);
                  record_free(r);
              }
              return NULL;
          }`, ["writer_main", "function"]),
        b(s === "fifo" ? one : four, ["writers_start", "function"]),
      ],
    }];
  },
};

export const ORDERING: Family[] = [orTs, orGo, orPy, orHcl, orC];
