# Spike 04: the Tier 2 container backstop (MergeBox and ExecBox)

## Question

Does Tier 2 work on the **Containers Durable Object API**: `ctx.container` with the `durable_object` scheduling policy and HTTPS outbound interception, without the Sandbox SDK? Tier 2 covers MergeBox (real git, when the in-DO engine refuses a merge) and ExecBox (the full test suite). Specifically:

- **the image**: Node 22, git and pnpm, with the suite's dependencies installed in advance;
- **start times**: a cold new instance against a snapshot start, a restart and a warm instance;
- **egress**: an outbound intercept adds the Artifacts token, and all other egress is off;
- **the token**: absent from env, `/proc` and the filesystem;
- **the work**: clone, `merge-tree` and vitest give the expected result;
- **concurrency**: 10 instances at once.

**Pass criteria:** injection works, and the warm p50 of the full verify is under 60 s. **Fallback:** a short-lived token in env, for MergeBox only.

## Answer

**Go.** Every check ran on the live edge and passed:

- **Injection:** the token is injected at egress and never enters the container, and the planted-canary control shows the checks can find one.
- **Egress:** with egress off, nothing but the one repo is reachable.
- **Warm verify:** p50 **6.2 s** on `standard-2`. That is clone, `merge-tree --write-tree`, checkout and `pnpm test`, 214/214 passing. The criterion was 60 s.
- **Concurrency:** 10 concurrent cold verifies finished in **16.2 s and 16.4 s** wall, over two runs, with no capacity or scheduling errors.

The fallback is not needed.

## Setup

All of it ran on the live edge.

| Piece | What |
|---|---|
| Worker | `keel-spike-04-tier2`. Classes: `Tier2Box` (the Durable Object with the container) and `ArtifactsEgress` (a `WorkerEntrypoint` that the intercept calls). Binding `ARTIFACTS` → namespace `keel-spike-04`. |
| Container application | `keel-spike-04-tier2-tier2box`, `scheduling_policy: "durable_object"`, one named image `base` |
| Image | `container/Dockerfile`: `node:22-bookworm-slim`, then git, ca-certificates and curl from apt, then `pnpm@11.18.0`. forge-lite's `package.json`, `pnpm-lock.yaml` and `pnpm-workspace.yaml` are copied in and installed into `/opt/forge-deps`, and the lockfile's SHA-256 is recorded. Built `linux/amd64`. |
| Repo | `keel-spike-04/forge`: `fixtures/forge-lite` on `main`, plus two branches from it. `agent-a` is base + `scenarios/s1/a.patch` (`ce1f0aa`), `agent-b` is base + `scenarios/s1/b.patch` (`0f0f23d`). Seeded by `scripts/seed.sh` with the token only in `http.extraHeader`. |
| Instance | `standard-2` (1 vCPU, 6 GiB, 12 GB disk), chosen in `start()`; `standard-1` and `standard-3` were also timed. |
| Driver | `scripts/drive.mjs` calls `POST /box/<name>/<method>` (guarded by a secret header), runs each experiment and writes redacted JSON to `spikes/04-tier2-container/results/` |
| Tooling | wrangler 4.149.0, pnpm 11.18.0, `@cloudflare/workers-types` 5.20261010.1, TypeScript 6. `CLOUDFLARE_ACCOUNT_ID` came from the environment and `account_id` is never in config. |

### Exact configuration and API

`wrangler.jsonc` (the keys that matter):

```jsonc
"compatibility_date": "2026-10-01",            // ctx.exports needs >= 2025-11-17
"artifacts": [{ "binding": "ARTIFACTS", "namespace": "keel-spike-04" }],
"containers": [{
  "class_name": "Tier2Box",
  "scheduling_policy": "durable_object",
  "images": { "base": { "dockerfile": "./container/Dockerfile" } }
}],
"durable_objects": { "bindings": [{ "name": "BOX", "class_name": "Tier2Box" }] },
"exports": { "Tier2Box": { "type": "durable-object", "storage": "sqlite" } }
```

Under this policy the container entry takes `images` (a map of named images, each with a `dockerfile`), not `image`. The DO class is declared with `exports` rather than `migrations`. **`max_instances` is rejected** (captured in `results/max-instances-rejected.txt`):

```
✘ [ERROR] Processing <scratch>/wrangler.jsonc configuration:
    - Unsupported fields for Durable Object-managed Containers in containers: "max_instances". Only "name",
      "class_name", "scheduling_policy", "images", "observability", "ssh", "authorized_keys", and restricted
      "unsafe" settings are supported.
```

