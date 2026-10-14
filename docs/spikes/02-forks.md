# S2: Forks as per-change repos

**Date:** 2026-10-10. **Code:** [`spikes/02-forks/`](../../spikes/02-forks/). **Raw results:** [`spikes/02-forks/results/`](../../spikes/02-forks/results/) (one JSON line per fork; `summary.md` is the table below).

## Question

Keel gives every change its own throwaway Artifacts repo, forked from a shard mirror. Can a fork be the per-change repo?

- How long until a fork is ready, at 1, 50 and 300 MB?
- Do 20 and 100 concurrent forks of one source work, or are they serialised?
- Which namespace does a fork land in, and where does `info().source` point?
- Is a fork a copy-on-write reference or a full copy?
- How late is the `repo.forked` event?

**Pass:** ready p95 ≤ 5 s at 50 MB, and ≥ 20 concurrent forks per source.

## Answer

- **Concurrency: passes, with room to spare.**
  - 100 concurrent forks of one source all succeeded: 100/100 at 1 MB in both placements, and 100/100 at 50 MB.
  - There were no errors, no `FORK_IN_PROGRESS` on the source and no rate limiting.
  - **Forks are not serialised.** 100 forks of 50 MB finished 8.7 s after the first started. Done one at a time, they would take about 100 × 4.6 s.
- **Time to ready at 50 MB: fails.**
  - Pooled over 160 forks of 50 MB: **p50 4.5 s, p95 7.2 s**, max 11.5 s.
  - Single forks placed in SEA reached p95 6.7 s. 20 concurrent forks reached p95 5.9 s.
  - At 1 MB, p95 is 3.9 s (260 forks), so small repos would pass.
- **Fork time grows with repo size:** 1 MB takes 2.9 s p50, 50 MB takes 4.5 s p50, and 300 MB takes 12–62 s (n = 3).
  - A fork also survives deletion of its parent and of the root source, with every blob readable.
  - Copy semantics cannot be observed directly: no API exposes size or object count. **Treat a fork as a full copy for storage.**
- **Placement:** forks land in the source's namespace, and there is no way to target another.
  - `info().source` is `artifacts:<namespace>/<parent>`, and it still names the parent after the parent is deleted.
- **`repo.forked` event: untested.** No event was ever observed.
  - Creating the account-level subscription was refused, because the account already has one on that source.
  - A `triggers.events` rule on `cf.artifacts.repo.forked` deployed cleanly but started **0** Workflow instances over about 450 forks in 20 minutes.
- **Go/no-go: GO for forks as per-change repos, through a warm pool** (the planned "slow → keep a pool" fallback), plus TTL garbage collection. **NO-GO for an on-demand fork on the critical path of a 50 MB shard** if the 5 s p95 is a hard budget.

## Pool sizing inputs

A pre-forked workspace pool is now the only workspace strategy. These are the inputs for sizing it, all taken from the runs below.

**Single fork, one at a time (n = 10 per cell).** Times are in ms from `fork()` call start. "Ready" means `get()` succeeds and `readCommit(head)` resolves.

| Size | Placement (colo) | `fork()` resolves p50 / p95 / max | ready p50 / p95 / max |
|---|---|---|---|
| 1 MB | default (Worker ran in **LHR**) | 3315 / 3772 / 3772 | 3024 / 3459 / 3459 |
| 1 MB | `aws:us-west-2` (entry LHR, `cf-placement: remote-SEA`) | 2806 / 4161 / 4161 | 2934 / 4218 / 4218 |
| 50 MB | default (**LHR**) | 5242 / 11831 / 11831 | 4804 / 11504 / 11504 |
| 50 MB | `aws:us-west-2` (**remote-SEA**) | 4648 / 6811 / 6811 | 4071 / 6691 / 6691 |
| 300 MB | `aws:us-west-2` (**remote-SEA**), n = 3 | 12761, 27330, 60138 | 12369, 32014, 62454 |

**Concurrent forks of one source, one fork per request, all started within 0.15–1.1 s of each other:**

