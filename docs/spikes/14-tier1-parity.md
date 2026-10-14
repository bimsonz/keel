# S14: Tier 1 test parity

Run on 2026-10-10 against the live edge. The Worker was served from the LHR and CDG colos, and Durable Objects were placed by the platform. Code is in [`spikes/14-tier1-parity/`](../../spikes/14-tier1-parity/), and raw results are in `spikes/14-tier1-parity/results/`.

## Answer

**NO-GO for Tier 1 as the primary test runner. GO for Tier 1 running probes.**

- **Parity holds.** Every world matches per test across three runners:
  - Tier 1, meaning worker-bundler, then `LOADER.get`, then a vitest shim on the real `@vitest/expect` 5;
  - `vitest run` in Node;
  - `vitest run` in the Cloudflare sandbox container image.
- **The probe outcome (pass / fail / n/a) matches in every world.** It also matches the fixture's own `run-probe.mjs` and the expected matrix in `worlds.sh`.
- **Latency fails the criterion.** A cold forge-lite suite run has a p50 of 0.77–1.5 s at concurrency 1. Warm p50 is 253–449 ms across two samples, with p95 at 1.7–2.3 s.
- **Concurrency doesn't help.** Isolates from one DO share its CPU, so 10 concurrent cold runs in one DO have a p50 of 10.4 s. 100 runs across 10 DOs take 23 s.
- **Warm isolates aren't parity-safe.** A warm re-run reuses module state.
- **Memory breaches are silent.** A test run whose isolate holds 250 MiB comes back with all tests passing, HTTP 200, and tail outcome `ok`. The isolate is thrown away afterwards and nothing tells the host. So "never over 128 MB" can't be checked from platform outcomes, and the runner would need its own guard.
- **CPU limits aren't enforced at first.** A fresh isolate gets two over-limit invocations before `cpuMs` is enforced.

**Fallback taken:** ExecBox (container) is the primary test runner. Tier 1 runs probes only. The probe bundle alone (465 KB) runs cold at a p50 of 107 ms and warm at 8 ms, with about 31 ms CPU.

## Question

Do forge-lite and its tests run correctly in Tier 1, via `@cloudflare/worker-bundler` and then `LOADER.get`, compared with a normal `vitest run`? Measure on the edge at 10 per DO and at 100 across DOs, and also typecheck inside an isolate.

Pass criteria:
- 100% parity of per-test status;
- warm p50 < 300 ms;
- never over 128 MB.

## Setup

**Host Worker `keel-spike-14-verify`** ([`src/index.ts`](../../spikes/14-tier1-parity/src/index.ts)). It has:

- a `LOADER` binding;
- `VerifierDO`, a SQLite Durable Object;
- the R2 bucket `keel-spike-14-bundles`;
- a `TailCollector` entrypoint, passed to every child as `tails: [ctx.exports.TailCollector(...)]`, which stores `outcome`, `cpuTime`, `wallTime`, exceptions and console logs per child request.

Every child gets `globalOutbound: null` and `limits: { cpuMs: 30000, subRequests: 5 }`. Endpoints:

- `/bundle`: bundles a JSON file map and stores it in R2;
- `/run`: N runs of a bundle in one DO, cold (a new id each run) or warm (one id), at concurrency C;
- `/fanout`: the same across M DOs;
- `/direct` and `/do-limit`: the concurrency-limit probes;
- `/hog`: a memory hog child;
- `/counter`: warm-hit probe;
- `/typecheck`;
- `/tails`;
- `/objects`: teardown.

Requests need a per-spike token header.

**Bundling** ([`src/bundle.ts`](../../spikes/14-tier1-parity/src/bundle.ts)):

- `installDependencies` runs once per bundle. It installs the project's `dependencies` plus the shim's: `@vitest/expect@5.0.3`, `@vitest/spy@5.0.3`, `@vitest/utils@5.0.3` and `chai@^6.2.2`.
- `createWorker` then runs once per test file with `virtualModules: { vitest: 'export * from "/__keel/shim.js"' }`.
- Each test file becomes its own self-contained module `f<i>.js` with its own module graph, the way vitest's default `isolate: true` gives each file a fresh graph.
- A generated `main.js` imports them in turn and returns `{ results: [{ file, name, status, error? }], instance, served }`.
- An `isolate: false` mode builds one bundle with a shared module graph, for comparison.