That means the instance cap has to live in code. Here the driver enforces it: one or two containers at a time, and 10 only for the concurrency run. Running instances count against the account limits: 1,500 vCPU, 6 TiB memory and 30 TB disk.

The runtime API, all on `this.ctx.container` in `Tier2Box` (`src/index.ts`):

| Call | Use |
|---|---|
| `start({ image: container.images.base, enableInternet: false, instance: 'standard-2' })` | cold start from the image |
| `start({ containerSnapshot: { id }, enableInternet: false, instance })` | start from a snapshot |
| `interceptOutboundHttps('<acct>.artifacts.cloudflare.net', ctx.exports.ArtifactsEgress({ props }))` | the only egress. `props` carry `{ host, repoPath, token }`. It is re-registered with a freshly minted token before every verify. |
| `exec(['bash','-c',script,…], { env })` | every command; `output()` collects stdout, stderr and the exit code |
| `monitor()` (in `waitUntil`), `setInactivityTimeout(15 min)`, `destroy()`, `inspect()`, `snapshotContainer({ name })` | lifecycle |
| `env.ARTIFACTS.get('forge')` → `createToken('write', 600)` | minted in the DO; the plaintext lives only in the DO isolate and the intercept's props |

`ArtifactsEgress.fetch()` checks the host and the repo path prefix. It then forces `https:`, drops any incoming `Authorization`, sets `Authorization: Bearer <token>`, forwards with `fetch`, and stamps `X-Keel-Egress: injected` on the response. Anything else gets a 403.

The container trusts the intercept CA through `TRUST_SCRIPT` (`src/scripts.ts`), using the documented pattern:
- keep a pristine copy of the system bundle;
- wait up to 10 s for `/etc/cloudflare/certs/cloudflare-containers-ca.crt`;
- rebuild `/etc/ssl/certs/ca-certificates.crt` from the copy plus the CA.

git and curl read that bundle. Node never makes outbound calls here, so `NODE_EXTRA_CA_CERTS` is not needed.

## Results

Times are in ms, measured in the DO with `Date.now()` around each call unless noted. Phase times inside the container come from `date +%s%3N`.

### Numbers

| Measure | n | p50 | min–max | Source |
|---|---|---|---|---|
| Image size (uncompressed / `docker save \| gzip`) | – | 458 MB / 155 MB | – | `docker image inspect`, see the layer list below |
| First start after deploy (image not yet on the host) | 1 | 8,475 | – | first boot of the run (`readyAtMs`) |
| **Cold start, new instance, image cached** (`start` → first `exec` → CA trusted) | 6 | **572** | 423–787 | `results/cold.json` |
| ↳ to the first successful `exec` | 6 | 494 | 390–611 | ″ |
| ↳ client-observed (driver → Worker → DO → back) | 6 | 1,124 | 860–1,354 | ″ |
| **Restart** (same DO: `destroy()`, then `start()`) | 5 | **464** | 326–793 | `results/restart.json` |
| ↳ `destroy()` | 5 | 86 | 68–261 | ″ |
| **Snapshot start** (new DO, `containerSnapshot`) | 5 | **828** | 497–7,635 (the first restore was 7,635; the rest 497–841) | `results/snapshot.json` |
| ↳ `snapshotContainer()` | 1 | 5,629 | 1.1 MB snapshot | ″ |
| **Warm exec** (running instance, new `exec` of `true`) | 10 | **5** | 4–6 | `results/warm.json` |
| **Warm full verify** (clone + merge-tree + checkout + `pnpm test`) | 6 | **6,232** | 5,555–8,323 | `results/warm.json` |
| ↳ clone through the intercept | 6 | 523 | 432–779 | ″ |
| ↳ `git merge-tree --write-tree origin/agent-a origin/agent-b` | 6 | 4 | 3–5 | ″ |
| ↳ `commit-tree` + `checkout --detach` | 6 | 10 | 9–16 | ″ |
| ↳ dependencies (lockfile hash matches → symlink pre-baked `node_modules`) | 6 | 6 | 5–11 | ″ |
| ↳ `pnpm test --reporter=json` (`vitest run`) | 6 | 5,532 | 4,935–7,283 | ″ |
| Full verify on a snapshot-started instance | 3 | 11,113 | 8,605–13,835 | `results/snapshot.json` |
| Push of the merge commit through the intercept (`git push origin HEAD:refs/heads/keel/merged-a-b`) | 1 | 563 | – | `results/push.json` |
| **10 concurrent: new instance + full verify + destroy**, run 1 | 10 | wall **16,235** | verify p50 10,594 (5,918–14,941); ready p50 680 (539–4,922) | `results/concurrent-10-run1.json` |
| **10 concurrent**, run 2 | 10 | wall **16,399** | verify p50 7,080 (6,282–14,935); ready p50 570 (389–845) | `results/concurrent-10-run2.json` |