| Concurrency | Size / placement | Result | Error text | Serialised? |
|---|---|---|---|---|
| 20 | 1 MB, default and placed | 20/20 and 20/20; ready p95 3.6 s and 3.0 s | none | **No.** The last fork was ready 4.2 s and 3.2 s after the first started. |
| 20 | 50 MB, default and placed | 20/20 and 20/20; ready p95 6.5 s and 5.9 s | none | **No.** 7.5 s and 7.2 s in total. |
| 100 | 1 MB, default and placed | 100/100 and 100/100; ready p95 3.9 s both | none | **No.** 7.6 s and 5.4 s in total. |
| 100 | 50 MB, placed | 100/100; ready p95 7.2 s, max 8.6 s | none | **No.** 8.7 s in total, against about 460 s if serialised. |
| 20 in one request (`Promise.all`) | 1 MB, placed | 20/20 | none | **No.** 4.8 s in total. |

- Throttling was never reached: there was no error, no rate limit and no `FORK_IN_PROGRESS` thrown by `fork()` on the source at 100 concurrent.
- Total time does not scale with count. 100 concurrent forks take about 1–2 single-fork times.
- The only per-fork cost that grows is the p95 tail: 50 MB went from 5.9 s at 20 concurrent to 7.2 s at 100.

**`repo.forked` event arrival latency: untested.**

- The account-level subscription was refused with: `We currently do not support multiple subscriptions on the same resource.` The account already holds the one subscription on the `artifacts` source.
- A `triggers.events` rule on `cf.artifacts.repo.forked` deployed but started 0 Workflow instances over about 450 forks.
- So a pool cannot be refilled on a fork event. Refill on `await fork()` instead.

**Other sizing facts:**

- **Use `await fork()` as the ready signal.** The first check after `fork()` resolved was ready in 4/4 runs.
- **Polling while a fork is in flight costs about 1–1.9 s per `get()`**, because the service blocks before throwing `FORK_IN_PROGRESS`.
- **A pool member's name can never be reused.** A deleted name is tombstoned for about 60 s (`ALREADY_EXISTS`).
- **`delete()` takes about 1.5–2 s.**
- **Namespace region and first use.**
  - `keel-spike-02` was first used at **2026-10-10T18:49:08Z, from a London client**, via `wrangler artifacts repos create` (REST).
  - From this namespace, `get()` + `log()` on a source took **262 ms p50 from LHR and 330 ms p50 from SEA** (n = 161 and 267).
  - S12's namespace, used from the same London client, measured `get()` at 177 ms from LHR and 33 ms from SEA.
  - So this namespace is **not** near US West. This fits placement following first use, but it is an inference from latency, not documented.
  - Placement gave forks little: they are server-bound.
- **Other spikes, for comparison:**
  - S1/S3 measured one fork at 3.4 s, ready on the first `get()`.
  - S12 measured 3.8–5 s.
  - Both agree with the 1 MB rows above.
- **`defaultBranchOnly`: not exercised here.** Every source had only `main`. Another spike found that `defaultBranchOnly: true` still copied every branch, so size a pool member as the whole mirror, not one branch.

## Setup

| Item | Value |
|---|---|
| Worker | `keel-spike-02-forker` (default placement; ran in **LHR**, sometimes **CDG**, from `request.cf.colo`) |
| Placed Worker | `keel-spike-02-forker-placed`, same code, `"placement": { "mode": "targeted", "region": "aws:us-west-2" }`. Every response carried `cf-placement: remote-SEA`. |
| Binding | `"artifacts": [{ "binding": "ARTIFACTS", "namespace": "keel-spike-02" }]`, confirmed with `wrangler types` (`ARTIFACTS: Artifacts`) |
| Tooling | wrangler 4.149.0 (devDependency), pnpm, `pnpm install --ignore-workspace`, TypeScript 7 `tsc --noEmit` clean, `oxlint -c oxlint.config.json` clean |
| Sources | Built by `scripts/make-source.sh` from `/dev/urandom` (incompressible) and pushed with local git and a Bearer header (`scripts/push-source.sh`). `src-1m`: 1 commit, 65 blobs, 1.0 MB. `src-50m`: 2 commits × 25 MB. `src-300m`: 12 commits × 25 MB, deleted right after its 3 forks. |
| Fork driver | `scripts/run-forks.ts` sends one fork per HTTP request (one change = one request), with `conc` requests in flight. The Worker forks, measures, then **deletes the fork straight away** (`del=1`). |
| In-Worker fan-out | `/bulk` runs N forks from inside a single request (`results/bulk20-1m-sea.json`) |
| Events | D1 `keel-spike-02-log` and Queue `keel-spike-02-events` for the subscription attempt, plus Workflow `keel-spike-02-forked-wf` for the trigger attempt |