**The vitest shim** ([`src/child/vitest-shim.js`](../../spikes/14-tier1-parity/src/child/vitest-shim.js)). `expect` is the real `@vitest/expect` 5 with chai 6, wired as vitest 5's own `createExpect` wires it. That includes `JestExtend`, `JestChaiExpect`, `ChaiStyleAssertions`, `JestAsymmetricMatchers`, `customMatchers`, `expect.assertions`/`hasAssertions`, `soft`, and the "not awaited" check on `.resolves`/`.rejects`.

The runner re-implements:
- lazy collection, with async `describe` support;
- vitest's `interpretTaskModes` for `.only`/`.skip`/`.todo`;
- `.each`, `.for`, `skipIf` and `runIf`;
- vitest's `formatTitle`, on `@vitest/utils`;
- hooks, with `beforeEach` teardown returns and stack order for the after-hooks;
- timeouts, `retry`, `repeats` and `fails`;
- `onTestFinished` and `onTestFailed`;
- `vi.fn`, `vi.spyOn` and `vi.stubGlobal`, via `@vitest/spy`.

Not supported, and they throw: snapshots, fake timers, `vi.mock`, `expect.poll` and `test.extend`.

**`@vitest/expect` worked first time.** It bundled with esbuild-wasm inside the host and ran in workerd, so no minimal-expect fallback was needed.

**Projects:**
- `toy/` (27 tests): a Hono app with `.each` (array and template-table), `.skip`, `.todo` and `.only`. It also has:
  - hook order;
  - module state;
  - spies and asymmetric matchers;
  - one deliberate failure;
  - one un-awaited `.resolves`;
  - one `expect.assertions` failure.
- `fixtures/forge-lite` as committed at `e7834f9`: 200 tests in base and 214 in A+B. The fixture was copied into scratch and the patches applied there.
- `memtest/` (22 tests): allocation cases for the memory checks.

**References:**
- **Node**: `vitest run --reporter=json` with Node 22.22.3 on a laptop.
- **Tier 2 (ExecBox reference)**: [`scripts/tier2-docker.sh`](../../spikes/14-tier1-parity/scripts/tier2-docker.sh), under local Docker, `--platform linux/amd64`, image `docker.io/cloudflare/sandbox:0.12.1`. That is the image the live CIWorkflow runner used, with Node v22.22.3 on x86_64. pnpm 11.18.0 is bootstrapped with npm inside the container, because the image has no pnpm. The early toy and partial-fixture runs used `node:22` (amd64) and gave the same toy result.

Tooling: wrangler 4.149.0, `@cloudflare/worker-bundler` 0.2.6, `@cloudflare/workers-types` 5.20261008.1, vitest 5.0.3, TypeScript 6.0.3 (host) and esbuild 0.28.2 (typecheck child build only). The compatibility date is `2026-10-01`.

```sh
pnpm install --ignore-workspace
pnpm exec wrangler r2 bucket create keel-spike-14-bundles
pnpm exec wrangler deploy
printf %s "$TOKEN" | pnpm exec wrangler secret put SPIKE_TOKEN
node scripts/build-typecheck-child.mjs <dir>
pnpm exec wrangler r2 object put keel-spike-14-bundles/tc/typecheck-child.js --file <dir>/typecheck-child.js --remote
pnpm exec wrangler r2 object put keel-spike-14-bundles/tc/ts-libs.json --file <dir>/ts-libs.json --remote
BASE=https://keel-spike-14-verify.<subdomain>.workers.dev TOKEN=... scripts/worlds-parity.sh <fixture> <work> <node_modules> w2
```

## Results: parity

`scripts/worlds-parity.sh` builds each world from the fixture plus patches. It runs the suite and the probe in Node, in the sandbox container and in Tier 1, and diffs per-test status keyed by `file :: describe > … > test`. Output is in `results/worlds/table.txt`, with per-world detail beside it:

