# Spike 15 — wrapping `@cloudflare/ci`'s `CIWorkflow`

## Question

Can Keel's verification Workflow be `KeelVerify extends CIWorkflow` from
`@cloudflare/ci` 0.2.0 **unmodified**, or must Keel fork the package (Apache-2.0)
or call the Sandbox SDK directly? Decided against ADR 0007: untrusted candidate
code must never run under the base ref's cache scope, and no credential (including
the checkout token) may enter an untrusted runner.

Run against the live Cloudflare edge where possible.

## Setup

Two standalone Workers, one Artifacts namespace, two R2 buckets, live edge.

- **`keel-spike-15-verify`** owns the Sandbox DO classes and their containers
  (sandbox 0.12.1 image, `max_instances: 3`):
  - `KeelSandbox` — a one-method subclass of `CiSandbox`. By default it is
    `CiSandbox` verbatim; a `FORCE_LOCAL_BACKUP=1` switch routes backups through
    the `BACKUP_BUCKET` binding instead of presigned S3 URLs (see check-backup).
  - `KeelSandboxEgress` — `KeelSandbox` with `enableInternet = false`,
    `interceptHttps = true`, an `allowedHosts` allowlist, and static
    `outboundByHost` handlers (for the outbound-interception finding).
  - It exports the SDK's `ContainerProxy` (required for interception).
- **`keel-spike-15-ci`** contains `KeelVerify extends CIWorkflow` (engine
  unmodified) plus `KeelVerifyBundle extends KeelVerify` (overrides the public
  `static getProvider()` only), an HTTP trigger, bindings `ARTIFACTS`
  (namespace `keel-spike-15`), R2 `BACKUP_BUCKET`/`RESULTS`, a `LOADER`
  (Worker Loaders) for the Tier 1 step, and `SANDBOX` bound **cross-script** to
  `keel-spike-15-verify`'s `KeelSandbox` via `script_name`.
- **Fixture** `keel-spike-15/forge`: a tiny Hono + vitest project (package.json,
  package-lock.json, two passing tests), pushed over git with a repo-scoped
  write token (`wrangler artifacts repos issue-token`, token only ever in an
  `http.extraHeader`, never a URL). Several branches carry per-scenario commits.

Stack: pnpm + TypeScript, `.npmrc` → npm registry, `pnpm install --ignore-workspace`,
wrangler 4.149.0. `CLOUDFLARE_ACCOUNT_ID` passed at deploy via `--var`, never
committed; `account_id` never in `wrangler.jsonc`. Container `image` points at the
`Dockerfile` (`FROM docker.io/cloudflare/sandbox:0.12.1`).

Two config facts cost real time and are worth recording:

- The Artifacts binding key in wrangler 4.149 is **`artifacts`**, not
  `artifacts_namespaces`. The wrong key is silently dropped with only an
  `Unexpected fields` warning, leaving `env.ARTIFACTS` undefined; the first live
  run died with `Cannot read properties of undefined (reading 'get')`.
- `wrangler r2 object put/get` default to the **local** simulator. The source
  bundle had to be uploaded with `--remote` before the deployed Worker could read
  it (`r2 bucket create/list` are always remote, which masks the difference).

## Results per check

All six checks ran on the live edge. Backups ran through the local-R2 path
(`FORCE_LOCAL_BACKUP=1`), because the live container exposes `/dev/fuse` (see
below) so the stock SDK chose its presigned-S3 path, which needs R2 S3 keys we
do not have.

