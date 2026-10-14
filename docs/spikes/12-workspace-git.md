# S12: `workspace-git` for Worker-hosted clients

**Date:** 2026-10-10. **Code:** [`spikes/12-workspace-git/`](../../spikes/12-workspace-git/). **Raw results:** [`spikes/12-workspace-git/results/`](../../spikes/12-workspace-git/results/).

`workspace-git` is the client-side library used by Keel's load generator and example swarm agents running inside Workers. It is never Keel's own git path.

## Question

Can Worker-hosted clients clone, commit with trailers and push to Artifacts with isomorphic-git, within the following budget per clone + commit + push cycle?

- under 2 s wall time;
- under 500 ms CPU.

## Answer

- **Functionally: yes.**
  - 155 of the 167 recorded cycles landed with both trailers, verified server-side through `repo.log()` and `repo.readCommit()`. The other 12 were 6 deliberate auth refusals, 2 deliberate verifier mismatches (their pushes landed) and 4 non-fast-forward rejections caused by a harness bug.
  - Pushes into a brand-new empty repo work.
- **CPU: passes everywhere.** Request CPU p95 is 161–190 ms, and this covers the whole request, not just the cycle.
- **Wall time: depends on where the client Worker runs.**
  - **Default placement (LHR): fails.** The cycle takes 2204 ms p50 and 2291 ms p95.
  - **Targeted placement near the Artifacts backend (`aws:us-west-2`, which ran in SEA): passes.** The cycle takes 706 ms p50 and 955 ms p95.
  - **The wall time is four smart-HTTP round trips at about 300–700 ms each from LHR, not isomorphic-git.**