```
world            tests   node-vs-tier1          docker-vs-tier1        node-vs-docker         run-probe p.node   p.docker p.tier1
base             200     identical 200/200 m=0  identical 200/200 m=0  identical 200/200 m=0  n/a      n/a      n/a      n/a
A                207     identical 207/207 m=0  identical 207/207 m=0  identical 207/207 m=0  pass     pass     pass     pass
B                207     identical 207/207 m=0  identical 207/207 m=0  identical 207/207 m=0  n/a      n/a      n/a      n/a
A+B              214     identical 214/214 m=0  identical 214/214 m=0  identical 214/214 m=0  fail     fail     fail     fail
A+B+Bp           214     identical 214/214 m=0  identical 214/214 m=0  identical 214/214 m=0  pass     pass     pass     pass
A+B+Bp+careless  214     identical 214/214 m=0  identical 214/214 m=0  identical 214/214 m=0  fail     fail     fail     fail
```

- `run-probe` is the fixture's `scenarios/run-probe.mjs`, exiting 0, 1 or 3.
- `p.*` is the probe run through `vitest --config scenarios/vitest.probe.config.ts` in each runner, mapped the same way: a pass is `pass`; a failure whose message carries `probe not applicable:` is `n/a`; any other failure is `fail`.
- Tier 1 also captured the probe's own observations through the tail logs. For A+B: `[probe] bob DELETE /repos/alice/forge -> 204 (expected 403)`, the same line `run-probe.mjs` prints.
- All suites are green in every world, so suite parity is all-pass against all-pass. The probe is where the worlds differ, and it agrees everywhere.

The toy, which mixes pass, fail, skip and todo, is identical in Tier 1 on the edge and locally, compared with both Node and the sandbox image:

```
node scripts/s14.ts parity node.json toy-edge.json   ->  {"nodeTests":27,"tier1Tests":27,"node":{"pass":21,"fail":3,"skip":3},"tier1":{"pass":21,"fail":3,"skip":3},"identical":true}
```

The three toy failures are each reproduced with vitest's own message:
- `expected 404 to be 410 // Object.is equality`;
- `Promise returned by \`expect(actual).resolves.toHaveLength(expected)\` was not awaited…`;
- `expected number of assertions to be 2, but got 1`.

The `.only` sibling is skipped, `.todo` is skipped, and the `.each` titles match, for example `rejects {"name":"nut","qty":2.5} with 400` and `slugify(  trim me  ) -> trim-me`.

Where parity breaks:

| Case | Node | Tier 1 | Why |
|---|---|---|---|
| Toy, shared module graph (`isolate:false`) | `module state > sees a fresh module graph per file`: pass | fail | One graph across files means module-level state leaks between files. Per-file bundles fix it. forge-lite has no such state, and its shared-graph bundle is identical (200/200). |
| Toy, **warm re-run** of the same isolate | — | 3 tests change status (`hook order > first`, `> second`, `module state …`) | ESM modules can't be re-evaluated, and `eval`/`new Function` are disallowed, so a warm run re-executes already-collected tests over live module state. forge-lite's warm runs kept one digest. |
| memtest `ab-single`: one `new Uint8Array(200 MiB)` | pass | fail: `RangeError: Invalid typed array length: 209715200` | workerd refuses a single typed array of that size. |

## Results: latency and CPU (edge)

Wall times are host-measured per suite run around `getEntrypoint().fetch()`. Inside workerd, `Date.now()` and `performance.now()` advance only on I/O, so the host brackets each child call with a `caches.default.match()` to read a current clock.

**Clock caveat.** A first version used `performance.now()` alone inside the DO. It reported 24 ms for a hog that took about 4 s by tail and client clock. A differential check from the client agreed with the bracketed host times to within about 15%: (n=11 total − n=1 total) / 10 gave cold 0.90 s/run and warm 0.54 s/run.

**Tail CPU caveat.** Tail `cpuTime` for CPU-heavy suites is often *larger* than the host-observed wall time. For example, the shared-graph warm run had host p50 229 ms and tail CPU p50 450 ms. It's calibrated for trivial children (a 300 ms sleep gives tail wall 300 and CPU 0), so it likely includes off-thread work such as GC or compilation. Treat it as an upper bound.

**forge-lite base, per-file isolation (8 modules, 3.65 MB):**