| # | Check | Result | Evidence |
|---|-------|--------|----------|
| 1 | Extra payload fields (`planId`,`worldId`) reach `pipeline()`'s `event.payload` | **PASS** | every run's `payload.json` carried `planId`/`worldId` unchanged |
| 2 | Cross-script `SANDBOX` DO binding runs a `ci.runner` | **PASS** | deploy bound `SANDBOX (KeelSandbox, defined in keel-spike-15-verify)`; runner exit 0, `node v22.22.3`, cold+warm both 0 |
| 3 | One instance mixes a Tier 1 `step.do` (`LOADER.get`, `globalOutbound: null`) and a Tier 2 `ci.runner` | **PASS** | `tier-mix.json`: `tier1.total=500500`, `tier2Exit=0`, both in one instance |
| 4 | Safe cache pattern / two scopes per instance | **PARTIAL / see fork #1** | install produced cache pointer under scope `refs/heads/scen-cache`; a 2nd instance at the same ref + same lockfile → `cache hit: reusing f7ff15e4…`; a changed lockfile → different key → cold `npm ci`. But `cacheScope` is fixed per instance. |
| 5 | Raw fake secret in logs | **PASS (secret survives raw)** | runner's `logs.stdout` (the `step.do` return Workflows persists) = `boundary FAKE-SECRET-123 boundary`; only my post-hoc R2 copy was `[REDACTED]`. Checkout token not reachable: `SOURCE_CONTROL_TOKEN` unset in the command env, `/workspace/.git/config` absent, `/proc/1/environ` has no token |
| 6 | Hydrate `/workspace` from an R2 bundle, no checkout token, engine unmodified | **PASS via `getProvider()` seam — see fork #2** | stock provider with `sourceControlCredentials:false` still git-checks-out with a token; the `getProvider()` override returning `{kind:'archive',url}` hydrated from the R2 bundle (`scenario-cache.marker` present, i.e. archive content, not the git sha), `scm-token:[unset]`, no token env |

### Check 1 — payload passthrough

`CIWorkflow.run()` forwards a payload that already has a `provider` key straight
through to `pipeline()`. `KeelVerify.pipeline` read `payload.planId` /
`payload.worldId` and persisted them. Every scenario's `payload.json` shows the
extra fields intact beside `ref`/`sha`/`owner`/`repo`/`providerData`.

### Check 2 — cross-script SANDBOX

Cross-script DO binding is possible; **no co-location was needed**. Deploy output:

```
env.SANDBOX (KeelSandbox, defined in keel-spike-15-verify)   Durable Object
```

The default `runner` scenario started a `ci.runner` that executed in the
cross-script sandbox:

```
runner.json: { coldExit: 0, coldStdout: "v22.22.3\ncold-ok\n",
               warmExit: 0 }
```

### Check 3 — Tier-1 + Tier-2 in one instance

```
tier-mix.json: { tier1: { tier1: true, total: 500500 }, tier2Exit: 0 }
```

The Tier 1 step used `LOADER.get(..., { globalOutbound: null })` (no network) for
a trivial sum; the Tier 2 step was a `ci.runner` running `npm ci && vitest`. Both
landed in the same Workflow instance.

### Check 4 — cache scope (fork reason #1)

Observed on the live edge:

- Trusted install (`cache: { inputs: ['package-lock.json','package.json'] }`)
  produced a snapshot + R2 cache pointer, key
  `e2246a44…`, scope `refs/heads/scen-cache`, 37 MB.
- A **second instance** (different sha) started with the **same ref** and the
  **same lockfile** → `installStdout: "cache hit: reusing
  f7ff15e4-e25b-4f17-8f1e-04e87cc7c5e8"`, identical key and `createdAt`. This is
  exactly the cache-poisoning mechanism: the scope is `payload.ref`, chosen by
  the caller, and any run under a given ref shares that ref's writable cache. A
  candidate allowed to run with `ref = refs/heads/main` would publish into the
  base cache. (Demonstrated only with harmless marker/lockfile files.)
- A **changed lockfile** under the *same* ref scope → different key
  (`5406fb18…`) → **cache miss** → cold `npm ci` ("added 39 packages in 4s").
  So lockfile tampering cannot hit the base snapshot; the key folds in the blob
  SHAs of the cache inputs.

**Key question — can one `CIWorkflow` instance use two cache scopes or chain
across scopes?** No. In `ci-workflow.ts` the run context sets `cacheScope: p.ref`
once for the whole instance; every runner (independent or chained) inherits it.
Chaining passes a *snapshot handle* in-instance but never changes the scope, and
across instances a snapshot is only rediscoverable through the deterministic
cache pointer (keyed by scope + command + lockfile blobs), not handed over
directly. The ADR-0007 safe pattern needs a **trusted install under the base-ref
scope** and the **candidate chained under its own ref scope** — two scopes in one
lineage. That is impossible unmodified. **Fork reason #1 confirmed.**

### Check 5 — logs

The `echo-secret` runner emitted a fake secret. The runner's `logs.stdout` — the
value returned from inside `step.do`, which Workflows persists as step output —
contained the secret **raw**:

```
logs-raw-from-pipeline.json: "boundary FAKE-SECRET-123 boundary\n
  token-env:[unset]\ngit-config:\n\nenviron-dump:\n"
```

