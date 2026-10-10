// Activation gap of a per-repo Queue event subscription, from the `sub:<t>`
// pushes in results/pushes.jsonl, the subscription creation time in
// results/<timing file> and the events in results/events.json.
//   node scripts/sub-gap.ts sub-timing.json
import { readFileSync } from "node:fs";

type Push = { phase: string; repo: string; ref: string; after: string; localDone: number };
type Q = { recv_at: number; msg_ts: number; repo: string; ref: string; after: string; event_ts: string | null; body_type: string };
type I = { repo: string; ref: string; after: string; started_at: number };

const res = new URL("../results/", import.meta.url);
const timingFile = process.argv[2] ?? "sub-timing.json";
const timing = JSON.parse(readFileSync(new URL(timingFile, res), "utf8")) as { subCreateDone: number; queue?: string };
const offset = (JSON.parse(readFileSync(new URL("clock-end.json", res), "utf8")) as { best: { offset: number } }).best.offset;
const pushes = readFileSync(new URL("pushes.jsonl", res), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as Push)
  .filter((p) => p.phase === `sub:${timing.subCreateDone}`);
const ev = JSON.parse(readFileSync(new URL("events.json", res), "utf8")) as { instances: I[]; qevents: Q[]; fetchedAt?: number };

const rows = pushes.map((p, i) => {
  const q = ev.qevents.filter((e) => e.repo === p.repo && e.after === p.after);
  const inst = ev.instances.filter((e) => e.repo === p.repo && e.after === p.after);
  return {
    i,
    secondsAfterSubscription: Math.round((p.localDone - timing.subCreateDone) / 100) / 10,
    after: p.after.slice(0, 8),
    queueEvents: q.length,
    queueLatencyMs: q.length ? q[0].recv_at - offset - p.localDone : null,
    queueBodyType: q[0]?.body_type ?? null,
    triggerInstances: inst.length,
    triggerLatencyMs: inst.length ? inst[0].started_at - offset - p.localDone : null,
  };
});
const firstDelivered = rows.find((r) => r.queueEvents > 0);
const lastDropped = rows.filter((r) => r.queueEvents === 0 && (!firstDelivered || r.i < firstDelivered.i)).at(-1);
console.log(
  JSON.stringify(
    {
      timingFile,
      queue: timing.queue ?? "keel-spike-06-repo-q",
      repo: pushes[0]?.repo,
      subCreateDone: timing.subCreateDone,
      eventsFetchedAt: ev.fetchedAt ?? null,
      activationGapSeconds: { lastDroppedPushAt: lastDropped?.secondsAfterSubscription ?? null, firstDeliveredPushAt: firstDelivered?.secondsAfterSubscription ?? null },
      droppedBeforeActivation: rows.filter((r) => firstDelivered && r.i < firstDelivered.i && r.queueEvents === 0).length,
      lateDeliveriesOfEarlyPushes: rows.filter((r) => firstDelivered && r.i < firstDelivered.i && r.queueEvents > 0).length,
      rows,
    },
    null,
    1,
  ),
);