| Run | n | p50 | p95 | tail CPU p50 | Outcomes |
|---|---|---|---|---|---|
| c=1 cold (sample 1) | 20 | 1535 ms | 3199 ms | 1241 ms | 20 ok |
| c=1 cold (sample 2, committed base) | 30 | 765 ms | 2497 ms | 686 ms | 30 ok |
| c=1 warm (sample 1) | 20 | 449 ms | 2337 ms | 843 ms | 21 ok |
| c=1 warm (sample 2) | 30 | **253 ms** | 1703 ms | 463 ms | 31 ok, served 2..31 (all warm hits) |
| c=4 cold, one DO | 20 | 2631 ms | 3961 ms | 620 ms | 20 ok |
| c=10 cold, one DO | 30 | 10424 ms | 14527 ms | 948 ms | 30 ok |
| c=10 warm, one DO (same id) | 30 | 6948 ms | 8740 ms | 924 ms | 31 ok |
| 100 across 10 DOs (10 each at c=10), cold | 100 | 7212 ms | 14742 ms | 790 ms (p95 1610) | 100 ok, 1 digest, 23.4 s total |

**forge-lite base, shared module graph (1 module, 0.50 MB):**

| Run | n | p50 | p95 | tail CPU p50 |
|---|---|---|---|---|
| c=1 cold | 20 | 352 ms | 1496 ms | 515 ms |
| c=1 warm | 20 | 229 ms | 1854 ms | 450 ms |
| c=10 cold, one DO | 30 | 4286 ms | 7117 ms | 591 ms |
| 100 across 10 DOs, cold | 100 | 6526 ms | 14799 ms | 818 ms (24.3 s total) |

**Toy (4 modules, 1.53 MB) and probe:**

| Run | n | p50 | p95 | tail CPU p50 |
|---|---|---|---|---|
| toy c=1 cold | 20 | 122 ms | 157 ms | — |
| toy c=1 warm (not parity-safe) | 20 | 1 ms | 4 ms | — |
| toy c=4 / c=10 cold, one DO | 20 / 30 | 409 / 1961 ms | 518 / 3104 ms | — |
| toy 100 across 10 DOs | 100 | 970 ms | 1630 ms | — (3.1 s total) |
| **probe alone (world A, 465 KB) cold** | 20 | **107 ms** | 129 ms | 31 ms |
| **probe alone warm** | 20 | **8 ms** | 15 ms | 5 ms |

Throughput, cold forge-lite:

| Setup | Runs/s |
|---|---|
| One DO at c=1 | 0.5–0.9 |
| One DO at c=10 | 0.82 |
| 10 DOs | 4.3 |

**Children of one DO add no CPU parallelism**, and 10 DOs gave about 5×, not 10×.

For context:
- **Node** `vitest run` of forge-lite takes 1.09–1.30 s wall for the whole command on a laptop. The sum of per-test durations is 623 ms.
- **The sandbox container** `vitest run` takes 4.5–5.6 s per world, excluding install and under amd64 emulation.
- **S15's live ExecBox runner** measured about 26.5 s cold `vitest run` for a 2-test toy, and about 4 s for `npm ci`.

## Results: bundling (edge)

Timed inside the host with the I/O-advanced clock. "Client" is the end-to-end request seen by curl and includes the upload and the R2 put.

| Bundle | Test files | Size | npm install | esbuild | Client total |
|---|---|---|---|---|---|
| toy, per-file | 4 | 1.53 MB | 277–366 ms | 1.87–5.34 s | 4.1–7.7 s |
| forge-lite base, per-file | 8 | 3.65 MB | 265–371 ms | 6.7–12.4 s (4 builds) | 9.5–14.5 s |
| forge-lite worlds A … careless, per-file | 9–10 | 4.13–4.61 MB | 219–393 ms | 3.1–7.0 s | — |
| forge-lite base, shared graph | 8 | 0.50 MB | 397 ms | 1.48 s | 3.9 s |
| probe alone | 1 | 465 KB | 259 ms | 293 ms | 2.5 s |

- **Cached:** loading a bundle back from R2 and parsing it took 132–456 ms for forge-lite and 63–136 ms for the toy. A DO's first load took 109–702 ms; after that the bundle comes from DO memory at 0 ms.
- **Install** fetches 12 packages from the npm registry each time. worker-bundler does no caching unless `DurableObjectKVFileSystem` is used, and that wasn't tried.
- **Per-file isolation costs about 5–8× the esbuild time** of a shared graph. Each file re-bundles hono, chai and `@vitest/expect`, about 360 KB of the 460 KB per module. worker-bundler 0.2.6 exposes one entry point per build.
- **Local `wrangler dev`, toy:** install 426 ms, esbuild 1425 ms. Local numbers don't count.