### What one fork measurement does (`POST /fork`)

1. `get(src)`, then `log({ limit: 1 })` for the source head. This is excluded from the timing.
2. Set `t0` and call `srcRepo.fork(name)`, without awaiting it.
3. **At the same moment**, start polling readiness ([`src/ready.ts`](../../spikes/02-forks/src/ready.ts)):
   - `get(name)` must not throw, **and** `readCommit(head)` must resolve to a commit whose hash is `head`;
   - poll again 150–250 ms after each attempt ends;
   - every attempt's outcome is recorded.
4. `readyMs` is the end of the first ready attempt, and `forkReturnedMs` is when `fork()` resolved. Both are measured from `t0`.
5. `info()` of the fork, then `delete(name)` (timed).

Polling starts with the `fork()` call rather than after it, so the first attempt also shows what a reader sees while a fork is in flight.

## Numbers

Percentiles are nearest-rank, and times are in ms, measured inside the Worker with `Date.now()`. "Span" runs from the first `fork()` call to the last fork observed ready. "Slope" is the least-squares slope of sorted ready times against rank: about one fork's time per rank if forks are serialised, and near 0 if they run in parallel.

### Per run (`results/summary.md`, `node scripts/summarise.ts`)

| run | n | ok | colo / placement | fork() p50 / p95 / max | ready p50 / p95 / max | span | slope ms/rank | delete p50 |
|---|---|---|---|---|---|---|---|---|
| single-1m-lhr | 10 | 10 | LHR / default | 3315 / 3772 / 3772 | 3024 / 3459 / 3459 | 48891 (sequential) | 5198 | 1806 |
| single-1m-sea | 10 | 10 | LHR / remote-SEA | 2806 / 4161 / 4161 | 2934 / 4218 / 4218 | 51492 (sequential) | 5393 | 1520 |
| single-50m-lhr | 10 | 10 | LHR / default | 5242 / 11831 / 11831 | 4804 / 11504 / 11504 | 70682 (sequential) | 6498 | 1576 |
| single-50m-sea | 10 | 10 | LHR / remote-SEA | 4648 / 6811 / 6811 | 4071 / 6691 / 6691 | 68517 (sequential) | 7299 | 1460 |
| single-300m-sea | 3 | 3 | LHR / remote-SEA | 27330 / 60138 / 60138 | 32014 / 62454 / 62454 | 113460 (sequential) | 25503 | 1849 |
| **conc20-1m-lhr** | 20 | 20 | LHR / default | 3144 / 3704 / 3707 | 3079 / 3649 / 3766 | **4216** | **121** | 1761 |
| **conc20-1m-sea** | 20 | 20 | LHR / remote-SEA | 2132 / 3192 / 3468 | 1965 / 3012 / 3086 | **3226** | **103** | 1599 |
| **conc20-50m-lhr** | 20 | 20 | CDG,LHR / default | 4811 / 6868 / 7422 | 4531 / 6467 / 7187 | **7471** | **192** | 2005 |
| **conc20-50m-sea** | 20 | 20 | LHR,CDG / remote-SEA | 4604 / 6079 / 7103 | 4397 / 5879 / 7176 | **7206** | **147** | 1455 |
| **conc100-1m-lhr** | 100 | 100 | LHR,CDG / default | 3243 / 4238 / 6549 | 2933 / 3945 / 7191 | **7591** | **34** | 1994 |
| **conc100-1m-sea** | 100 | 100 | CDG,LHR / remote-SEA | 2832 / 4080 / 4562 | 2694 / 3867 / 4393 | **5425** | **31** | 1594 |
| **conc100-50m-sea** | 100 | 100 | LHR,CDG / remote-SEA | 4913 / 7508 / 8431 | 4613 / 7190 / 8592 | **8730** | **40** | 1585 |
| bulk20-1m-sea (one request, `Promise.all`) | 20 | 20 | CDG / remote-SEA | 2955 / 3754 / 4567 | 2838 / 3451 / 4591 | 4820 | n/a | n/a |

