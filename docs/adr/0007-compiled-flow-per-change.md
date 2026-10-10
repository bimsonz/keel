# Dynamic CI: a flow compiled per change, from the base commit, with `@cloudflare/ci` only for Tier 2

Keel has no static pipeline file. Each change gets a throwaway **Verification Plan**:

- **Input.** The project's `.keel/flow` spec and plugins, read from the **base** commit, so a change can't edit its own checks. These are combined with Keel's defaults and the change's derived facts.
- **Grammar.** The flow is written in a typed grammar: step, seq, par, cascade, worlds, when, budget.
- **Output.** It compiles to a content-addressed `FlowPlan`.
- **Execution.** The plan runs as one `KeelVerify extends CIWorkflow` instance:
  - Tier 0/1 steps run as `step.do`.
  - Tier 2 steps run as `ci.runner`.
  - Human steps run as `waitForEvent`.

Keel owns how steps are composed; projects supply the steps. Verifier packs per ecosystem are defaults, not rules.

Why: under the factory principle, every change gets its own motor. A static YAML pipeline asks "what does this repo always run?". The compiled plan asks "what could *this* change have broken, given what everyone believes?". It also keeps Keel non-prescriptive across firmware, apps and infrastructure.

## Considered options

- **Use `@cloudflare/ci` as the whole engine.** Rejected. Every runner is a container, the runner can't be swapped, and its cache is scoped per ref.
- **Write our own container runner.** Rejected. `@cloudflare/ci` already handles snapshots and chained runners.
- **Let a model compose the flow (Code Mode).** Rejected; see ADR 0001.

## Consequences

- **Cache scope is a trust boundary.** `@cloudflare/ci` sets `cacheScope = payload.ref`. Running candidate code under the base ref would let untrusted code publish into the trusted base cache, which is cache poisoning.
  - Candidates run under their own scope.
  - A trusted dependency-install step runs from trunk's lockfile under the base scope. A candidate that changes the lockfile is a barrier change and installs cold.
  - Per-runner scopes probably need a small fork (spike S15).
- **No credential may enter an untrusted runner's environment.** That includes the checkout token, because raw runner logs are persisted as Workflow step output before any wrapper can redact them. Candidates are hydrated from content-addressed R2 bundles instead of a tokened git fetch. If `@cloudflare/ci` can't do that unmodified, fork it (S15).