## Results: concurrency limits (edge)

Sleeper children hold for 800 ms (`results/limits/`):

```
POST /direct (Worker request)     k=4 -> 4 ok
                                  k=5 -> 4 ok, #4 fails after 0 ms:
  Error: Dynamic worker concurrency limit exceeded: each request may have up to 4 concurrent dynamic worker invocations. Wait for one to finish before starting another.
                                  k=8 -> 4 ok, 4 fail (same error)
                                  k=8, same id -> 8 ok
POST /do-limit (inside one DO)    k=10 -> 10 ok
                                  k=11 -> 10 ok, #10 fails after 11 ms:
  Error: Dynamic worker concurrency limit exceeded: each request may have up to 10 concurrent dynamic worker invocations. Wait for one to finish before starting another.
                                  k=30, same id -> 30 ok
```

- **Both limits are confirmed:** 4 per Worker request and 10 per DO.
- **The 5th or 11th call is rejected at once** with a thrown `Error`. It isn't queued.
- **In-flight requests to the same id count once.**
- **Local `wrangler dev` enforces neither:** 6 in a Worker request and 12 in a DO all succeeded.

## Memory and reuse

**Hog child, no test harness.** It allocates N × 1 MiB JS double arrays, all live:

| Case | Edge | Local `wrangler dev` |
|---|---|---|
| 50 MiB | ok | — |
| 200 MiB | **ok** (tail `ok`, CPU 3501 ms) | ok |
| 200 MiB, held 2 s | ok | — |
| 250 / 300 / 350 / 400 MiB | `Error: Worker exceeded memory limit.`, tail `exceededMemory` | 400 MiB ok |
| 100 MiB per call kept on `globalThis`, 4 calls to one id | all ok. Call 3 saw 200 chunks; call 4 saw 100, because the isolate had been replaced. | — |

**Inside a test run (`memtest/`).** Each case is its own bundle, run through the normal `/run` path in a DO as warm with n=2: three requests to one id. Results are in `results/memory/`.

| Case (allocation inside tests) | Host sees | Results | Tail outcome | Isolate afterwards |
|---|---|---|---|---|
| `js-single`: one `new Array(26M).fill(0.5)`, 200 MiB | HTTP 200 | 2/2 pass | ok ×3 | survived one more request, then replaced |
| `ab-single`: one `new Uint8Array(200 MiB)` | HTTP 200 | 1 pass, **1 fail** (`RangeError: Invalid typed array length: 209715200`) | ok ×3 | reused |
| `wasm-single`: one `WebAssembly.Memory` grown to 200 MiB in one `grow` | HTTP 200 | 2/2 pass | ok ×3 | **replaced after every run** |
| `js-multi`: 5 tests × 50 MiB JS, retained (250 MiB) | HTTP 200 | 5/5 pass | ok ×3 | **replaced after every run** |
| `ab-multi`: 5 tests × 50 MiB `Uint8Array`, retained | HTTP 200 | 5/5 pass | ok ×3 | **replaced after every run** |
| `wasm-multi`: 5 × 50 MiB `grow` | HTTP 200 | 5/5 pass | ok ×3 | **replaced after every run** |
| `js-multi-big`: 8 tests × 100 MiB JS, retained (800 MiB) | `Error: Worker exceeded memory limit.` (50–395 ms) | none | `exceededMemory` ×3 | — |

**A test run over 128 MB comes back as a silent `ok` with results.** That held for 200–250 MiB in JS heap, ArrayBuffers and Wasm memory, in one allocation or several. HTTP is 200, every test passes, and the tail outcome is `ok`. The only trace is that the isolate is discarded afterwards.

A hard error appears only well above the limit. It showed at ≥ 250 MiB allocated in one synchronous burst, or 800 MiB retained, and then the whole run is lost and no per-test results come back. One large `Uint8Array` fails synchronously with a `RangeError` in that one test, which is itself a parity break against Node.

**Nothing in workerd shows heap size:**

```
[env] {"performanceMemory":"undefined","processMemoryUsage":"function","gc":"undefined",
       "before":{"rss":0,"heapTotal":0,"heapUsed":0,"external":0,"arrayBuffers":0},"afterJs":{"rss":0,"heapTotal":0,...
```