- The sequential rows are the control for the slope metric. With forks run one after another, the slope equals the per-fork cost (about 5–7 s including the delete), so the metric does detect serialisation.
- In the 20 and 100 concurrent runs the slope is 31–192 ms per rank, and the span is about one fork's time.
- The 100 × 50 MB run had a spread of 488 ms between the first and last `fork()` start.
- 100 × 50 MB was run placed only, to limit volume.

### Pooled by size

| Size | n | ready p50 / p95 / max | fork() p50 / p95 / max | ready ≤ 5 s | blocked `get()` → `FORK_IN_PROGRESS`, p50 / p95 |
|---|---|---|---|---|---|
| 1 MB, all | 260 | 2865 / 3880 / 7191 | 3036 / 4076 / 6549 | 256 / 260 | 1307 / 1909 |
| 1 MB, SEA | 130 | 2466 / 3867 / 4393 | 2809 / 4080 / 4562 | 130 / 130 | 1165 / 1947 |
| 1 MB, LHR | 130 | 3005 / 3943 / 7191 | 3196 / 3984 / 6549 | 126 / 130 | 1351 / 1862 |
| **50 MB, all** | 160 | **4531 / 7176 / 11504** | 4797 / 7422 / 11831 | **107 / 160** | 949 / 1659 |
| 50 MB, SEA | 130 | 4499 / 7176 / 8592 | 4688 / 7466 / 8431 | 88 / 130 | 941 / 1644 |
| 50 MB, LHR | 30 | 4541 / 7187 / 11504 | 4842 / 7422 / 11831 | 19 / 30 | 1129 / 1716 |
| 300 MB, SEA | 3 | 32014 / 62454 / 62454 (12369, 32014, 62454) | 12761, 27330, 60138 | 0 / 3 | — |

- **Placement barely matters for forks.** The work is server-side; placement saves roughly 0.3–0.5 s at 1 MB and nothing measurable at 50 MB.
- **Readiness resolution is about 1 s, set by the service, not by the poll interval.** A `get()` on a fork still in flight does not fail fast: it blocks for **~1.0–1.9 s** before throwing `FORK_IN_PROGRESS`, from either placement. The S12 spike measured an ordinary `get()` at 33 ms placed. Readiness is therefore observed up to one blocked `get()` late.
- **`fork()` resolves at about the moment the fork becomes readable.**
  - In 372 of 428 measured forks, the first ready check finished before `fork()` resolved.
  - In all 4 can-fail runs, the first check issued after `fork()` resolved found the fork ready.
  - In practice, `await fork()` is the readiness signal, and the `get()` + `readCommit` check confirms it.

### Namespace placement and `info()`

| Probe | Result (`results/xns-probe.jsonl`) |
|---|---|
| `fork("xns-probe-1", { namespace: "keel-spike-06" })` (field not in the typed API) | The field is ignored. The fork landed in **`keel-spike-02`**: its remote is `https://<acct>.artifacts.cloudflare.net/git/keel-spike-02/xns-probe-1.git`, and `keel-spike-06` did not list it. |
| `fork("keel-spike-06/xns-probe-2")` | `INVALID_REPO_NAME` |
| `info().source` of a fork | `artifacts:keel-spike-02/src-1m` |
| `info().source` of a fork of a fork | `artifacts:keel-spike-02/xns-probe-1`, the immediate parent, not the root |
| `info().source` after the parent is deleted | Unchanged: it still names the deleted parent, as a dangling reference |

