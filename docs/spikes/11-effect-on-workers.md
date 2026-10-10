# S11: Effect 4 on Workers

Run on 2026-10-10 against the code that ships (effect 4.0.2) and against staging (`keel.<account subdomain>.workers.dev`, called from the UK). Code: `apps/keel/src/composition/isolate.ts`, `apps/keel/src/adapters/driving/http/run.ts`, `apps/keel/test/bench/runtime.ts`, `apps/keel/test/unit/run.test.ts`, `apps/keel/test/pool/exit-envelope.test.ts`, `scripts/smoke.ts`.

## Answer

**GO: one `ManagedRuntime` per isolate, as built.** The runtime's own overhead per request is about 2 µs at p50, far under the 1 ms criterion. Building the Layer per request costs about 60 µs more at p50, almost all of it re-importing the signing key, and gains nothing, so the per-isolate runtime stays.

## Numbers

**Bundle** (`pnpm deploy:staging`, wrangler 4.149):

| Worker | Upload | gzip | Startup (wrangler) |
|---|---|---|---|
| keel | 2,834 KiB | 500 KiB | 116 ms |
| keel-verify | 1,237 KiB | 256 KiB | 24 ms |
| keel-console | 0.34 KiB | 0.24 KiB | 1 ms |

**Runtime per isolate vs Layer per request** (`node apps/keel/test/bench/runtime.ts`, Node 22.22 on V8, 300 warm-up runs then 3,000 timed; inside a Worker the clock is frozen during CPU work, so CPU cost is measured outside it):

| Work | Runtime per isolate (Keel) | Layer per request |
|---|---|---|
| Bearer gate: verify an Ed25519 JWT with jose, then `whoami` | p50 0.132 ms, p95 0.192 ms, p99 0.302 ms | p50 0.189 ms, p95 0.281 ms, p99 0.717 ms |
| The runtime alone: `whoami` on the in-memory directory | p50 0.002 ms, p95 0.003 ms, p99 0.007 ms | p50 0.003 ms, p95 0.005 ms, p99 0.013 ms |

**Live on staging** (`node scripts/smoke.ts staging --repeat 40`, with `wrangler tail keel --format json` sampling 14 invocations):

| Call | Client p50 / p95 (40 warm rounds, UK) | Server CPU p50 / p95 | Server wall p50 / p95 |
|---|---|---|---|
| `POST /v1/oauth/token` | 73 / 207 ms | 5 / 5 ms | 51 / 59 ms |
| `GET /v1/agents/me` | 72 / 192 ms | 4 / 5 ms | 52 / 55 ms |
| MCP `tools/call whoami` | 75 / 203 ms | 9 / 10 ms | 57 / 57 ms |

Cold: the first request into a fresh isolate took **46 ms CPU, 97 ms wall** (module evaluation, building the runtime, importing the signing key). Warm wall time is dominated by the D1 read the bearer gate makes on every request (the revocation-epoch check), not by Effect.

## Abort and interrupt

A client abort interrupts the request's fiber: `run.test.ts` aborts a 2 s effect after 20 ms; the runner returns within 1 s, the effect's `acquireRelease` finaliser has run, and the answer is the declared 503 `service.unavailable`. The runner passes the request's `AbortSignal` to `runPromiseExit(effect, { signal })`. The seeded defect `s11-abort-ignored` (drop the signal) turns the test red: the effect runs to completion and answers `finished`.

Mutations must therefore be atomic or idempotent (pitfall 4 in `docs/effect.md`): an abort can land between two awaits.

## The Exit envelope over DO RPC

Tagged errors do not survive structured clone, so DO RPC methods answer `Schema.toCodecJson(Schema.Exit(A, E, Schema.Defect()))`, one codec per deployable (`src/rpc/exit.ts`, rule R15). `exit-envelope.test.ts` round-trips success, a tagged failure (decoded back into an instance of the error class) and a defect (`Die`) through a real DO stub in workerd. The seeded defect `s8-exit-envelope-loses-errors` turns it red.

## Pitfalls confirmed

- Never cache request-scoped I/O objects in isolate-level Layers: the isolate runtime holds only binding-backed adapters.
- `Date.now()` and `performance.now()` advance only at I/O inside a Worker, so per-request CPU is taken from tail events, not from timers in the Worker.
- effect and `@effect/vitest` move as a pair: `@effect/vitest` 4.0.3 needs an effect 4.0.3 that was unpublished on 10 Oct, so both stay at 4.0.2.
