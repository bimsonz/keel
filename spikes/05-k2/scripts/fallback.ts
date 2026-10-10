// Fallback comparison: the same 300-byte records through a Queue instead of K2.
//   node scripts/fallback.ts --run q1k --count 1000 --batch 1
//   node scripts/fallback.ts --stats        # consumer-side lag/order/dups from the qsink DO
import { arg, call, save } from "./lib.ts";

if (process.argv.includes("--stats")) {
  const r = await call("/queue-stats");
  save("fallback-queue-consume.json", r.body);
  console.log(JSON.stringify(r.body, null, 1));
} else {
  const run = arg("run");
  const r = await call<{ lat: number[] }>("/produce-queue", { body: { run, count: Number(arg("count")), batchSize: Number(arg("batch", "1")) } });
  if (r.status !== 200) throw new Error(`produce-queue ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  save(`fallback-produce-${run}.json`, r.body);
  const { lat: _lat, ...summary } = r.body;
  console.log(JSON.stringify(summary));
}