The REST fork endpoint (`POST …/namespaces/:namespace/repos/:name/fork`) has no target-namespace field either. The `repo.forked` event schema carries a `payload.namespace`, which suggests cross-namespace forks may come later. **A shard mirror and its change repos must share a namespace.**

### Storage: copy-on-write or full copy?

| Observable | Result |
|---|---|
| `fork()` result fields (binding) | `id, name, description, defaultBranch, remote, token`. **No `objects` count**, in 429 of 429 results. |
| REST `objects` count (fork response per the docs) | **Untested.** The REST call needs the OAuth token outside wrangler, and the token was not read out of wrangler (`wrangler auth token`) for this run. `wrangler artifacts` has no fork command. |
| REST repo info (`wrangler artifacts repos get src-50m --json`) | `id, name, description, default_branch, created_at, updated_at, last_push_at, source, read_only, remote`. **No size or object fields.** `last_push_at` was `null` even after two git pushes. |
| Namespace info (`wrangler artifacts namespaces get`) | `repo_count` only |
| Fork time against size | 1 MB 2.9 s, 50 MB 4.5 s, 300 MB 12–62 s (p50s). **Fork time grows with content.** The 300 MB source also has more commits (12 against 2), so bytes and object count are confounded. |
| Child after its parent is deleted (`results/cow-probe.jsonl`) | Fork `fof-1` of fork `xns-probe-1`, then `xns-probe-1` deleted: `/verify fof-1` read **3 trees, 65 blobs, 1048603 bytes, 0 missing** |
| Fork after the root source is deleted | `root-probe` forked from `src-1m`, then `src-1m` deleted: `/verify root-probe` read **65 blobs, 1048603 bytes, 0 missing** |

**Conclusion (inference, not documented):**

- Fork time grows with content, which fits forks that copy or rewrite objects.
- Children survive deletion of their ancestors, which fits a full copy or a ref-counted store.
- Nothing visible would justify treating forks as free.
- **Plan storage as a full copy per fork.** That means deleting at change end, a TTL sweep, and never keeping forks of large shards idle in quantity.

### `repo.forked` event latency: untested

| Attempt | Result |
|---|---|
| Account-level Queue subscription (`wrangler queues subscription create keel-spike-02-events --source artifacts --events repo.forked,repo.created,repo.deleted`) | **Refused:** `We currently do not support multiple subscriptions on the same resource.` The account already has a subscription on the account-level `artifacts` source, which was left alone. |
| `triggers.events` rule `{ "type": "cf.artifacts.repo.forked", "filter": { "namespace": "keel-spike-02" }, "targets": [{ "type": "workflow", "workflow_name": "keel-spike-02-forked-wf" }] }` | Deployed as `event triggers: 1`. **0 Workflow instances** (`wrangler workflows instances list` was empty, and D1 `events` had 0 rows) over about 450 forks from 18:54 to 19:15 UTC. |
| The same rule with no `filter` | Deployed. 0 instances for 2 more forks after 90 s. |

Note: `wrangler queues subscription create` was expected not to support Artifacts sources. **wrangler 4.149.0 does:** `--source artifacts`, or `--source artifacts.repo --source-namespace … --source-repo-name …`. S6 used the per-repo form successfully.

### Commands and captured output (trimmed, redacted)

**Seed.** One 100 MB pack was refused, so the sources are pushed one commit (≤ 25 MB) per push.

