# S8: Test harness

Run on 2026-10-10 inside the repo itself, not as a throwaway: the harness is the one Keel's tests now use. Code is in `apps/keel/test/pool/`, `apps/keel-verify/test/pool/` and the mutants in `test/mutants/s8-*.patch`.

## Answer

**GO. No fallback needed.**

vitest 5.0.3 with `@cloudflare/vitest-plugin` 1.4.0 and `@effect/vitest` 4.0.2 runs every binding type Keel uses inside workerd, and each binding type has a test that is green on the tree and a seeded defect that turns it red.

| Binding | Green test | Seeded defect (`pnpm prove:red s8`) |
|---|---|---|
| D1 (migrations + `AgentDirectory` contract suite) | `adapters.test.ts` | `s8-d1-schema-drift`: red |
| DO SQLite (Exit envelope over real DO RPC) | `exit-envelope.test.ts` | `s8-do-sqlite-forgets`, `s8-exit-envelope-loses-errors`: red |
| Workflow (`introspectWorkflowInstance`: Precheck errors non-retryably) | `bindings.test.ts` | `s8-workflow-completes`: red |
| Queue (`createMessageBatch` + `getQueueResult`) | `bindings.test.ts` | `s8-queue-retries`: red |
| Service binding to a fake `WorkerEntrypoint` (`VERIFIER` → aux worker) | `bindings.test.ts` | `s8-service-binding-misnamed`: red (workerd fails to start, ≈11.5 s) |
| Cross-script DO binding (`SANDBOX` → keel-verify's class) | `bindings.test.ts` | covered by the aux worker defining the class |
| R2 (`BUNDLES`, the sandbox's bundle host) | keel-verify `egress.test.ts` | `z-egress-deny-shadows-bundles`: red |
| Effect in workerd (`@effect/vitest` suites) | `whoami.test.ts`, `contract.test.ts` | `c6-*`: red |

Each mutant run takes about 6 s; the pool suites take about 5 s each once warm.

## What it took

- `vitest-pool-workers` 0.23 is deprecated; `@cloudflare/vitest-plugin` 1.4 is its successor and is configured per app with `cloudflareTest({ wrangler: { configPath } })`, so the test and production binding sets come from one file (rule R13 checks they match).
- `readD1Migrations` resolves paths from the current directory: use `import.meta.dirname`.
- A cross-script DO binding needs the fake auxiliary worker to define the class.
- The first test in a pool pays the sandbox SDK's cold load (about 3.5 s), so the pool `testTimeout` is 30 s.
- Call `worker.queue(...)` directly; `exports.default.queue` is not the handler.
- AI and Artifacts bindings warn that they "always access remote resources"; with `remoteBindings: false` nothing remote is called unless a test uses them.
- A container-backed DO cannot be constructed in the pool ("Containers have not been enabled"). `egress.test.ts` reads KeelSandbox's real field initialisers by constructing it over an empty base for one call; the live behaviour is left to prove on staging.
- `vitest bench` in vitest 5 does not honour `--project` for these projects; timing scripts run under plain Node instead (`apps/keel/test/bench/runtime.ts`).

## Not covered here

Real adapters against real services (Artifacts, K2, AI, live D1) are covered by the live smoke (`pnpm smoke`) and the e2e scenarios, not by the pool.