Every verify in every series produced tree `1b3d035527a235d807f9fe5f4bf08265872e4739` with `merge-tree` exit 0, which means clean. That is the same tree a local `git merge-tree --write-tree agent-a agent-b` (git 2.50) gives. All 44 verifies recorded in `results/` passed **214/214**, and so did the 3 smoke and push runs that are not in `results/`. The 44 are:
- warm: 6;
- snapshot: 4;
- concurrency: 20;
- instance types: 12;
- controls: 2.

The only failed verify was the intended `no-inject` control.

Image layers (`docker history`): Debian base 75 MB, Node 22.23.3 152 MB, apt git/ca-certificates/curl 103 MB, pnpm 38 MB, forge-lite `node_modules` 90 MB. The pnpm store is pruned after install, so pre-baked dependencies are served only by the lockfile-hash symlink.

### Suite timing per instance type (`results/instances.json`)

Each instance type got one new container. It ran the first verify (cold vitest), then 3 warm verifies, then 3 plain `./node_modules/.bin/vitest run` (default reporter) in the same checkout.

| Instance | vCPU (nproc) | Cold verify (cold test) | Warm verify p50 (test p50) | Plain `vitest run` p50 | vitest's own "Duration" | vCPU-s per warm verify |
|---|---|---|---|---|---|---|
| `standard-1` | ½ (1) | 8,038 (7,064) | 13,281 (12,265) | 13,700 | 12.90 s | ~6.6 |
| **`standard-2`** | 1 (1) | 6,237 (5,412) | **5,356** (4,636) | **4,271** | 3.87 s | **~5.4** |
| `standard-3` | 2 (2) | 5,897 (5,095) | 5,144 (4,582) | 4,116 | 3.72 s | ~10.3 |

`standard-1` got slower after its first run, about 2.5×, which looks like CPU-quota throttling at ½ vCPU. `standard-3` buys almost nothing, because vitest's own Duration (3.7–3.9 s) dominates and 75% of it is test time. **`standard-2` is the cheapest per suite.** The vCPU-s figures are allocation × wall, not measured CPU use.

For capacity on this account's limits, `standard-2` is 1 vCPU and 6 GiB:
- 1,500 vCPU allows 1,500 at once;
- 6 TiB of memory allows only **1,024**, so memory binds first.

A custom instance of 1 vCPU and 3 GiB (the minimum ratio) would reach the 1,500 vCPU cap at 4.5 TiB. That custom size is **untested**, including whether 3 GiB is enough for the suite.

### Against the `@cloudflare/ci` sandbox path (S15, live)

| Step | S15: `@cloudflare/ci` 0.2.0 on Sandbox 0.12.1 | S4: Containers DO API (`standard-2`) |
|---|---|---|
| Cold start | runner cold ≈ 5.8 s (checkout + `node --version` + backup through the R2 binding) | 0.57 s new instance to ready, + 0.5–0.9 s clone |
| Warm / chained | ≈ 6.6 s (restore snapshot + overlay source + command + backup) | 5 ms per new `exec`; **full verify 6.2 s p50**, including 214 tests |
| Dependencies | cold `npm ci` ≈ 4 s | 6 ms (lockfile-hash match → symlink into the image) |
| vitest | toy suite of 2 tests, `--reporter=json`, ≈ 26.5 s cold | forge-lite, 214 tests: 5.4 s cold, 4.6 s warm (`pnpm test --reporter=json`); 4.3 s plain `vitest run` |
| Reference: laptop / local amd64 emulation | 1.1–1.3 s / 4.5–5.6 s (an earlier local measurement) | local amd64 emulation of this image: 6.3 s for `pnpm test --reporter=json` |

The comparison is not like for like:
- S15's containers set no `instance_type`, so they ran wrangler's default (`lite`, 1/16 vCPU) per its config. That probably explains most of its 26.5 s. It was not re-measured here.
- S15's figures include its backup and snapshot machinery, which S4 does not use.