The package only redacts provider notification previews and failure messages
(`withStepNotification`/`redactPreview`), never `CiRunnerResult.logs`. A pipeline
can redact before writing its own copy to R2 (`logs-redacted-r2.json` shows
`[REDACTED]`), but it cannot unwrite the raw string already persisted as the
step's output. Can-fail: the two artifacts differ only in the secret, so the
redactor demonstrably changes the value when it runs — and demonstrably is not
applied to the persisted runner logs.

Checkout-token reachability (all negative, good): `SOURCE_CONTROL_TOKEN` is
`unset` in the command process (it is scoped to the checkout `exec` only);
`/workspace/.git/config` does not exist (checkout tars with `--exclude=.git`);
`/proc/1/environ` carries no token/secret/auth var. The token still enters the
*container* transiently as the checkout exec's env and on the `git fetch` command
line, before the candidate command runs — so "no credential in the untrusted
runner's env" holds for the command, but the token does touch the shared
container during checkout.

### Check 6 — hydrate without a token (fork reason #2)

With the **stock** provider, `sourceControlCredentials: false` does **not**
disable checkout — it only suppresses the `ARTIFACTS_REMOTE`/`ARTIFACTS_TOKEN`
*command* env. `getSourceCheckout` still mints a one-hour token and the sandbox
runner still does a tokened `git fetch`; `/workspace` was populated from git.

But `CIWorkflow` exposes `static getProvider()` as a public override seam, and the
sandbox runner already supports a `{ kind: 'archive', url }` checkout
(`curl … | tar -xz`). `KeelVerifyBundle` overrides only `getProvider()` to return
a wrapped Artifacts adapter whose `getSourceCheckout` returns an archive URL
pointing at a content-addressed R2 bundle. Live result:

```
hydrate.json (bundle workflow):
  "scm-token:[unset]\n … -rw-rw-r-- … scenario-cache.marker … \nenv-tokens:\n"
```

`/workspace` holds the **archive's** content (`scenario-cache.marker`, from the
bundle) rather than the git sha's file (`scenario-hydrate.marker`), with no token
minted and no token env. So hydration from an R2 bundle with **no checkout token
entering the sandbox** is achievable with the **engine unmodified**, through the
sanctioned provider seam. **Fork reason #2 refuted** — the cost is a custom
`SourceControlAdapter` (which Keel writes anyway), not a fork.

Caveat: the bundle URL here is a public Worker route serving non-secret source.
For a presigned/authorized bundle or an internet-off runner, serve or authorize
the bundle through the egress interception proven below.

### Outbound interception (fork reason #3)

`KeelSandboxEgress` (`enableInternet=false`, `interceptHttps=true`, `allowedHosts`
allowlist, static `outboundByHost` handlers). Setting an allowlist/handlers
promotes the containers `ContainerProxy` to intercept-all mode and installs the
handlers with the proxy fetcher. Live probe:

```
example.com                 -> 520  (internet off, not allowlisted)
egress-probe.keel.internal  -> intercepted over HTTP *and* HTTPS
                               (handler returned our JSON; we can read/rewrite
                                the Authorization header)
registry.npmjs.org          -> 200  (allowlisted passthrough)
env: NODE_EXTRA_CA_CERTS, GIT_SSL_CAINFO, SANDBOX_INTERCEPT_HTTPS,
     CURL_CA_BUNDLE, SSL_CERT_FILE, REQUESTS_CA_BUNDLE  (HTTPS MITM CA installed)
```

So 0.12.1 **can** intercept outbound traffic — HTTP and HTTPS — with the internet
otherwise off, and a handler can inject a credential at egress (the
`*.artifacts.cloudflare.net` handler minted a read token and set the
`Authorization` header at the edge; the git-smart-http handshake through the MITM
needs more work but the interception and header injection themselves work).
**Fork reason #3 refuted.** Note: `outboundByHost` must be *assigned*
(`KeelSandboxEgress.outboundByHost = {…}`), not declared as a class field, or the
registry setter is bypassed.

### Backup path (incidental but decisive)

`/dev/fuse` is **present** on the live Cloudflare sandbox container
(`fuse-present`). The CI package picks its backup path from
`localBucket = (test -c /dev/fuse).exitCode !== 0`, so on the live edge it chose
the **presigned-S3** path, which requires real R2 S3 keys. We do not have them,
so the fully-stock live backup path is **untested on the edge**. A one-line
`CiSandbox` subclass forcing `localBucket: true` (routing through the
`BACKUP_BUCKET` binding) made every runner complete end to end without S3 keys.
This is a Sandbox-DO concern, independent of the `CIWorkflow` subclass question;
Keel owns its `CiSandbox` subclass regardless.

