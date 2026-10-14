# S16: Deploy adapters

Run on 2026-10-10 against the live edge, from London (requests landed in LHR, CDG and DUB). Code is in [`spikes/16-deploy-adapters/`](../../spikes/16-deploy-adapters/). Raw, redacted results are in `spikes/16-deploy-adapters/results/`.

## Answer

**GO.** All four criteria pass. (b) is proven from local only; the in-Worker path is untested, for want of a scoped token.

| | Criterion | Result | Verdict |
|---|---|---|---|
| (a) | isolate preview router with static assets: first byte < 1 s | stateless path: 30/30 cold samples < 1 s (API max 685 ms, asset max 364 ms) | **PASS** |
| (b) | Workers Previews REST: the preview serves | from local, both `wrangler preview` and the REST adapter fed by in-Worker-built modules serve the right world. In-Worker call with a Secrets Store token: **untested** | **PASS (local)** |
| (c) | 10% → 100% → rollback: rollback restores | 10/90 split observed at 9.5–12% A; rollback settles to 100% base 1.3–3.3 s after the command returns; 300/300 base afterwards | **PASS** |
| (d) | teardown: nothing left behind | previews 0, R2 0 objects then bucket gone (10006), both Workers 10007, 0 DO namespaces, all 16 URLs 404 | **PASS** |

Conditions on the GO:

1. **Stateful probes need a pinned host.** Through the stateless router, consecutive requests reach different isolates (different colos and machines), so forge-lite's in-memory session vanishes between requests. The S1 revoke flow only works through a Durable Object named by the candidate id (`/pinned/<id>/`).
2. **The pinned path is slow on its first request.** Creating the Durable Object costs about 0.6 s. Its first request exceeded 1 s in 3/20 cold samples (max 1281 ms). So `preview()` must warm it before returning. Once warm, the first probe takes ≤ 435 ms (10/10), and a preview is ready in 1.2–2.4 s.
3. **Gradual-deploy commands return before the edge converges.** `verify()` after promote or rollback must use a batch-based settle check, not "N in a row" (see [gotchas](#gotchas)).
4. **Teardown of one candidate needs two router fixes**, both made and verified here (see [teardown](#d-teardown)).

**Fallback:** not needed. (a) alone covers Keel's preview needs. Until a scoped token exists, (b) and (c) run from local or CI wrangler as measured here, and the in-Worker REST path comes later.

## Question

Do Keel's deploy adapters work? The `Deployer` port is `plan → preview → verify → promote → rollback → teardown`, and every operation returns evidence.

- (a) An isolate preview router with static assets.
- (b) Workers Previews REST, from modules bundled in a Worker, using a per-Worker scoped token held in Secrets Store.
- (c) A version at 10%, then 100%, then rollback.
- (d) Teardown.

## Setup

**Candidates.** Each world is a copy of `fixtures/forge-lite` in scratch, which was not modified:

- **base**: the fixture as is;
- **A**: the copy plus `scenarios/s1/a.patch`, applied with `git apply`.

A tiny asset set (`assets/index.html`, `assets/app.js`) goes with every candidate.

**World check** (`scripts/world.ts`): an anonymous `DELETE /repos/keel/probe/collaborators/nobody`.

- Base answers Hono's default 404 (`text/plain`, `404 Not Found`): the route does not exist. This is the same rule `scenarios/run-probe.mjs` uses for `n/a`.
- A answers `application/problem+json`: the route runs.

The full revoke flow (sign up alice and bob, create a repo, add bob as admin, revoke bob) is also scripted. It needs every step to reach the same isolate.

**Packages (exact).**

| Package | Version |
|---|---|
| `wrangler` | 4.149.0 |
| `@cloudflare/worker-bundler` | 0.2.6 (MIT, experimental, workerd only) |
| `hono` | 4.13.13 |
| `typescript` | 6.0.3 |
| `@cloudflare/workers-types` | 5.20261008.1 |
| `oxlint` | 1.87.0 |

pnpm 11.18.0, Node 22.22.3.

**Workers and resources** (all deleted at the end):

- **`keel-spike-16-router`** (`src/router.ts`):
  - bindings: `worker_loaders` `LOADER`, R2 `keel-spike-16-bundles`, a `CandidateHost` Durable Object, and an `ADMIN_TOKEN` secret;
  - `cpu_ms` 300000.
- **`keel-spike-16-app`**: forge-lite deployed with wrangler, with the same assets and an empty `previews` block (`wrangler.app.jsonc`). It is used for (b) and (c).

**Router routes:**

- `POST /admin/build` runs `createApp({ files, server: "src/index.ts", assets })` inside the Worker. The bundler installs `dependencies` (hono) from npm at build time. The result is stored in R2:
  - `bundles/<id>/worker.json` holds the main module, the modules and the asset manifest;
  - `bundles/<id>/assets/<path>` holds each asset body.

  `<id>` is the first 20 hex characters of the sha256 of the canonical code, assets and compat date.
- `/cand/<id>/<path>` is the stateless path:
  1. strip the prefix;
  2. try `handleAssetRequest(req, manifest, r2Storage)`;
  3. otherwise call `LOADER.get(id, …).getEntrypoint().fetch(req)` with `globalOutbound: null` and no bindings.
- `/pinned/<id>/<path>` does the same inside the Durable Object `idFromName(id)`.
- `GET /admin/bundle/<id>` returns the stored code for the REST adapter.
- `DELETE /admin/cand/<id>` and `GET|DELETE /admin/all` handle teardown.

**Previews REST adapter** (`src/previews-rest.ts`): plain `fetch`, `FormData` and `Blob`, so the same module runs in a Worker or in Node. It was driven from Node by `scripts/rest-preview.ts`.

**Timing.** Client-side figures are curl's `time_starttransfer`: a fresh connection per request, with DNS, TCP and TLS included. "After TLS" (`starttransfer − appconnect`) is the server's share plus one round trip. A "network floor" is `GET /` on the router, which does no candidate work.

Inside a Worker, `Date.now()` only advances at I/O. So the in-Worker `buildMs` (72–90 ms) understates esbuild's CPU. Use the client round trip instead.

Reproduce (`<scratch>` holds the two candidate copies, the admin token and the subdomain):

```
cd spikes/16-deploy-adapters && pnpm install --ignore-workspace
source <cf.env>
wrangler r2 bucket create keel-spike-16-bundles
wrangler deploy -c wrangler.router.jsonc && wrangler secret put ADMIN_TOKEN -c wrangler.router.jsonc
export ROUTER_URL=https://keel-spike-16-router.<subdomain>.workers.dev ADMIN_TOKEN_FILE=<scratch>/admin-token \
       BASE_DIR=<scratch>/cand/base A_DIR=<scratch>/cand/a APP_URL=https://keel-spike-16-app.<subdomain>.workers.dev SUBDOMAIN=<subdomain>
scripts/bench-router.sh r3 cand; scripts/bench-router.sh r3 pinned; scripts/bench-prewarm.sh r3; scripts/delete-check.sh r2
scripts/rollout.sh c1; scripts/rollout-settle.sh c2      # (c)
scripts/previews.sh p2                                   # (b) via wrangler preview
CLOUDFLARE_API_TOKEN=<token> node scripts/rest-preview.ts create <candidate-id> rest-a keel-spike-16-app   # (b) REST
scripts/teardown.sh d1; scripts/teardown-proof.sh d1     # (d)
```

## (a) The isolate preview router

### Numbers

These are the three stateless runs (`router-r{1,2,3}-cand.txt`). r3 ran on the final router code; r1 and r2 on the code before the teardown fixes, whose serve path is the same except for the revalidation described under [teardown](#d-teardown). Each cold sample is a new candidate id: a base build with a fresh salt asset (`/.salt`), which changes the hash but not the behaviour. No isolate anywhere had loaded it.

| Path | Measure | n | TTFB p50 | TTFB max | Over 1 s |
|---|---|---|---|---|---|
| stateless `/cand/` | cold, API `GET /users/ghost` | 15 | **238 ms** | **685 ms** | 0 |
| stateless | cold, asset `GET /app.js` | 15 | **278 ms** | **364 ms** | 0 |
| stateless | warm API, 20 per run (p50 / p95 per run) | 60 | 180 / 179 / 114 | p95 520 / 308 / 264 | 0 |
| stateless | warm asset `/app.js` (p50 / p95 per run) | 60 | 186 / 210 / 87 | p95 378 / 247 / 203 | 0 |
| stateless | warm `index.html` via `/` (p50 / p95 per run) | 60 | 202 / 170 / 132 | p95 242 / 272 / 294 | 0 |
| network floor | `GET /` on the router (r2, r3) | 40 | 147 / 67 | p95 417 / 194 | 0 |
| pinned `/pinned/` | cold API (r2, r3) | 10 | 763 ms | **1281 ms** | **2** |
| pinned | cold asset (r2, r3) | 10 | 792 ms | **1219 ms** | **1** |
| pinned | warm API (p50 / p95 per run) | 40 | 147 / 73 | p95 223 / 218 | 0 |
| pinned + warm-up in `preview()` | the warm-up request (= the cold DO hit) | 10 | 732 ms | 1160 ms | 2 |
| pinned + warm-up in `preview()` | **the first probe after it** | 10 | **158 ms** | **435 ms** | **0** |
| pinned + warm-up in `preview()` | preview ready (build round trip + warm-up) | 10 | 1.56 s | 2.39 s | n/a |

`server-timing` on warm stateless requests showed `isolate;dur` of 2–33 ms, against a client TTFB of 80–340 ms. Requests flapped between the CDG and LHR colos. So warm latency is mostly network and routing, not the Dynamic Worker.

In-Worker build round trip (client-measured, including the hono install from npm): 0.51–1.99 s over 35 builds. Bundle size: 90,008 B (base) and 90,909 B (A), one module `bundle.js`.

```
$ scripts/bench-router.sh r3 cand            # results/router-r3-cand.txt
{"label":"cold-api","n":5,"codes":"404","ttfbMs":{"min":158,"p50":183,"p95":287,"max":287},...}
{"label":"cold-asset","n":5,"codes":"200","ttfbMs":{"min":152,"p50":252,"p95":362,"max":362},...}
{"label":"warm-api","n":20,"codes":"404","ttfbMs":{"min":30,"p50":114,"p95":264,"max":386},...}
$ scripts/bench-router.sh r3 pinned          # results/router-r3-pinned.txt
{"label":"cold-api","n":5,"codes":"404","ttfbMs":{"min":590,"p50":763,"p95":1281,"max":1281},...}
$ scripts/bench-prewarm.sh r3                # results/router-r3-prewarm.txt
ready=1288ms ready=1398ms ready=1560ms ready=1559ms ready=1155ms
{"label":"pinned-first-probe-after-prewarm","n":5,"codes":"404","ttfbMs":{"min":51,"p50":60,"p95":158,"max":158},...}
```

### Previews are worlds

The same router serves base and A from their content-hash ids. The check runs on the live router:

```
base 26ea5d8b504649d7c29d: {"classify":{"world":"base","status":404,"contentType":"text/plain; charset=UTF-8"}}
A    3c9508648f271a181919: {"classify":{"world":"A","status":404,"contentType":"application/problem+json"}}
```

The full revoke flow, through `/pinned/` (`router-r3-pinned.txt`):

```
base: sign up alice 201, sign up bob 201, alice logs in 201, creates forge 201, adds bob as admin 201, revokes bob 404 "404 Not Found"
A:    sign up alice 201, sign up bob 201, alice logs in 201, creates forge 201, adds bob as admin 201, revokes bob 204
```

The same flow through the stateless `/cand/` path fails at step 4 in both worlds with `401 the bearer token is not valid`. The session was minted in a different isolate. That is condition 1 of the GO.

### Can fail

All of these are from `router-r3-*.txt`.

| Check | Result |
|---|---|
| world probe with a wrong expectation (base checked as A) | `MISMATCH: expected world A, got base`, exit 1 |
| a well-formed id that was never built (`0000000000deadbeef00`) | `404 {"error":"candidate-not-found"}`, `application/json`; the same for an asset path |
| a real id with one character changed | `404 candidate-not-found`, not a near neighbour |
| a malformed id (`not-a-hash`) | `404 {"error":"invalid-candidate-id"}` |
| admin route without the token | `401 {"error":"unauthorized"}` |
| TTFB gate with `--max-ms 1` | `FAIL gate-check: 3/3 samples at or over 1 ms`, exit 1 |

### Cost model

Dynamic Workers ([pricing](https://developers.cloudflare.com/dynamic-workers/pricing/)) cost:

- 1,000 unique Dynamic Workers a month are included, then **$0.002 per Dynamic Worker per day**;
- requests and CPU are billed at Workers Standard rates.

"Unique" is the Worker ID **and** its code: the same ID with new code counts again, and so does `.load()` or a missing ID.

So the router keys `LOADER.get` by the content hash. Re-pushing identical code reuses the same billable Worker, and every request for a candidate reuses its id. A Keel preview costs at most $0.002 for each day it is visited.

This spike created about 43 candidate ids, all under the included allowance. The salted cold-start ids are a benchmarking artefact.

### DNS form

`cand-<id>.<host>` (wildcard routing on keel.town) was **untested**: no DNS or zone routes were allowed. The path form `/cand/<id>/…` on workers.dev was used throughout.

## (b) Workers Previews REST

### What exists (docs and wrangler 4.149.0 source, 2026-10-10)

Workers Previews is an open-beta product, separate from version preview URLs. `wrangler preview` needs wrangler ≥ 4.135.0. Each Preview has:

- a stable **Preview URL**, `<preview-name>-<worker>.<subdomain>.workers.dev`;
- an immutable **Deployment URL** per deploy, `<deployment-id>-<worker>.<subdomain>.workers.dev`.

Limits are 500 previews per Worker and 100 deployments per preview on paid plans, with the oldest evicted automatically.

The REST reference pages under `developers.cloudflare.com/api/` return 404 for previews. The endpoints below come from wrangler's own client (`deploy-helpers/src/preview/api.ts` in the bundle), and every one marked "used" was called live in this spike:

| Call | Endpoint | Payload | Used |
|---|---|---|---|
| create parent Worker if missing | `POST /accounts/{acct}/workers/workers` | `{"name", "subdomain": {"enabled", "previews_enabled"}}` | no (the Worker existed) |
| get preview | `GET …/workers/workers/{worker}/previews/{name\|id}` | (none); missing preview = 404 / code 10025 | yes |
| list previews | `GET …/workers/workers/{worker}/previews?page&per_page` | (none); paginated; not wrapped by wrangler | yes |
| create preview | `POST …/workers/workers/{worker}/previews[?ignore_base_config=true]` | `{"name", "observability"?, "logpush"?, "tail_consumers"?}` | yes |
| edit preview | `PATCH …/previews/{id}` | same fields | no |
| create deployment | `POST …/previews/{id}/deployments` | multipart: `metadata` = `{"main_module", "compatibility_date", "compatibility_flags"?, "env"?, "assets"? {"jwt","config"}, "annotations"?, "limits"?, "migrations"?, "placement"?, "containers"?}`; one `files` part per module (filename = module name, type `application/javascript+module` for ESM) | yes |
| latest deployment | `GET …/previews/{id}/deployments/latest` | (none) | no |
| patch deployment env | `PATCH …/previews/{id}/deployments/latest` | `application/merge-patch+json` `{"env", "annotations"}` | no |
| base config | `GET`/`PATCH …/workers/workers/{worker}` | `previews_base_config` | no |
| delete preview | `DELETE …/previews/{name\|id}` | (none) | yes |

Assets go through the existing session flow, then into `metadata.assets.jwt`:

1. `POST …/workers/scripts/{worker}/assets-upload-session`;
2. `POST …/workers/assets/upload?base64=true`.

`wrangler preview` did this; the adapter here did not.

### From local with wrangler (`results/previews-p2.txt`)

`wrangler preview <candidate>/src/index.ts -c wrangler.app.jsonc --name <n> --json`, with the OAuth login:

| Preview | Create (wall) | First request to the new URL, API | First request, asset | Warm API p50 / p95 | World via preview URL | World via deployment URL |
|---|---|---|---|---|---|---|
| p2-a (A) | 6630 ms | 666 ms | 416 ms | 186 / 314 ms | A | A |
| p2-base (base) | 6388 ms | 574 ms | 207 ms | 140 / 306 ms | base | base |
| p1-a, p1-base | 6332, 6298 ms | n/a (JSON parse bug in the first run; see gotchas) | | | | |

Production stayed on base throughout. Previews on workers.dev carry `x-robots-tag: noindex`.

### From local with the REST adapter and in-Worker-built modules (`results/previews-rest-r1.txt`)

`scripts/rest-preview.ts` takes the bundle that `@cloudflare/worker-bundler` built **inside the router**, from `GET /admin/bundle/<id>`. It then calls `upsertPreview` and `createPreviewDeployment` from `src/previews-rest.ts`. The token was wrangler's OAuth token, passed through the environment of that one process.

| Preview | Candidate | Fetch bundle | Get + create preview | Create deployment | Total | First byte | Warm API p50 / p95 | World |
|---|---|---|---|---|---|---|---|---|
| rest-a | A `3c9508648f271a181919` | 534 ms | 2053 ms | 1861 ms | **4447 ms** | 605 ms | 149 / 276 ms | A (both URLs) |
| rest-base | base `26ea5d8b504649d7c29d` | 326 ms | 1859 ms | 2000 ms | **4185 ms** | 889 ms | 156 / 280 ms | base (both URLs) |

**Update semantics.** Base's modules were pushed as deployment 2 of `rest-a`:

- the API calls took 3207 ms;
- the Preview URL flipped to base within 4.5 s after that, with 10 stale A responses along the way;
- the old Deployment URL still served A, so deployment URLs are immutable.

Can fail:

```
bad token:      PreviewsApiError: GET /workers/workers/keel-spike-16-app/previews/rest-x: HTTP 400 [9106] Authentication failed (status: 400)
missing worker: PreviewsApiError: POST /workers/workers/keel-spike-16-no-such-worker/previews: HTTP 404 [10007] This Worker does not exist on your account.
```

### Untested without a scoped token

- The in-Worker call: the router itself calling `api.cloudflare.com` with the token read from a `secrets_store_secrets` binding (`await env.PREVIEWS_TOKEN.get()`). The adapter module is runtime-agnostic and was exercised only from Node. No Secrets Store secret was created: storing a dummy in the account's store, or sending the full-scope OAuth token to a public Worker, were both judged not conservative.
- Whether a **per-Worker scoped** token is enough for `POST …/workers/workers/{worker}/previews` and its deployments. The docs ask only for "edit Workers Scripts and the resources used by the Preview".
- Asset upload through the adapter (the session plus a JWT). `wrangler preview` did this successfully; the adapter does not implement it yet.

## (c) Versions and gradual rollout

From local wrangler (`results/rollout-c1.txt`, `rollout-c2.txt`, `rollout-c3.txt`, `rollout-c4-override.txt`).

The REST calls behind these commands:

- `versions upload` is `POST /accounts/{acct}/workers/scripts/{name}/versions` (multipart);
- `versions deploy` and `rollback` are `POST …/scripts/{name}/deployments` with `{"strategy":"percentage","versions":[{"version_id","percentage"}],"annotations":{"workers/message"}}`.

| Step | Command wall time | After it |
|---|---|---|
| `wrangler deploy` base (new Worker, with assets) | 11872 ms | workers.dev URL answered after another 11.8 s (432 polls failed first) |
| `wrangler versions upload` A | 7166 ms | 20/20 still base |
| `wrangler versions deploy A@10% base@90%` | 7964 / 8031 / 7861 ms | first A response 515 ms after |
| split, 200 + 400 + 400 + 400 samples | | **9.5% / 11.8% / 10.3% / 12.0% A**, all inside 3σ |
| `versions deploy A@100%` | 6562 / 6691 / 6839 ms | settled (3 × 50 all A) at **2119 / 3242 ms** after the command |
| `wrangler rollback <base>` | 4528 / 4546 / 4766 ms | settled to base at **1345 / 3293 ms**; then **300/300 base** (c2, c3) |
| override header `Cloudflare-Workers-Version-Overrides: keel-spike-16-app="<id>"`, settled split | | **100/100 A** and **100/100 base** |
| override header during propagation (c1) | | 19/20 A |

The settle traces are `<ms after the command returned>:<% target>` per batch of 50. Rollback in c3:

```
0:76 378:80 579:86 855:90 1014:92 1148:92 1355:92 1498:92 1753:94 1900:100 2069:100 2218:96 2357:100 2623:100 2780:98 2910:96 3042:100 3167:96 3293:100 3422:100 3554:100
```

c1 used a "20 consecutive" check instead. It declared done 3.2 s after rollback, and the next 100 samples were still 38% A. That check was too weak (see gotchas).

`wrangler deployments list` before teardown recorded the four deployments: base 100% → A 10% / base 90% → A 100% → rollback to base 100%.

### Can fail

| Check | Result |
|---|---|
| a fresh 200 samples of the 10/90 split checked against 50% A | `observedPctA 6, expectedPctA 50 … MISMATCH`, exit 1 |
| the same checked against 0% A | `observedPctA 12 … MISMATCH`, exit 1 |
| right after promote, 100 samples checked against 100% A (c1) | `93% … MISMATCH`: a real catch of the propagation tail |
| override pinned to base checked against 100% A | `MISMATCH`, exit 1 |
| override naming another Worker | ignored: 12% A, `MISMATCH` against 100% |

## (d) Teardown

### Teardown of one candidate (router)

Teardown of a single candidate failed on the first router build:

- warm router isolates kept serving the deleted candidate's code from their in-memory cache;
- asset paths returned **200 with `content-length: 0`**.

`@cloudflare/worker-bundler` 0.2.6's `handleAssetRequest` trusts the manifest, so when storage returns `null` it answers an empty 200 instead of a 404 (`results/router-delete-r1.txt`):

```
HTTP/2 200
content-type: application/javascript; charset=utf-8
content-length: 0
x-keel-served-by: asset
```

Two fixes went into the router:

1. A storage miss marks the candidate gone: evict it and return `404 candidate-not-found`.
2. Cached metadata older than 10 s is re-confirmed with an R2 `head`.

After them (`results/router-delete-r2.txt`): with the candidate warm in several router isolates, the asset path was `gone` immediately. The API path stopped being served 2.5 s after the delete, and nothing was served at t+11 to 25 s. The check exits 1 if anything is served after the window or if an empty 200 is ever seen; the r1 output above is what it would have failed on.

### Full teardown (`results/teardown-d1.txt`)

Inventory before teardown:

- 6 previews: `rest-a`, `rest-base`, `p2-base`, `p2-a`, `p1-base`, `p1-a`;
- 158 R2 objects across 40 candidates;
- 2 versions of the app, and the router's `ADMIN_TOKEN` secret;
- 16 workers.dev URLs used.

```
$ wrangler preview delete --name p1-a --worker-name keel-spike-16-app -y -> exit=0 in 1808 ms   (p1-base 1697, p2-a 1820, p2-base 1746)
REST delete rest-a: {"deleted":"rest-a","ms":1079}     REST delete rest-base: {"deleted":"rest-base","ms":1175}
previews after: {"count":0,"names":[]}
DELETE /admin/all: 158 objects, 40 candidates deleted
GET /admin/all after: 0 objects
$ wrangler delete --name keel-spike-16-app --force -> exit=0     Successfully deleted keel-spike-16-app
$ wrangler delete --name keel-spike-16-router --force -> exit=0  Successfully deleted keel-spike-16-router
$ wrangler r2 bucket delete keel-spike-16-bundles -> exit=0      Deleted bucket keel-spike-16-bundles.
$ wrangler deployments list --name keel-spike-16-app
    ✘ [ERROR] A request to the Cloudflare API (/accounts/<account-id>/workers/scripts/keel-spike-16-app/deployments) failed.
      This Worker does not exist on your account. [code: 10007]
$ wrangler versions list --name keel-spike-16-app            … [code: 10007]
$ wrangler secret list --name keel-spike-16-app              ✘ [ERROR] Worker "keel-spike-16-app" not found.
$ wrangler deployments list --name keel-spike-16-router
      This Worker does not exist on your account. [code: 10007]
$ wrangler versions list --name keel-spike-16-router         … [code: 10007]
$ wrangler secret list --name keel-spike-16-router           ✘ [ERROR] Worker "keel-spike-16-router" not found.
$ wrangler r2 bucket info keel-spike-16-bundles              The specified bucket does not exist. [code: 10006]
$ wrangler r2 bucket list | grep -c keel-spike-16            0
previews list on the deleted Worker: codes: [ 10007 ]
0 Durable Object namespaces for keel-spike-16-* (0 = none)
https://keel-spike-16-app.<subdomain>.workers.dev -> 404          https://keel-spike-16-router.<subdomain>.workers.dev -> 404
https://a029e446-keel-spike-16-app.<subdomain>.workers.dev -> 404 (version preview URL)
https://{p1-a,p1-base,p2-a,p2-base,rest-a,rest-base}-keel-spike-16-app.<subdomain>.workers.dev -> 404
https://{fe3de8f5,1742daca,907e9116,d8b197d4,7a8d65ac,eda6bfa6,eb53ad2c}-keel-spike-16-app.<subdomain>.workers.dev -> 404 (deployment URLs)
```

Can fail: before teardown, the same commands returned live listings (the `deployments list` in `rollout-c1.txt`, the 6 previews and 158 objects in the inventory above).

## Gotchas

1. **No isolate affinity on the stateless path.** Consecutive requests to `/cand/<id>/` reach different router isolates and different Dynamic Worker isolates: colo flapping between LHR, CDG and DUB, plus several machines per colo. In-memory candidate state does not survive. The `/pinned/` Durable Object fixes it but costs about 0.6 s on its first request. Warm it in `preview()`.
2. **`handleAssetRequest` returns an empty 200 on a storage miss.** That is worker-bundler 0.2.6. Wrap the storage and treat a miss as "gone".
3. **A per-isolate bundle cache outlives deletion.** Revalidate it on a bound (10 s here).
4. **Gradual-deploy propagation.** `wrangler versions deploy` and `rollback` return 4.5–8 s after they are run, and the edge then takes another 1.3–3.3 s to converge.
   - "N consecutive hits" is not convergence: c1's 20-streak was followed by 38% stale responses.
   - `verify()` should require several full batches (3 × 50 here) at 100%.
5. **Override headers only bind once the deployment has propagated.** During propagation: 19/20. Settled: 100/100.
6. **`wrangler preview --json` prints asset-sync progress lines before the JSON on stdout.** Parse from the first `{` line.
7. **No `wrangler preview list`.** `GET …/workers/workers/{worker}/previews` works and is paginated. Deleting the Worker removes its previews (the list then returns 10007).
8. **The Previews REST reference is not published** (API docs pages return 404). wrangler's bundled client is the only exact source; pin the wrangler version that matches.
9. **A brand-new Worker's workers.dev URL took 11.8 s to answer** after `wrangler deploy` returned. New versions and previews of an existing Worker answered within 0.5 s.
10. **`@cloudflare/worker-bundler` installs npm dependencies at build time from inside the Worker** (egress to registry.npmjs.org). It extracts text files only, and is marked experimental. Its `esbuild.wasm` makes the router 14.5 MiB raw (3.8 MiB gzip).
11. **Durable Objects get created for junk ids.** The pinned path creates an object for any well-formed id, even an unknown one. Check existence in the front Worker first if junk ids are a concern.
12. **`Date.now()` inside Workers only advances at I/O**, so in-Worker build and serve timings understate CPU. The client round trip is the honest figure.

## Files

- `spikes/16-deploy-adapters/`:
  - package files: `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.npmrc`, `.gitignore`;
  - configs: `tsconfig.json`, `tsconfig.scripts.json`, `oxlint.config.json`, `wrangler.router.jsonc`, `wrangler.app.jsonc`;
  - assets: `assets/index.html`, `assets/app.js`.
- `src/`: `router.ts` (isolate preview router and `CandidateHost`) and `previews-rest.ts` (the Previews REST adapter).
- `scripts/`:
  - candidates and probes: `build-candidate.ts`, `world.ts`, `probe-world.ts`;
  - measurement: `ttfb.sh`, `stats.ts`, `split.ts`;
  - (a): `bench-router.sh`, `bench-prewarm.sh`, `delete-check.sh`;
  - (c): `rollout.sh`, `rollout-settle.sh`;
  - (b): `previews.sh`, `rest-preview.ts`;
  - (d): `teardown.sh`, `teardown-proof.sh`;
  - `redact.sh`.
- `results/`: one redacted log per run, as cited above. Files whose first line is `# NOTE` record a fixed bench bug, kept as found.

After the last live run, three lint-only edits were made, with behaviour unchanged for the inputs used:

- `toSorted` in place of `sort` on fresh arrays in `router.ts` and `stats.ts`;
- `previews-rest.ts` now merges headers through `new Headers()`, so `Headers` instances are no longer dropped.

The adapter edit was re-checked live afterwards: a good token on the deleted Worker gives `[10007]`, and a bad token gives `[9106]`.
