// Lease-expiry and nack probes, through the Worker's /k2 pass-through (the consume
// token stays a Worker secret). Probe records come from a dedicated producer DO
// (p-probe) onto subscriptions created at `latest`, so each probe sees only its own
// records.
//
//   node scripts/lease.ts --phase nack     # nack, same-worker re-request, ack/extend by another worker
//   node scripts/lease.ts --phase expiry   # pull without acking, then poll until redelivery
//
// Writes results/lease-<phase>.json (IDs aliased by lib.save).
import { arg, call, redact, save, sleep } from "./lib.ts";

type Rec = { timestamp_ms: number; content: string };
type Resp = {
  success: boolean;
  result: { batch_id: string | null; leased_until_ms: number | null; records: Rec[] } | Record<string, unknown> | null;
  errors: { code: number; message: string }[];
};
type Batch = { batch_id: string | null; leased_until_ms: number | null; records: Rec[] };

const phase = arg("phase");
const log: Record<string, unknown>[] = [];
const step = (label: string, extra: Record<string, unknown>) => {
  const e = { t: Date.now(), label, ...extra };
  log.push(e);
  console.error(redact(JSON.stringify(e)));
};

const idsOf = (b: Batch | null) => (b?.records ?? []).map((x) => (JSON.parse(Buffer.from(x.content, "base64").toString()) as { id: string }).id);

async function createSub(name: string) {
  const r = await call<Resp>("/k2/subscriptions", { body: { name, start_at: { type: "latest" } } });
  if (r.status !== 200) throw new Error(`create ${r.status} ${JSON.stringify(r.body)}`);
  return (r.body.result as { id: string }).id;
}
async function consume(sub: string, worker: string, max: number) {
  const r = await call<Resp>(`/k2/subscriptions/${sub}/consume`, { body: { worker_id: worker, max_records: max } });
  const b = r.body.result as Batch | null;
  return { status: r.status, batch: b, ids: idsOf(b), errors: r.body.errors, k2Ms: Number(r.headers.get("x-k2-ms")) };
}
async function op(sub: string, batch: string, what: "ack" | "nack" | "extend", worker: string) {
  const r = await call<Resp>(`/k2/subscriptions/${sub}/batches/${batch}/${what}`, { body: { worker_id: worker } });
  return { status: r.status, success: r.body.success, result: r.body.result, errors: r.body.errors, k2Ms: Number(r.headers.get("x-k2-ms")) };
}
async function probe(run: string, count: number) {
  const r = await call<{ records: number; errors: unknown[] }>("/produce?producer=p-probe", { body: { run, mode: "single", count, ns: "p-probe", lanes: 1 } });
  if (r.status !== 200 || r.body.records !== count) throw new Error(`probe produce ${r.status}`);
}

