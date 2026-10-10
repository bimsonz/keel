// Burst of smart-HTTP ref advertisements against one repo, to see where the
// per-repo git request limit bites and what a rejection looks like.
// usage: REMOTE=<repo remote> TOKEN=<token> node scripts/git-burst.mjs <count> <concurrency>
const [count = "2500", conc = "128"] = process.argv.slice(2);
const remote = process.env.REMOTE;
const token = process.env.TOKEN;
if (!remote || !token) throw new Error("REMOTE and TOKEN must be set");
const n = Number(count);
const statuses = {};
const firstAt = {};
const samples = {};
let next = 0;
const t0 = Date.now();
async function worker() {
  while (next < n) {
    next++;
    let key;
    try {
      const res = await fetch(`${remote}/info/refs?service=git-upload-pack`, {
        headers: { Authorization: `Bearer ${token}`, "User-Agent": "git/2.50.0" },
      });
      const body = await res.text();
      key = String(res.status);
      if (!samples[key] && res.status !== 200) {
        samples[key] = {
          body: body.slice(0, 300),
          headers: Object.fromEntries([...res.headers].filter(([k]) => /retry|rate|limit|content-type/i.test(k))),
        };
      }
    } catch (e) {
      key = `error:${String(e.cause?.code ?? e.message).slice(0, 60)}`;
    }
    statuses[key] = (statuses[key] ?? 0) + 1;
    firstAt[key] ??= Date.now() - t0;
  }
}
await Promise.all(Array.from({ length: Number(conc) }, worker));
const wallMs = Date.now() - t0;
console.log(JSON.stringify({ n, conc: Number(conc), wallMs, perSecond: Math.round((n / wallMs) * 1000), statuses, firstAtMs: firstAt, samples }, null, 1));