```console
$ scripts/make-source.sh <scratch>/src-300m 300 3        # first attempt: 3 commits × 100 MB
$ scripts/push-source.sh <scratch>/src-300m <scratch>/src-300m.json
error: remote unpack failed: receive-pack request exceeds maximum size
 ! [remote rejected] 6cc7732… -> main (receive-pack request exceeds maximum size)
$ scripts/make-source.sh <scratch>/src-300m 300 12       # 12 commits × 25 MB
head: a8f0732228899a2fe2b621b1e4b79b3ef3805693  commits: 12  size: 303M
pushed 84768e78… in 3.3 s
…
pushed a8f07322… in 2.9 s
```

Bracketing the limit on a throwaway repo (`packsize-probe`): a single **50 MB** push was accepted (`pushed 74f708ba… in 8.3 s`), and a following **75 MB** push was rejected with the same `receive-pack request exceeds maximum size`. **The receive-pack limit is between 50 and 75 MB per push.**

**One fork, start to finish** (`results/smoke.jsonl`, LHR):

```json
{"colo":"LHR","name":"smoke6t2l-0","t0":1791658462491,"forkReturnedMs":3791,"readyMs":3618,
 "attempts":[{"at":0,"ms":412,"reason":"get:NOT_FOUND"},
             {"at":562,"ms":1302,"reason":"get:FORK_IN_PROGRESS"},
             {"at":2014,"ms":1604,"reason":"READY"}],
 "forkResult":{"id":"q2f267fon4lk3ghi","name":"smoke6t2l-0","description":null,"defaultBranch":"main",
               "remote":"https://<acct>.artifacts.cloudflare.net/git/keel-spike-02/smoke6t2l-0.git","token":"<token>"},
 "info":{"source":"artifacts:keel-spike-02/src-1m","defaultBranch":"main","readOnly":false},
 "del":{"deleted":true,"deleteMs":2213}}
```

**100 concurrent forks of 50 MB** (`WORKER_URL=<placed> node scripts/run-forks.ts conc100-50m-sea src-50m 100 100 250 1`):

```json
{"run":"conc100-50m-sea","n":100,"conc":100,"ok":100,"errors":[],"colo":["LHR","CDG"],"placement":["remote-SEA"],
 "forkCall":{"p50":4913,"p95":7508,"max":8431},"ready":{"p50":4613,"p95":7190,"max":8592},
 "spanFirstForkToLastReadyMs":8730,"startSpreadMs":488,
 "reasons":{"get:NOT_FOUND":29,"get:FORK_IN_PROGRESS":283,"READY":100},"deleted":100}
```

**Namespace emptied** after the runs:

```console
$ curl -X POST -H "x-spike-key: …" <placed>/list
{"colo":"CDG","total":0,"repos":[]}
$ wrangler artifacts repos list --namespace keel-spike-02
No Artifacts repos found in namespace "keel-spike-02".
```

## Pass/fail

| Criterion | Result | Evidence |
|---|---|---|
| Ready p95 ≤ 5 s at 50 MB | **FAIL** | p95 7.2 s pooled (n = 160). Best run: 5.9 s (20 concurrent, placed). Worst: 11.5 s (single, LHR). 107 of 160 forks were ready within 5 s. |
| ≥ 20 concurrent forks per source | **PASS** | 20 and 100 concurrent forks: 100/100 at 50 MB and 2 × 100/100 at 1 MB, with 0 errors. Not serialised (slope 31–192 ms per rank against 5–7 s sequential). |
| 1 MB and 300 MB time to ready (measure only) | Measured | 1 MB p95 3.9 s. 300 MB: 12.4, 32.0 and 62.5 s. |
| Namespace placement | Measured | Same namespace as the source only. `info().source` is the immediate parent. |
| `objects` against the source | **Untested** | No binding or `wrangler` surface exposes it. The REST call was not made (see above). |
| `repo.forked` event latency | **Untested** | The subscription was refused, and the trigger fired 0 times. |

## Go / no-go

**GO for one fork per change, on these conditions:**

1. **Take change repos from a warm pool, not an on-demand fork, whenever the shard is large.**
   - At 50 MB an on-demand fork misses the 5 s p95 by about 2 s, and it gets worse with size (300 MB: 12–62 s).
   - Forks run fully in parallel (100 concurrent per source, with no errors), so a pool refills quickly. Pool size follows the expected change rate multiplied by about 5–8 s of refill time.
   - A small shard (≤ ~1 MB at the time of measurement) can fork on demand: p95 3.9 s.