## Timings (live, incl. local-R2 backup)

| Metric | Value |
|--------|-------|
| Runner cold (container exec checkout + `node --version` + backup) | ~5.8 s |
| Runner warm / chained (restore snapshot + overlay source + command + backup) | ~6.6 s |
| Cold `npm ci` of the fixture inside the runner | ~4 s |
| `vitest run --reporter=json` of the fixture inside the runner | ~26.5 s (cold vitest, JSON reporter) |
| Snapshot create (37 MB node_modules, local R2) | folded into the warm figure |

The vitest JSON (2 tests, `success: true`) is saved at
`spikes/15-ciworkflow/results/forge-vitest-report.json` as the S14 Tier 2 parity
reference (no secrets).

## Fork reasons

- **#1 — one `CIWorkflow` instance cannot use two cache scopes / chain across
  scopes.** **Confirmed.** `cacheScope` is hard-wired to `payload.ref` per
  instance. Minimal fix: make `cacheScope` injectable per runner
  (`RunnerOptions.cacheScope`), or expose the snapshot handle so a trusted
  base-scope instance can hand its snapshot to a candidate-scope instance. Either
  is an engine change.
- **#2 — hydrate from an R2 bundle with no checkout token, engine unmodified.**
  **Refuted.** Achieved live via the public `static getProvider()` override +
  the sandbox's native `archive` checkout kind. No engine fork; a custom
  `SourceControlAdapter` suffices.
- **#3 — 0.12.1 cannot intercept outbound / inject credentials at egress with the
  internet off.** **Refuted.** HTTP and HTTPS interception both work under
  `enableInternet=false` + allowlist + static `outboundByHost`; handlers can
  rewrite the `Authorization` header.

## Go / no-go and recommendation

**Go — subclass, do not fork.** Five of six checks pass on the live edge with
`KeelVerify extends CIWorkflow` unmodified, and the two "expected fork" seams
(#2 bundle hydration, #3 egress interception) turned out to be reachable through
the package's own public extension points (`getProvider()`, the `archive`
checkout kind, the containers outbound API). The engine is a good fit.

The one genuine engine limitation is **fork reason #1**: cache scope is fixed per
instance, which blocks the ADR-0007 pattern of a trusted base-scope install
feeding a candidate running under its own scope. This does **not** justify forking
the whole package. Recommended path:

1. `KeelVerify extends CIWorkflow`, `KeelSandbox extends CiSandbox` (local-backup
   switch until real R2 S3 keys exist), `KeelSandboxEgress` for intercepted
   egress, a custom `SourceControlAdapter` via `getProvider()` that hydrates
   candidates from content-addressed R2 bundles (no checkout token).
2. For the two-scope cache: **do not run the candidate under a cached scope at
   all.** Run the trusted install in its own instance/scope and hand its snapshot
   to the candidate as a pre-staged bundle (the check-6 mechanism), so the
   candidate never touches a writable cache. This sidesteps #1 without an engine
   change. Only if snapshot-handoff proves too slow should #1 be revisited as a
   minimal upstream patch (injectable `cacheScope`), kept as a thin fork with
   LICENSE/NOTICE retained.
3. Treat `CiRunnerResult.logs` as raw: redact in the pipeline before persisting
   anywhere Keel controls, and never surface a runner's own `logs` to an
   untrusted consumer without redaction (check 5).

Sandbox 1.0 direct is not needed: 0.12.1 via `@cloudflare/ci` covers the
requirements, and dropping to the raw SDK would discard the Workflow durability,
snapshot lineage, and cache machinery this spike exercised for free.

## Fallback taken

None of the local-`wrangler dev` fallback was needed; all six checks ran live.
The only item **untested on the edge** is the fully-stock (presigned-S3) backup
path, because the live container has `/dev/fuse` and we lack R2 S3 keys; it was
exercised through the local-R2 binding path instead.

## Teardown

See the teardown listing at the end of this document / the spike's final report:
all `keel-spike-15-*` Workers, containers, Workflows, the R2 buckets, and the
`keel-spike-15/forge` repo were deleted, with a listing showing none remain.