- **Go/no-go: GO, conditional on placement** (see [Go/no-go](#go--no-go)).

## Setup

| Item | Value |
|---|---|
| Client library | `src/workspace-git.ts`: isomorphic-git 1.43.2 (MIT) via `isomorphic-git/http/web`; in-memory fs in `src/memfs.ts` |
| Worker | `keel-spike-12-client`, compat date `2026-10-01`, `nodejs_compat`, bundle 593 KiB (122 KiB gzip), startup 16–17 ms |
| Probe Worker | `keel-spike-12-client-placed`: same code, `wrangler.placed.jsonc`, `placement: { mode: "targeted", region: … }` |
| Binding | `"artifacts": [{ "binding": "ARTIFACTS", "namespace": "keel-spike-12" }]`, confirmed with `wrangler types` |
| Tooling | wrangler 4.149.0 (devDependency), pnpm 11, `pnpm install --ignore-workspace`; typecheck and oxlint clean |
| Seed | `keel-spike-12/seed`: 201 files (4 directories × 50 small text files + README), built with local `git` and pushed with an `Authorization: Bearer` header (`scripts/seed.sh`) |
| Workspace | `ws-main`, forked from `seed` via `repo.fork()`. `ws=fork` mode forks a fresh `ws-<ulid>` per request instead. |
| Measurement | Phase wall times from `Date.now()` inside the Worker. CPU, wall and outcome per request from `wrangler tail --format json` (`cpuTime`, `wallTime`, `outcome`), joined to responses by a `run`/`i` query tag (`scripts/summarise.mjs`). Per-request smart-HTTP timings come from a wrapper around the http client (`timedHttp`). |
| Client location | Requests sent from London; default placement ran the Worker in **LHR** (`request.cf.colo`); the probe reported `cf-placement: remote-IAD`, then `remote-SEA` |

### What one cycle does (`POST /cycle`)

1. `env.ARTIFACTS.get(ws)`, then `await repo.info()` for the remote, then `repo.createToken('write', 600)`.
2. **Clone:** a shallow clone into memory: `depth: 1`, `singleBranch`, `noTags`, `noCheckout`.
3. **Commit:** edit 3 existing files (one each in `src/core`, `src/util`, `docs`). The library writes the blobs, rewrites only the touched trees and calls `git.commit({ tree, parent })` with no `ref` and no index or working tree. The message ends with the trailers `Change-Id: I<ulid>` and `MFP-Session: <id>`.
   - `flow=checkout` does the conventional full checkout, then `add` and `commit`, for comparison.
4. **Push:** to `main`, or to a named branch with `branch=…`. Auth goes in headers only, never in the URL.
5. **Verify:** `repo.log({ ref, limit })[0].hash === oid`, then `repo.readCommit(oid)`, parse trailers, and compare both values.

"Cycle" in the tables below is clone + commit + push. Token minting, repo lookup and verification are reported separately. Tail CPU covers the **whole request**, including those, so it is an upper bound for the cycle.

## Numbers

All numbers come from the deployed Workers on the edge. Percentiles are nearest-rank. Times are in ms.

### Cycle wall time and CPU

| Run (results file) | n | clone p50 / p95 | commit | push p50 / p95 | **cycle p50 / p95** | **request CPU p50 / p95 (max)** | memfs peak | outcomes |
|---|---|---|---|---|---|---|---|---|
| LHR, tree flow (`main-tree`) | 25 | 1071 / 1151 | 0* | 1103 / 1171 | **2204 / 2291** | **102 / 190 (215)** | 28 KB | 25 ok |
| LHR, tree flow, first run before HTTP instrumentation (`main-tree-r1`) | 25 | 1081 / 1306 | 0* | 1128 / 1267 | 2166 / 2648 | 83 / 235 (242) | 28 KB | 25 ok |
| LHR, checkout flow (`checkout`) | 10 | 961 / 1126 | 0* | 1122 / 1283 | 2068 / 2384 | 135 / 310 | 55 KB | 10 ok |
| LHR, named branch + Basic auth (`branch-basic`) | 5 | 1038 / 1528 | 0* | 1150 / 1483 | 2188 / 2975 | 207 / 407 | 28 KB | 5 ok |
| LHR, fork per request (`fork-per-cycle`) | 5 | 1021 / 1097 | 0* | 1162 / 1752 | 2220 / 2839 | 80 / 114 | 27 KB | 5 ok |
| **SEA, placed `aws:us-west-2` (`placed-sea`)** | 20 | 314 / 486 | 0* | 397 / 525 | **706 / 955** | **111 / 161 (236)** | 29 KB | 20 ok |

\* The Workers clock advances only on I/O, so pure-CPU phases read 0 ms. The commit phase (hashing, tree writes, commit write) is fully covered by tail `cpuTime`.

The fork-per-request run spent **3765 / 4245 ms** (p50 / p95) on `fork()` + `get()`.

### Warm workspace: one clone, then N commit+push cycles in one request

| Run | requests × n | warm commit+push p50 / p95 | CPU per cycle (request CPU / n) p50 / p95 |
|---|---|---|---|
| LHR (`warm-tree`) | 5 × 5 (20 warm cycles) | 1097 / 1156 | 43 / 69 |
| SEA (`placed-sea-warm`) | 4 × 5 (16 warm cycles) | 378 / 924 | 50 / 64 |

### Where the wall time goes: per smart-HTTP request (`totalMs` p50 / p95)

| Request | bytes (req → res) | LHR (`main-tree`) | SEA (`placed-sea`) |
|---|---|---|---|
| `GET info/refs?service=git-upload-pack` | 0 → 385 | 363 / 411 | 76 / 264 |
| `POST git-upload-pack` (depth 1) | 149 → ~16 000 | 709 / 779 | 213 / 402 |
| `GET info/refs?service=git-receive-pack` | 0 → 297 | 369 / 423 | 76 / 142 |
| `POST git-receive-pack` (3 blobs, 4 trees, 1 commit) | ~4 600 → 121 | 735 / 767 | 294 / 383 |

### Binding RPC cost from the same Workers (p50)

| Call | LHR | SEA |
|---|---|---|
| `get()` | 177 | 33 |
| `info()` | 166 (single diagnostic request) | 15–24 (probe) |
| `createToken()` | 367 | 81 |
| `log()` + `readCommit()` | 325 | 40 |

A 297-byte GET costing about 370 ms from LHR, and an `info()` RPC dropping from 166 ms to under 25 ms when placed in SEA, both mean the backend for this namespace sits near the US West coast. **That location is an inference from latency, not documented.**

### Memory

- **No memory errors:** 0 `exceededMemory`, `exceededCpu` or exception outcomes across all 139 tail events (104 from LHR, 35 placed).
- **In-memory fs peak:**
  - 28 KB for a tree-flow cycle;
  - 55 KB with a full checkout;
  - 48 KB after 5 warm commits.
- **Not probed:** the Worker memory limit itself was not exercised (see [Untested](#untested)).

### Commands and captured output (trimmed)

**Seed with local git and the Bearer header.** The token is passed through `GIT_CONFIG_*` env vars, so it is never in argv or the URL.

```console
$ wrangler artifacts repos create seed --namespace keel-spike-12 --json > <scratch>/seed.json
$ SEED_REMOTE=… SEED_TOKEN=… scripts/seed.sh <scratch>/seed-repo
files: 201  head: 1c667b9a81c7b880d97623456a39f647b0baa5de
remote: Processing objects: 100% (208/208)
To https://<account>.artifacts.cloudflare.net/git/keel-spike-12/seed.git
 * [new branch]      main -> main
```

**Fork and first cycle.**

```console
$ scripts/call.sh '/fork?name=ws-main'
200 5.273003
{ "name": "ws-main", "forkMs": 5060, "source": "artifacts:keel-spike-12/seed", "defaultBranch": "main" }
$ scripts/call.sh '/cycle?ws=ws-main&session=S-smoke'
200 3.560936
{ "ok": true, "oid": "8df527631c2a5c2511881896d7365308a41d7610", "verified": true,
  "trailers": { "Change-Id": "I01M4KGQAYJD684ATCKJKSBR1NW", "MFP-Session": "S-smoke" },
  "cycleMs": 2274, "t": { "fork": 168, "token": 536, "clone": 1082, "commit": 0, "push": 1192, "verify": 329 },
  "memfs": { "bytes": 27075, "peakBytes": 27075, "files": 19 } }
# matching tail event: {"wallTime":3369,"cpuTime":227,"outcome":"ok", ...}
```

**One instrumented warm request from LHR (n=3).** Every round trip is at least 300 ms.

```console
$ scripts/call.sh '/cycle?ws=ws-main&session=S-diag&n=3'
{"ok":true,"colo":"LHR","n":3,"verified":true,"cycleMs":2052,
 "t":{"fork":178,"info":166,"token":360,"clone":978,"commit":0,"push":1074,"verify":580},
 "warm":[{"commit":0,"push":1043},{"commit":0,"push":1026}]}
{"op":"GET refs?git-upload-pack","status":200,"totalMs":309,"resBytes":385}
{"op":"POST git-upload-pack","status":200,"totalMs":669,"reqBytes":149,"resBytes":15584}
{"op":"GET refs?git-receive-pack","status":200,"totalMs":327,"resBytes":297}
{"op":"POST git-receive-pack","status":200,"headersMs":403,"totalMs":747,"reqBytes":4624,"resBytes":121}
...
```

**Main runs.**

```console
$ scripts/run.sh main-tree 25 '/cycle?ws=ws-main&flow=tree&auth=bearer&session=S-main'
main-tree #1 http=200 client=4.023713s
...
main-tree #25 http=200 client=3.191389s
$ node scripts/summarise.mjs <tail.json>,<tail-placed.json> main-tree placed-sea   # full output: results/summary.txt
== main-tree: n=25 ok=25 verified=25 tail-joined=25 outcomes={"ok":25} memfs-peak=28128B
metric                           p50     p95     max   n
clone                           1071    1151    1195   25
push                            1103    1171    1172   25
cycle (clone+commit+push)       2204    2291    2313   25
request CPU (tail)               102     190     215   25
pass(<2000ms wall p95): false  pass(<500ms CPU p95): true

== placed-sea: n=20 ok=20 verified=20 tail-joined=20 outcomes={"ok":20} memfs-peak=28538B
clone                            314     486     522   20
push                             397     525     640   20
cycle (clone+commit+push)        706     955     970   20
request CPU (tail)               111     161     236   20
pass(<2000ms wall p95): true  pass(<500ms CPU p95): true
```

**Placement took effect.**

```console
$ curl -sD - -X POST -H 'x-spike-key: …' 'https://keel-spike-12-client-placed.<subdomain>.workers.dev/cycle?…' | grep cf-placement
cf-placement: remote-IAD     # region aws:us-east-1: cycle 1265–1535 ms (3 probes, results/placed-probe.jsonl)
cf-placement: remote-SEA     # region aws:us-west-2: cycle 704–788 ms (3 probes), then 20-cycle run above
```

**Push into a brand-new empty repo (`POST /empty`, 2 of 2 OK).**

```console
$ scripts/run.sh empty 2 '/empty'
{"ok":true,"steps":{
  "cloneEmpty":{"ok":true,"head":null},
  "push":{"ok":true,"oid":"5a5cfd4798a8d1df7055367acaa0cf2f6d7230c3"},
  "verify":{"headIsOurs":true,"trailers":{"Change-Id":"I01M4KHAXS56XCHA20RWS3MX2G7","MFP-Session":"S-01M4KHAXS59FCXTHW1GF4NMWB6"},
            "verified":true,"defaultBranch":"main","lastPushAt":null},
  "secondCycle":{"ok":true,"parentIsFirst":true}}}
```

The empty-repo test:

1. `create()` a new repo.
2. Shallow-clone it (succeeds with `head: null`).
3. `init` + `addRemote` in memory, and commit 3 files with trailers as a root commit.
4. Push with Bearer.
5. Verify.
6. Run a normal clone + commit + push cycle on top; its parent is the first commit.

## Pass/fail

| Criterion | Result |
|---|---|
| Clone, commit with trailers, push and verify from a Worker | **PASS**: 155 of 167 recorded cycles verified. The other 12 were deliberate (6 refusals, 2 verifier mismatches) or a harness bug (4 non-fast-forward; see can-fail 5). |
| < 2 s wall per cycle, default placement (LHR) | **FAIL**: p50 2204, p95 2291 (n=25); other LHR runs p95 2384–2975 |
| < 2 s wall per cycle, targeted placement `aws:us-west-2` (SEA) | **PASS**: p50 706, p95 955 (n=20) |
| < 500 ms CPU per cycle (tail CPU, whole request) | **PASS**: LHR p95 190, SEA p95 161; max in any run 407 |
| Peak memory | **PASS** (no failure signal): 0 exceeded-memory outcomes in 139 requests; memfs ≤ 55 KB. The limit itself is untested. |
| Push into a brand-new empty repo | **PASS**: 2 of 2, verified; cloning an empty repo also works |
| Named-branch push with Basic auth (stripped password) | **PASS**: 5 of 5, after fixing a harness bug (see Gotchas) |
| Read-scope token refused on push | **PASS**: 3 of 3 refused with 403 |
| Tampered Basic password refused | **PASS**: 3 of 3 refused with 403 |
| Full token as Basic password refused on push | **FAIL: not reproduced.** 6 of 6 accepted, pushed and verified |

## Go / no-go

**GO for `workspace-git` as the load-generator and swarm-agent client, on these conditions:**

1. **Place the client Workers near the Artifacts backend.**
   - Use `placement: { mode: "targeted", region: "aws:us-west-2" }` for this account, or, untested, Smart Placement.
   - Without placement, a cycle from a European colo misses the 2 s budget (2.2 s p50).
   - The fix is placement, not client work: CPU is under 200 ms p95 and four round trips set the wall time.
2. **Fork once per agent, not per cycle.** A fork takes 3.8–5 s.
3. **Mint tokens once per session, not per cycle.** `createToken` costs 370–530 ms from LHR and 80 ms placed.
4. **Prefer long-lived in-memory workspaces** (clone once, then commit+push many times). This removes the two clone round trips: warm commit+push takes 378 ms p50 placed and 1097 ms p50 from LHR.

**NO-GO** if the load generator must run unplaced in arbitrary colos and still meet 2 s per full clone + commit + push cycle.

## Fallback

The planned fallback is for the load generator to push through GitCore's push client. Two notes for anyone choosing it:

- **It does not fix the wall-time failure seen here if it speaks the same smart-HTTP protocol from the same colo.** The cost is round trips to the backend, not the client. A push is at minimum a discovery GET plus a receive-pack POST, about 1.1 s from LHR.
- **It only helps if it removes round trips** (for example, pushing a commit built on a known parent without a fresh clone) **or runs placed near the backend.** Neither was tested here.

## Can-fail demonstrations

1. **Wall-time gate.**
   - The same summariser prints `pass(<2000ms wall p95): false` for the LHR runs and `true` for the placed run, so the threshold check is live.
2. **Read-scope token.**
   - Command: `scripts/run.sh canfail-read 3 '/cycle?ws=ws-main&auth=read&session=S-cf'`.
   - The clone succeeds with the read token, then the push is refused on discovery, before any pack is sent:
     ```text
     canfail-read 1 502 {"ok":false,"phase":"push","error":{"name":"HttpError","status":403,"message":"HTTP Error: 403 Forbidden"},
       "http":["GET refs?git-upload-pack=200","POST git-upload-pack=200","GET refs?git-receive-pack=403"]}   (3/3)
     ```
3. **Basic auth forms.** All three runs used write tokens.

   | Mode | Password | Result |
   |---|---|---|
   | `basic` (control) | token part before `?expires=` | 3 of 3 pushed and verified (`canfail-basic-control`), plus 5 of 5 on a branch |
   | `basic-bad` | that part with its last character changed | 3 of 3 refused, **403 at clone** (`canfail-basic-bad`) |
   | `basic-full` | full token including `?expires=<unix>` | **expected refusal; got acceptance**: 6 of 6 pushed and verified (`canfail-basic-full`, `canfail-basic-full-r2`) |

   **The stated gotcha ("the full token as the Basic password fails on real pushes") did not reproduce on 2026-10-10.**
   - The binding issued tokens shaped `art_v2_x_<40 hex>?expires=<unix>`, not `art_v1_`. The service may treat the newer format differently.
   - The library keeps sending the stripped password (or Bearer), which is accepted. Do not rely on the full-token form either being refused or being accepted.
4. **Trailer verifier.**
   - `expect=wrong` makes the verifier compare against a different `Change-Id`.
   - Result: `verified:false` in 2 of 2 runs, while the push itself succeeded (`canfail-verify`). The check rejects a mismatched trailer.
5. **Non-fast-forward is caught client-side.**
   - An early branch run cloned `main` but pushed onto an existing `agent/…` branch.
   - Cycles 2–5 got `PushRejectedError: not a simple fast-forward` after the receive-pack discovery, without sending a pack (`results/branch-basic-harness-bug.jsonl`).
   - Fixed by cloning the branch tip when it exists.
6. **Secret and path scan.**
   - The scan over the spike's files (account ID, token prefix, local paths) is clean.
   - Planting the account ID into a scratch copy of a results file made the same scan flag it (`grep-exit=0`).

## Gotchas found

- **Token format is `art_v2_x_<hex>?expires=<unix>`.** A redaction regex keyed on `art_v1_` misses it. `redact()` matches `art_v\d+_…`.
- **The remote URL host embeds the account ID** (`<account>.artifacts.cloudflare.net`). Redact it from logs and error messages too. isomorphic-git errors can echo URLs.
- **Full token as the Basic password was accepted**; see can-fail 3. Use Bearer or the stripped password.
- **Latency dominates.**
  - From LHR, every smart-HTTP request takes about 300–770 ms and every binding RPC 160–370 ms.
  - Placement near the backend cuts both by roughly 3–10×.
  - The backend's location for a namespace is not exposed. It was inferred here from latency.
- **The Workers clock does not advance during CPU-only work.** In-Worker timers report 0 ms for the commit phase. Use tail `cpuTime`.
- **Commit without a working tree.**
  - On a `noCheckout` shallow clone, there is no index to commit from: `git.add` + `git.commit` would commit an empty tree.
  - Write blobs, rewrite the touched trees and call `git.commit({ tree, parent })` instead.
  - As given, `ref` must be omitted, or the commit writes `.git/main`.
- **isomorphic-git's push sends only the delta from a shallow clone.** It walks the merge base's objects and subtracts them. The receive-pack request was about 4.6 KB for 3 edits.
- **Named-branch workflows must clone the branch tip.** Cloning `main` and pushing onto an existing branch is a client-side non-fast-forward rejection.
- **Cloning an empty repo succeeds**, with `HEAD` unresolved, rather than throwing. The empty-repo path is `init` + `addRemote` + root commit + push.
- **`info().lastPushAt` was still `null`** immediately after a successful push into a new repo (2 of 2).
- **`fork()` takes 3.8–5 s.** `get()` succeeded straight after `fork()` returned; no `FORK_IN_PROGRESS` was seen, but the retry loop stays.
- **In-memory fs:**
  - every method is `async` and throws;
  - `readlink`/`symlink` are implemented;
  - written buffers are copied, because isomorphic-git passes `Buffer` views onto shared pools.
- **pnpm:** `pnpm install --ignore-workspace` ignores `pnpm-workspace.yaml`, so its `allowBuilds` is not applied. The install reports `ERR_PNPM_IGNORED_BUILDS` for esbuild and workerd, yet wrangler bundles and deploys normally.
- **Teardown:** wrangler 4.149.0 has no `artifacts namespaces delete`. After the repos were deleted, the `keel-spike-12` namespace remains with `repo_count: 0`.

## Untested

- Concurrency: many agents cycling in parallel, whether against one workspace or many.
- Larger repos or larger edits. The seed is 201 files of about 50 bytes each.
- Smart Placement (`mode: "smart"`): it needs sustained traffic to decide.
- `placement.hostname` aimed at the Artifacts host.
- Whether the backend region is stable per namespace or account.
- The Worker memory limit itself. Only "no exceeded-memory outcome" is shown.
- isomorphic-git's `onAuth` callback path (headers were used throughout).
- `art_v1_` tokens.
- Token expiry mid-cycle.
- A tail Worker; `wrangler tail` was used instead.
- Pushing without a prior clone.

## Teardown

```console
$ wrangler artifacts repos list --namespace keel-spike-12 --json   # before
repos: 9 empty-01m4khayp18haj3282vkwcfqkt empty-01m4khavyte9607zm6bac2nsps ws-01m4kh66tdxyb7v0pfxc971rqd … ws-main seed
$ scripts/call.sh /cleanup            # deletes every repo through the binding
200 18.376030{ "deleted": 9, "remaining": []}
$ wrangler artifacts repos list --namespace keel-spike-12
No Artifacts repos found in namespace "keel-spike-12".
$ wrangler delete --name keel-spike-12-client --force
Successfully deleted keel-spike-12-client
$ wrangler delete --name keel-spike-12-client-placed --force
Successfully deleted keel-spike-12-client-placed
$ wrangler deployments list --name keel-spike-12-client
✘ [ERROR] A request to the Cloudflare API (/accounts/<account>/workers/scripts/keel-spike-12-client/deployments) failed.
  This Worker does not exist on your account. [code: 10007]
$ wrangler deployments list --name keel-spike-12-client-placed
  This Worker does not exist on your account. [code: 10007]
$ curl -s -o /dev/null -w '%{http_code}' https://keel-spike-12-client.<subdomain>.workers.dev/list          # 404
$ curl -s -o /dev/null -w '%{http_code}' https://keel-spike-12-client-placed.<subdomain>.workers.dev/list   # 404
$ wrangler artifacts namespaces get keel-spike-12
namespace:   keel-spike-12
repo_count:  0
```

## Reproduce

```sh
cd spikes/12-workspace-git
pnpm install --ignore-workspace && pnpm types && pnpm typecheck && pnpm lint
wrangler artifacts repos create seed --namespace keel-spike-12 --json   # keep the output out of the repo
SEED_REMOTE=… SEED_TOKEN=… scripts/seed.sh "$TMPDIR/seed-repo"
wrangler deploy && wrangler secret put SPIKE_KEY
wrangler tail keel-spike-12-client --format json > "$TMPDIR/tail.json" &
export WORKER_URL=https://keel-spike-12-client.<subdomain>.workers.dev SPIKE_KEY=…
scripts/call.sh '/fork?name=ws-main'
scripts/run.sh main-tree 25 '/cycle?ws=ws-main&flow=tree&auth=bearer&session=S-main'
node scripts/summarise.mjs "$TMPDIR/tail.json" main-tree
# placed probe: wrangler deploy -c wrangler.placed.jsonc (+ secret, + its own tail)
```