2. **Treat `await fork()` as ready, and confirm with `get()` + `readCommit(head)` before handing the repo out.**
   - Never poll `get()` in a tight loop: each in-flight `get()` blocks for about 1–2 s server-side.
3. **Budget storage as a full copy per fork.**
   - Delete each change repo when the change ends, and run a TTL sweep for leaks.
   - Use unique, never-reused names (see the name tombstone below).
4. **Shard mirror and change repos share one namespace.** Size namespaces with that in mind: the limit is 2,000 control-plane requests per 10 s per namespace.

**NO-GO** for forking on demand on the critical path of a large shard under a hard 5 s p95.

## Fallback

The planned fallbacks, in light of the results:

| Planned fallback | Trigger | Taken? |
|---|---|---|
| slow → keep a pool | p95 > 5 s at 50 MB | **Taken.** A pre-forked pool per shard mirror, refilled in parallel. |
| serialised → fork tree via mirrors | concurrency failure | **Not needed.** Forks are not serialised. A fork of a fork works anyway (4.3 s at 1 MB), and its `info().source` names the immediate parent. |
| full copies → TTL GC + empty-repo shallow push | copy semantics | **TTL GC taken** as the conservative storage plan. The empty-repo + shallow-push alternative was **not run** (untested). It is bounded by the 50–75 MB receive-pack limit, so a large shard's tree would need several pushes. |

## Can-fail demonstrations

1. **The readiness check reports "not ready" for a fork in flight.**
   - In every one of 448 forks (428 driver runs + 20 `/bulk`), the attempt issued together with `fork()` returned not ready: `get:FORK_IN_PROGRESS` in 356 + 13 cases and `get:NOT_FOUND` in 72 + 7.
   - `/canfail` runs `checkReady` while `fork()` is in flight, then right after it resolves, then with a wrong head, then after deleting (`results/canfail.jsonl`):

     ```text
     src-1m  during@866ms {ready:false, reason:get:FORK_IN_PROGRESS}  fork {ok:true, ms:2117}  rightAfter {ready:true}
             wrongHead {ready:false, reason:readCommit:null}  afterDelete {ready:false, reason:get:NOT_FOUND}
     src-50m during@816ms {ready:false, reason:get:FORK_IN_PROGRESS}  fork {ok:true, ms:4048}  rightAfter {ready:true}
             wrongHead {ready:false, reason:readCommit:null}  afterDelete {ready:false, reason:get:NOT_FOUND}
     src-50m during@20ms  {ready:false, reason:get:NOT_FOUND}         fork {ok:true, ms:3788}  rightAfter {ready:true} …
     ```

2. **The `readCommit` leg on its own fails when it should** (`results/canfail-static.jsonl`):

   | Check | Result |
   |---|---|
   | Empty repo (`create`, no push) with `src-1m`'s head | `ready:false, reason:readCommit:null` |
   | `src-50m` checked for `src-1m`'s head (repo exists, commit absent) | `ready:false, reason:readCommit:null` |
   | Name never created | `ready:false, reason:get:NOT_FOUND` |
   | Control: `src-1m` checked for its own head | `ready:true` |

3. **The serialisation metric detects serialisation.** The sequential runs show a slope of 5198–7299 ms per rank, about the per-fork cost. The concurrent runs show 31–192.

## Gotchas found