### Interception, egress and token absence (`results/controls.json`)

The container's own view of a fetch is in the `git ls-remote` trace below (`GIT_TRACE_CURL`, header lines). git sends no `Authorization`, the server answers 200, and the response carries the header that the egress entrypoint stamps:

```
=> Send header: GET /git/keel-spike-04/forge.git/info/refs?service=git-upload-pack HTTP/1.1
=> Send header: Host: <acct>.artifacts.cloudflare.net
<= Recv header: HTTP/1.1 200 OK
<= Recv header: X-Keel-Egress: injected
=> Send header: POST /git/keel-spike-04/forge.git/git-upload-pack HTTP/1.1
=> Send header: Host: <acct>.artifacts.cloudflare.net
<= Recv header: HTTP/1.1 200 OK
<= Recv header: X-Keel-Egress: injected
ls-remote exit=0 refs=4
```

The egress probe with the design configuration (`locked`: `enableInternet: false` plus the one HTTPS intercept):

```
https://example.com      rc=28  ms=10013  curl: (28) Resolving timed out after 10000 milliseconds 000
http://example.com       rc=28  ms=10014  curl: (28) Resolving timed out after 10000 milliseconds 000
https://registry.npmjs.org rc=28  ms=10013  curl: (28) Resolving timed out after 10000 milliseconds 000
https://1.1.1.1          rc=35  ms=66     curl: (35) Recv failure: Connection reset by peer 000
dns:example.com          rc=124 ms=10005
artifacts:this-repo      rc=0   ms=145    200
artifacts:other-repo     rc=0   ms=82     403
```

The token-absence checks (`CHECK_SCRIPT`) run inside the container after a verify. They grep for `art_v[0-9]+_` in each of these places:
- `env`;
- every `/proc/*/environ`;
- every `/work/*/.git/config`, also for `extraheader|authorization|bearer`;
- `~/.git-credentials`, `~/.gitconfig`, `/etc/gitconfig` and `~/.config/git/*`;
- `/tmp`;
- the whole filesystem (`grep -r -a`, excluding `/proc`, `/sys` and `/dev`; it takes about 3.4 s).

The DO then checks each hit against every token it minted for that container (3 of them). The token never goes into the container, so it can't be the search pattern there.

```
real token:  env=0  proc-environ=0  git-config=0  git-credentials=0  tmp=0  fs=1
             fs hit: /usr/local/bin/node:art_v2_strm   (a string in the node binary; not one of the minted tokens)
```

## Pass/fail

| # | Criterion | Result |
|---|---|---|
| 1 | Image: Node 22 + git + pnpm, forge-lite dependencies pre-baked, size recorded | **PASS**: Node 22.23.3, git 2.39.5, pnpm 11.18.0; 458 MB / 155 MB gz |
| 2 | Cold vs snapshot start | **PASS (measured)**. Snapshots exist on the GA API (public beta) but bring no speed-up for this workload: 828 ms vs 572 ms, and verify is not faster. Restart and warm were measured too. |
| 3 | Outbound intercept injects the token; egress otherwise off | **PASS**: clone, `ls-remote` and push all work with no credential in the container; every other host fails to resolve; another repo on the same host gets 403 |
| 4 | Token absent from env, `/proc`, `.git/config`, `~/.git-credentials`, `/tmp` and the filesystem | **PASS**: 0 hits that match a minted token |
| 5 | Clone + `merge-tree` + checkout + `pnpm test` | **PASS**: clean tree `1b3d0355…` (the local result), 214/214 |
| 6 | 10 concurrent | **PASS**: 10/10 twice, 16.2 s / 16.4 s wall, no capacity or scheduling errors |
| – | **Pass bar: injection works; warm p50 < 60 s** | **PASS**: 6.2 s |

## Can-fail demonstrations

Each check above was also run with its violation introduced, and each went red. All of these are in `results/controls.json`.

1. **Token checks find a planted token.** A fresh box was started with a canary `ARTIFACTS_TOKEN=art_v2_x_<canary>?expires=…`, a fake in the real token's shape, in its start env. The canary was also put in the exec env, `/tmp/canary-token`, `~/.git-credentials`, the clone's `.git/config` (`http.extraHeader`) and `/opt/planted/app.env`. The same checks then found it in every place:

   ```
   canary: env=1  proc-environ=2  git-config=1  git-credentials=1  tmp=1  fs=6   (every section: containsSecret=true)
   proc-environ: /proc/1/environ: ARTIFACTS_TOKEN=<token>…   /proc/215/environ: ARTIFACTS_TOKEN=<token>…
   fs: /opt/planted/app.env  /root/.git-credentials  /run/crun/cloudchamber/config.json  /tmp/canary-token
       /work/c/.git/config   (+ the node false positive)
   ```