`process.memoryUsage()` exists but returns zeros before and after allocating 64 MiB of each kind.

A runner that wanted Tier 1 for suites would need its own guard and an explicit `exceeded-memory` outcome. The candidate mechanisms, none of them complete:

1. **Post-run instance check.** This is what `main.js` now returns: `instance` and `served`. After a run, ping the same id from the DO. A fresh `instance` (`served: 1`) means the isolate was discarded, and the run would be marked `exceeded-memory (suspected)`. Warm hits in a DO are 29/29 otherwise, so the signal is strong. It's lagging, though: `js-single` survived one more request first.
2. **Wrap allocation in the shim.** Cap the `WebAssembly.Memory` constructor's `maximum` and `grow`, and count `ArrayBuffer`/typed-array bytes. This catches explicit Wasm and ArrayBuffer use. It doesn't catch Wasm memory declared inside a module, or the JS heap.
3. **Run suites only where the limit is reported:** a container.

**Warm-hit rate for the same id.** `/counter` returns a per-isolate random id and a request count. There were 30 separate client requests per path (`results/memory/warmhit-*`):

```
worker  requests 30 distinct isolates 14 warm hits (served>1) among requests 2..N: 13/29 errors 4
do      requests 30 distinct isolates 1  warm hits (served>1) among requests 2..N: 29/29 errors 0
```

The 4 errors on the stateless path came from host isolates still running the previous deploy during rollout. That version generated the id at global scope, which workerd refuses. Within one DO request the warm runs above also hit every time (served 2..31). This agrees with S18, which saw 1/6 through a stateless host and 80/80 through a DO. **Warm reuse needs a DO.**

## Results: CPU limit

- **Cold:** `limits.cpuMs: 50` on the forge-lite suite, two runs with fresh ids. Both returned 200/200 pass, and the tail showed `ok` at 1587 and 1544 ms CPU. Not enforced.
- **Warm:** the same with one id, 13 requests:

```
["ok","ok","Error: Worker exceeded CPU time limit.", … ×11]
tail: {"ok":2,"exceededCpu":11}  cpu ms: 1024, 601, 523, 50, 50, 50, …
```

**An isolate gets about two over-limit invocations before `cpuMs` bites.** After that it is enforced exactly (50 ms). This matches the documented "built-in flexibility" per isolate. With a fresh id per run, which parity requires, a custom CPU limit is effectively never enforced on the first runs.

## Results: typecheck inside an isolate

[`child-src/typecheck-entry.js`](../../spikes/14-tier1-parity/child-src/typecheck-entry.js) wraps `@cloudflare/worker-bundler/typescript` (TypeScript 6.0.2 browser build). It is pre-bundled with esbuild into one 5.2 MB module, loaded from R2 and run in its own child.

- The host installs `hono` type files (192 files) with `installDependencies` and passes them with the sources.
- TypeScript's `lib.*.d.ts` files arrive one of two ways:
  - **`r2` mode:** 107 files, 3.9 MB, from the local TypeScript 6.0.3;
  - **`fetch` mode:** as shipped. The child downloads the `typescript` tarball through a `globalOutbound` that is a host entrypoint allowing only `registry.npmjs.org`.
- Scope is `src/` only, because tests need vitest's types. That is forge-lite's tsconfig (`es2023` + `webworker`, strict, `exactOptionalPropertyTypes`, …) with `include: ["src"]`.

| Input | Child wall | Tail CPU | Result | Outcome |
|---|---|---|---|---|
| forge-lite src, r2 libs | 2.9 s, 3.1 s | 2159, 2117 ms | 26 roots, 277 source files, 0 errors | ok |
| forge-lite src + seeded error, r2 libs | 2.9 s, 6.4 s | 2134, 4506 ms | 1 error: `src/ids.ts:38 TS2322 Type 'string' is not assignable to type 'number'.` | ok |
| forge-lite src, fetch (as shipped) | 3.2 s | 2401 ms | 0 errors | ok |
| toy src, r2 / seeded / fetch | 2.2 / 2.5 / 2.3 s | 1509 / 1430 / 1662 ms | 0 / 1 (TS2322) / 0 | ok |