if (phase === "nack") {
  const sub = await createSub("keel-spike-05-nack");
  step("subscription created (latest)", { sub });
  await probe("nack", 3);
  step("produced 3 probe records", {});

  const c1 = await consume(sub, "w1", 1);
  step("w1 consume max_records=1", { status: c1.status, batch: c1.batch?.batch_id, leased_until_ms: c1.batch?.leased_until_ms, ids: c1.ids });
  const c1b = await consume(sub, "w1", 1);
  step("w1 consume again while holding the lease", {
    status: c1b.status,
    batch: c1b.batch?.batch_id,
    sameBatch: c1b.batch?.batch_id === c1.batch?.batch_id,
    leaseRefreshedByMs: (c1b.batch?.leased_until_ms ?? 0) - (c1.batch?.leased_until_ms ?? 0),
    ids: c1b.ids,
  });
  const c2 = await consume(sub, "w2", 10);
  step("w2 consume max_records=10 while w1 holds its batch", { status: c2.status, batch: c2.batch?.batch_id, ids: c2.ids });

  const n1 = await op(sub, c1.batch!.batch_id!, "nack", "w1");
  const tNack = Date.now();
  step("w1 nack its 1-record batch", n1);
  const c3 = await consume(sub, "w3", 10);
  step("w3 consume after the nack", {
    status: c3.status,
    batch: c3.batch?.batch_id,
    newBatchId: c3.batch?.batch_id !== c1.batch?.batch_id,
    ids: c3.ids,
    redeliveredNackedRecord: c3.ids.includes(c1.ids[0]!),
    msAfterNack: Date.now() - tNack,
  });
  if (c3.batch?.batch_id) step("w3 ack", await op(sub, c3.batch.batch_id, "ack", "w3"));
  if (c2.batch?.batch_id) step("w2 ack", await op(sub, c2.batch.batch_id, "ack", "w2"));

  // ack and extend from a worker that does not hold the lease
  await probe("nack-intruder", 1);
  const c4 = await consume(sub, "w4", 10);
  step("w4 consume", { status: c4.status, batch: c4.batch?.batch_id, ids: c4.ids });
  step("extend by a worker that does not hold the lease", await op(sub, c4.batch!.batch_id!, "extend", "intruder"));
  step("extend by the lease holder", await op(sub, c4.batch!.batch_id!, "extend", "w4"));
  step("ack by a worker that does not hold the lease", await op(sub, c4.batch!.batch_id!, "ack", "intruder"));
  const c4b = await consume(sub, "w4", 10);
  step("w4 consume after the intruder's ack", { status: c4b.status, batch: c4b.batch?.batch_id, sameBatch: c4b.batch?.batch_id === c4.batch?.batch_id, ids: c4b.ids });
  if (c4b.batch?.batch_id) step("w4 ack", await op(sub, c4b.batch.batch_id, "ack", "w4"));
  step("ack of an unknown batch id", await op(sub, "0".repeat(32), "ack", "w4"));
  const c5 = await consume(sub, "w5", 10);
  step("final consume", { status: c5.status, batch: c5.batch?.batch_id, ids: c5.ids });
  save("lease-nack.json", { sub, log });
}

if (phase === "expiry") {
  const sub = await createSub("keel-spike-05-lease");
  step("subscription created (latest)", { sub });
  await probe("lease", 3);
  step("produced 3 probe records", {});
  const tPull = Date.now();
  const c1 = await consume(sub, "w1", 10);
  const lease = c1.batch!.leased_until_ms!;
  step("w1 consume, then never ack", { status: c1.status, batch: c1.batch?.batch_id, ids: c1.ids, leased_until_ms: lease, leaseMsFromLocalPull: lease - tPull });
  const c2 = await consume(sub, "w2", 10);
  step("w2 consume immediately", { status: c2.status, batch: c2.batch?.batch_id, ids: c2.ids });

  await sleep(Math.max(0, lease - Date.now() - 15_000));
  let polls = 0;
  let red: Awaited<ReturnType<typeof consume>> | undefined;
  while (Date.now() < lease + 180_000) {
    polls++;
    const c = await consume(sub, "w2", 10);
    if (c.ids.length) {
      red = c;
      break;
    }
    await sleep(1000);
  }
  const tRed = Date.now();
  step("w2 sees the records again", {
    polls,
    batch: red?.batch?.batch_id,
    newBatchId: red?.batch?.batch_id !== c1.batch?.batch_id,
    ids: red?.ids ?? [],
    sameRecords: JSON.stringify(red?.ids) === JSON.stringify(c1.ids),
    msAfterLeasedUntil: tRed - lease,
    msAfterOriginalPull: tRed - tPull,
  });
  step("late ack by w1 of the expired batch", await op(sub, c1.batch!.batch_id!, "ack", "w1"));
  const c3 = await consume(sub, "w2", 10);
  step("w2 consume after w1's late ack", { batch: c3.batch?.batch_id, sameAsRedelivered: c3.batch?.batch_id === red?.batch?.batch_id, ids: c3.ids });
  if (red?.batch?.batch_id) step("w2 ack", await op(sub, red.batch.batch_id, "ack", "w2"));
  const c4 = await consume(sub, "w3", 10);
  step("final consume", { batch: c4.batch?.batch_id, ids: c4.ids });
  save("lease-expiry.json", { sub, log });
}