2. **Injection is what authenticates.** A box was started with egress `no-inject`: the same intercept, but forwarding without a token. The clone then fails:

   ```
   <= Recv header: HTTP/1.1 401 Unauthorized
   <= Recv header: Www-Authenticate: Basic realm="artifacts"
   <= Recv header: X-Keel-Egress: no-token
   verify: {"phase":"clone","clone":128}  fatal: could not read Username for 'https://<acct>.artifacts.cloudflare.net': terminal prompts disabled
   ```

3. **Egress can be opened.**
   - `open-internet` (`enableInternet: true`): `https://example.com` returns 200, `http://example.com` 200 and `registry.npmjs.org` 200, and DNS resolves real addresses.
   - `open-intercept` (a passthrough `interceptOutboundHttps('*', …)` added): `https://example.com` returns 200 through the Worker, and DNS answers with the placeholder `fd00::119:1`. Plain `http://example.com` still times out, because `*` HTTPS does not cover port 80.

4. **The 60 s criterion was not driven to failure.** The closest run is `standard-1`: warm verify 13.3 s at ½ vCPU. The `lite` type (1/16 vCPU) was not run, so whether `lite` would breach 60 s is **untested**.

5. **Wrangler config:** the `max_instances` rejection is shown above. Lint (`oxlint -c oxlint.config.json src scripts`) was clean, and it reported 2 warnings on a deliberately bad file (since removed).

## Snapshots

The GA API does have them, in public beta:
- `ctx.container.snapshotContainer({ name })` captures the writable root filesystem, not memory or processes;
- `start({ containerSnapshot: { id } })` restores one;
- they are tied to the image they came from, have a 30-day TTL and exist only under the `durable_object` policy.

Observed behaviour:
- Snapshotting a box after one clone took 5.6 s and produced a **1.1 MB** snapshot (the writable-layer diff).
- The first restore took 7.6 s, likely the snapshot moving to the host; the next four took 0.50–0.84 s. A cold start from the cached image is 0.42–0.79 s, so the image is already as fast as a snapshot.
- Verify from a snapshot was not faster (8.6–13.8 s; the first vitest run in each container is cold either way).
- Snapshots land in the account's managed registry as `rootfs-snapshot-<hash>` tags beside a `rootfs-set-<hash>` tag (the prepared rootfs). They therefore show up in `wrangler containers images list` and are deleted with `wrangler containers images delete`. The Worker API cannot list them.

For ExecBox, a snapshot would only pay off when it captures something expensive the image can't bake in, such as a large pre-cloned repo that only needs `git fetch`. That case is **untested**.

## Gotchas