- **A deleted name is tombstoned for about a minute.**
  - The `/canfail` driver accidentally reused a name about 1.3 s after `delete()` returned `true`. `fork()` to that name failed in **16 ms with `ALREADY_EXISTS`**, while `get()` returned `NOT_FOUND` and `delete()` returned `false`.
  - The name worked again on the next run, at least 60 s later (after that run's 400 polls of 150 ms, all `NOT_FOUND`).
  - Keel must never reuse a change-repo name.
- **The receive-pack limit is between 50 and 75 MB per push.** A 100 MB and a 75 MB pack were refused with `receive-pack request exceeds maximum size`, and a 50 MB pack was accepted.
- **`last_push_at` stayed `null` in REST repo info after git pushes.** Don't use it as a push clock.
- **`delete()` takes about 1.4–2.2 s** (p50 1.5–2.0 s across runs).
- **`wrangler delete` does not delete the Worker's Workflows.** `keel-spike-02-forked-wf` was still listed after its Worker was gone and had to be removed with `wrangler workflows delete`.
- **A Worker that consumes a Queue cannot be deleted** (`code: 10064`) until `wrangler queues consumer remove` has run.
- **The 6-connection limit does not throttle binding RPC.** 20 forks via `Promise.all` from one request started within 229 ms of each other and finished in 4.8 s (`results/bulk20-1m-sea.json`).

## Untested

- **The REST `objects` count** on the fork response, and any REST fork at all: the OAuth token was not read out of wrangler for this run.
- **`repo.forked` event latency.** The account-level subscription was refused, and the `triggers.events` rule never fired.
- **Empty repo + shallow push** as a fork substitute.
- **Fork of a repo with many branches** (`defaultBranchOnly: false`). Every fork here used the default, which is `true`.
- **Pushing to a fork while its source is being pushed to**, and fork isolation under concurrent writes.
- **Actual storage billed per fork.** Billing had not started when the spike ran, so it was not observable.

## Teardown

All S2 resources were deleted on 2026-10-10:

```console
$ curl … /delete?names=root-probe,fof-1,packsize-probe,src-50m        # src-300m and src-1m deleted earlier
{"out":[{"name":"root-probe","deleted":true},{"name":"fof-1","deleted":true},
        {"name":"packsize-probe","deleted":true},{"name":"src-50m","deleted":true}]}
$ wrangler artifacts repos list --namespace keel-spike-02
No Artifacts repos found in namespace "keel-spike-02".
$ wrangler deploy -c wrangler.deploy.jsonc            # with "triggers": { "events": [] }
  event triggers: 0
$ wrangler queues consumer remove keel-spike-02-events keel-spike-02-forker
Removed consumer from queue keel-spike-02-events.
$ wrangler delete --name keel-spike-02-forker --force
Successfully deleted keel-spike-02-forker
$ wrangler delete --name keel-spike-02-forker-placed --force
Successfully deleted keel-spike-02-forker-placed
$ wrangler workflows delete keel-spike-02-forked-wf
✅ Workflow "keel-spike-02-forked-wf" removed successfully.
$ wrangler queues delete keel-spike-02-events
Deleted queue keel-spike-02-events.
$ wrangler d1 delete keel-spike-02-log -y
Deleted 'keel-spike-02-log' successfully.
$ wrangler queues list | grep -c keel-spike-02 ; wrangler d1 list | grep -c keel-spike-02 ; wrangler workflows list | grep keel-spike-02
0
0
(none)
```

**Remainder:** the namespace `keel-spike-02` with **0 repos**. Wrangler cannot delete namespaces.

## Reproduce

```sh
cd spikes/02-forks && pnpm install --ignore-workspace
source <scratch>/cf.env                                   # CLOUDFLARE_ACCOUNT_ID only
scripts/make-source.sh <scratch>/src-50m 50 2
wrangler artifacts repos create src-50m --namespace keel-spike-02 --json > <scratch>/src-50m.json
scripts/push-source.sh <scratch>/src-50m <scratch>/src-50m.json
wrangler d1 create keel-spike-02-log && wrangler queues create keel-spike-02-events
D1_ID=… scripts/deploy.sh && wrangler secret put SPIKE_KEY -c wrangler.deploy.jsonc   # and -c wrangler.placed.jsonc
WORKER_URL=… SPIKE_KEY_FILE=… node scripts/run-forks.ts conc20-50m-sea src-50m 20 20 200 1
node scripts/summarise.ts
```