Local reference on the same scope:
- `tsc -p tsconfig.src.json` (7.0.2, the fixture's own) exits 0 in 0.15 s.
- TypeScript 6.0.3 exits 0 in 0.55 s, and on the seeded copy gives the same `src/ids.ts(38,14): error TS2322`.

There was no `exceededMemory`, but given the section above, an `ok` doesn't show the isolate stayed under 128 MB. The host-proxied `globalOutbound` worked without the host-call deadlock: the proxy awaits a real `fetch` while the child's call is pending.

## Pass/fail

| Criterion | Result | Evidence |
|---|---|---|
| 100% parity | **PASS** for forge-lite (6 worlds × 3 runners) and the toy. Probe outcomes agree in every world. | parity table above |
| Warm p50 < 300 ms | **FAIL** | Per-file warm p50 was 449 ms in one sample and 253 ms in the other. p95 was 1.7–2.3 s in both. Warm reuse isn't parity-safe for suites with module state, so the real Tier 1 mode is cold: 765–1535 ms per-file, 352 ms shared graph. Only the probe alone meets it: cold 107 ms, warm 8 ms. |
| Never over 128 MB | **Unverifiable; treated as FAIL** | None of the 454 tail records from forge-lite suite runs reported `exceededMemory`. But the platform returns `ok` with full results at 200–250 MiB, so "no exceededMemory" doesn't mean under 128 MB. |

## Go/no-go

**No-go** for Tier 1 as the primary test runner. Fidelity is fine. Speed at concurrency, unreported memory breaches and lenient CPU enforcement are not.

**Fallback taken:** ExecBox (container) is the primary test runner, and Tier 1 runs probes only. A probe is a single test file over pure functions or an in-memory app. It bundles to about 465 KB in about 0.5 s and runs cold in about 107 ms. Its outcome matched Node, the sandbox image and `run-probe.mjs` in all six worlds, including n/a.

## Design-relevant findings

1. **One DO is one CPU.** Dynamic Workers called from one DO add no CPU parallelism:
   - c=10 in one DO gave p50 10.4 s, against 0.77–1.5 s at c=1.
   - Fan-out across DOs scales sub-linearly: 10 DOs gave about 5×.
   - Scheduling probes means spreading them across DOs, not raising concurrency within one.
2. **Concurrency limits are hard and synchronous.** A Worker request allows 4 and a DO allows 10. Beyond that the call throws `Dynamic worker concurrency limit exceeded …`; it isn't queued. Same-id requests count once. A scheduler has to hold its own semaphore at 4 or 10 per context.
3. **Use a fresh id per run for correctness.** Warm reuse keeps module state, because `eval` is unavailable and ESM can't be re-evaluated. Warm reuse also only works through a DO: 29/29, against 13/29 stateless.
4. **Per-file isolation costs bundle time.** Bundling per file matches vitest's `isolate: true`, which the toy needs, but costs 5–8× the esbuild time and 7× the size of a shared graph. Cheaper options are one esbuild call with many entry points, which worker-bundler 0.2.6 doesn't expose, or one isolate per file from a shared bundle.
5. **The runner needs its own memory signal.** Over-limit isolates return `ok` and are discarded silently. The candidates are under [Memory and reuse](#memory-and-reuse).
6. **Custom `cpuMs` is lenient on fresh isolates:** two free overruns. Don't rely on it to bound a cold run.
7. **Clocks.** Timings taken inside a DO need an I/O bracket. `performance.now()` alone across a child call under-reported a 4 s child as 24 ms. Tail `cpuTime` can exceed wall time for heavy suites.
8. **`@vitest/expect` 5 runs unmodified in workerd** and gives byte-for-byte vitest messages. That makes a high-fidelity probe runner cheap to build.
9. **Local `wrangler dev` enforces no limits.** It allowed 6 and 12 concurrent children and 400 MiB, and reports CPU 0.
10. **What a fresh id costs.**
    - The Dynamic Workers pricing page says a Dynamic Worker "is uniquely identified by its Worker ID and code". So a fresh id per proof run (finding 3) is a new unique Worker, billed at $0.002 per day.
    - A proven conflict uses about 10 ids: the probe runs ×3 in each of A, B and A+B (the stability rule), plus one run on trunk. That comes to **about $0.02 per conflict** in unique-Worker charges, on top of CPU.
    - Suites run in Tier 2 (the [go/no-go](#gono-go) below), so they add nothing here.
    - Wasm tool isolates keep stable ids behind their DO, because they never run repo code ([S18](18-wasm-loader.md)).
    - This is the figure the cost meter uses.

## Can-fail demonstrations

| Check | Violation introduced | Result |
|---|---|---|
| Parity diff (toy, edge) | `break=toBe:pass`: the shim's `toBe` always passes | exit 1, `identical:false`, 1 mismatch: `items api > returns 410 for deleted items` node `fail`, tier1 `pass` |
| Parity diff (forge-lite base, edge) | `break=toBe:fail`: `toBe` always throws | exit 1, 179 mismatches (node pass 200; tier1 pass 21, fail 179) |
| Parity diff (module isolation) | toy bundled with `isolate:false` | 1 mismatch: `module state > sees a fresh module graph per file` |
| Parity diff (warm reuse) | toy re-run warm | 2 digests; 3 tests change status (see above) |
| Probe mapping | the six worlds | each of `pass`, `fail` and `n/a` occurs; a mapping that collapsed n/a into pass or fail would disagree with `run-probe.mjs` |
| Memory outcome on the edge | hog 250–400 MiB | `exceededMemory` on the edge; the same 400 MiB is `ok` under local `wrangler dev` |
| Silent memory breach | memtest 200–250 MiB | `ok` with results, isolate replaced (this is a finding, not a pass) |
| CPU outcome | `cpuMs: 50`, warm | `exceededCpu` ×11 after 2 tolerated overruns |
| Concurrency limit | 5th call in a Worker request, 11th in a DO | thrown error (above); local allows all |
| Typecheck | seeded `const x: number = "forty-two"` | 1 diagnostic, TS2322, same line as local `tsc` |
| Lint | `[3, 1].sort()` in a probe file | `unicorn(no-array-sort)` error; removed, then clean |

## Untested

- **Unsupported vitest features:** snapshots, fake timers, `vi.mock`, `expect.poll`, `test.extend` fixtures, concurrent tests (they run sequentially), `--typecheck`, coverage. forge-lite uses none of them, so the shim's fidelity there is **untested**.
- **Typecheck scope:** test files and scenarios weren't typechecked in the isolate, because they need vitest's `.d.ts` tree.
- **Bundling alternatives:** one esbuild invocation with many entry points; one isolate per test file from a shared bundle; `DurableObjectKVFileSystem` to skip the npm fetch.
- **Memory limits:**
  - the exact limit for allocation spread across tests (250 MiB ok, 800 MiB error);
  - whether the post-run instance check catches every breach;
  - a shim-level Wasm/ArrayBuffer cap.
- **Time and placement:** latency at other times or colos. Two samples of the same run differed by 2× (cold p50 765 against 1535 ms).
- **Pinned isolates:** the 4-per-request limit with real suites. It was only probed with sleeper children.

## Teardown

The R2 bucket was emptied through the Worker's `/objects` endpoint (49 objects), then the bucket and the Worker were deleted. The Worker's Durable Object namespace and all DO instances go with it. The local Docker volume `keel-spike-14-pnpm-store` and the `node:22` image were removed, and the local `.wrangler/` state and `.dev.vars` were deleted. The `cloudflare/sandbox:0.12.1` image was left in the local Docker cache because other spikes use it.

```
$ curl -X POST $BASE/objects -d '{"delete":true}'      -> {"count":49,"deleted":true,...}
$ curl $BASE/objects                                    -> {"count":0,"deleted":false,"keys":[]}
$ wrangler r2 bucket delete keel-spike-14-bundles      -> Deleted bucket keel-spike-14-bundles.
$ wrangler delete --name keel-spike-14-verify --force  -> Successfully deleted keel-spike-14-verify

$ wrangler r2 bucket list | grep -c keel-spike-14
0
$ wrangler deployments list --name keel-spike-14-verify
✘ [ERROR] A request to the Cloudflare API (/accounts/<account>/workers/scripts/keel-spike-14-verify/deployments) failed.
  This Worker does not exist on your account. [code: 10007]
$ curl -o /dev/null -w "HTTP %{http_code}" https://keel-spike-14-verify.<subdomain>.workers.dev/cached?key=x
HTTP 404
$ docker volume ls | grep -c keel-spike-14
0
```

No `keel-spike-14-*` resources remain.