1. **The `durable_object` policy rejects `max_instances`.** A cap has to be enforced in code, for example by a gate DO that counts live boxes. Nothing on the platform stops a bug from starting 1,500 containers.
2. **`interceptOutboundHttps()` blocks until the container is up.** On the first boot after deploy, its `await` took 8.0 s of the 8.5 s. Register it right after `start()` and treat it as part of readiness.
3. **With `enableInternet: false`, unlisted hosts hang rather than fail.** DNS for non-intercepted names *times out*, so curl's 10 s timeout fired before any failure. Tools with long defaults, such as pnpm fetching the registry, would stall. A deny-all `*` intercept that returns 403 fast would fix that; it is **untested**, though the open-intercept control shows `*` registration works. HTTPS to a bare IP is reset, even with the internet on.
4. **`start({ env })` reaches disk.** Variables passed this way land in `/run/crun/cloudchamber/config.json` and `/proc/1/environ` (from the canary run). Never pass a credential through start env. The fallback, if ever needed, must use per-`exec` env, which is still visible in that process's `/proc/<pid>/environ`.
5. **`exec()` inherits only `PATH`.** It gets neither the start env nor the image `ENV`, so `HOME`, the git identity and so on are passed on each call (`BASE_ENV`).
6. **Version skew after a redeploy.** A DO whose container was running kept serving the *old* code for at least 20 s after `wrangler deploy` (`The RPC receiver does not implement the method "sh"`), while new DOs got the new code. Whether it ever switches while its container lives is **untested**. Keel must version its box RPC.
7. **The token-prefix grep has a false positive.** `art_v2_strm` is in the node binary, so a prefix grep alone can't fail a run. Compare against the actual minted tokens in the DO, as this spike does.
8. **Docker credentials on macOS.** `wrangler deploy`'s registry login failed with `error storing credentials … already exists in the keychain`, even with `DOCKER_CONFIG` pointing at a `{}` config. When `credsStore` is unset, the docker CLI picks `docker-credential-osxkeychain` from `PATH` by itself. The fix was a `PATH` holding only a `docker` symlink and no credential helper, plus `DOCKER_HOST` set to the local socket and `cli-plugins` symlinked for buildx.
9. **Concurrency tail.** Both 10-way runs had one or two boxes at about 13–15 s, against a p50 of 7–10.6 s, and it was the vitest phase that was slow, not scheduling. In run 1, four boxes took 3.5–4.9 s to start but then ran the fastest tests, which fits co-located boxes contending for one host. Plan capacity on the tail, not the p50.
10. **`interceptOutboundHttps('*')` covers port 443 only.** Port 80 needs `interceptAllOutboundHttp()` as well.
11. **`exec` runs as root.** Per the docs, under this policy every process has root's capabilities whatever `user` is set to. The VM is the isolation boundary, not the uid. This is relevant to running untrusted suites, and was not tested here.

## Fallback

The fallback is a short-lived token in env, for MergeBox only. **Not needed:** injection at egress works for both clone and push. If it is ever used:
- pass the token per `exec` (not in `start({ env })`, see gotcha 4);
- give it a TTL of 600 s at most;
- scope it to the one repo.

ExecBox never gets one.

## Untested

- **Image-pull cold start.** There were only n=1 observations: 8.5 s for the first boot after deploy and 7.6 s for the first snapshot restore. A changed image's first starts on hosts that have never seen it were not sampled.
- **The lockfile-mismatch path.** `pnpm install --offline` needs a store, and this image prunes it. A registry install would need the npm host added to egress.
- **Snapshots for incremental clones**, where a pre-cloned workspace only runs `git fetch`.
- **A deny-all `*` intercept for fast egress failure.**
- **A custom 1 vCPU / 3 GiB instance.**
- **The `lite` and `standard-4` instance types.**
- **Whether a running box's DO picks up new code** after a deploy.
- **The env-token fallback** (not needed).

## Teardown

All `keel-spike-04-*` resources were deleted. These listings were taken after the deletes:

```
$ wrangler delete keel-spike-04-tier2
Successfully deleted keel-spike-04-tier2

$ wrangler containers delete <app-id>            # keel-spike-04-tier2-tier2box, 0 live instances
Your container has been deleted

$ wrangler containers images delete keel-spike-04-tier2-tier2box-base:<tag>   # all three tags
Deleted keel-spike-04-tier2-tier2box-base:rootfs-set-b8bbddf1…   (sha256:2193b744…)
Deleted keel-spike-04-tier2-tier2box-base:rootfs-snapshot-10612e95…   (sha256:2193b744…)
Deleted keel-spike-04-tier2-tier2box-base:wrangler-mv2rlfp5   (sha256:cec8e0e8…)

$ wrangler artifacts repos delete forge --namespace keel-spike-04 --force
Deleted Artifacts repo "forge" from namespace "keel-spike-04".

$ wrangler deployments list --name keel-spike-04-tier2
✘ [ERROR] … This Worker does not exist on your account. [code: 10007]
$ wrangler containers list | grep -c keel-spike-04
0
$ wrangler containers images list | grep -c keel-spike-04
0
$ wrangler artifacts repos list --namespace keel-spike-04
No Artifacts repos found in namespace "keel-spike-04".
$ wrangler artifacts namespaces list | grep keel-spike-04
│ keel-spike-04         │ 0          │ 2026-10-10T19:01:50.473Z │ 2026-10-10T19:25:41.401Z │
```

Remainders:
- **The namespace `keel-spike-04`**, holding 0 repos, because wrangler has no namespace delete.
- **The snapshot's backing data.** The `rootfs-snapshot-*` registry tag is deleted and the Worker API has no snapshot delete. Whether removing the tag frees the stored snapshot, or it simply expires at its 30-day TTL, is **untested**.

Local Docker images were removed as well.
