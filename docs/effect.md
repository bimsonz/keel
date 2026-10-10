# Where Effect lives

Effect 4 runs inside the hexagon and in the composition roots. Everything a consumer touches (generated code, Hono middleware, the SDK, CLI, console, examples and `gitcore`) is plain TypeScript.

**Before writing Effect code, read `node_modules/effect/ai-docs`** for the installed version. Effect 3 idioms are common in examples and they do not compile here.

## Layers

| Layer | Shape |
|---|---|
| Domain (`packages/core/src/domain`) | Pure and synchronous. `decide(state, cmd, facts) → Result<Event[], DomainError>` and `evolve(state, event) → state`. Errors are `Schema.TaggedError`, so they serialise |
| Application (`packages/core/src/application`) | Use-cases are `Effect.fn("context/name")` with an **exact** `R` (the ports they use) and `E` (a union of tagged errors). Ports are `Context.Service` shapes with no adapter attached |
| Driven adapters (`apps/*/src/adapters/driven`) | `XLive = Layer.effect(Port, …)`, constructed with its binding |
| Composition (`apps/*/src/composition`) | Layer recipes per host. The only places a runtime is built |

## One runtime per host

| Host | Runtime | Rules |
|---|---|---|
| Hono or MCP handler | One `ManagedRuntime` per isolate (`WeakMap<Env, Runtime>`), built only from binding-backed adapters | Each call runs with `runPromise(effect, { signal })`. A handler accepts only an Effect whose error channel is `never`: every error is mapped first |
| Durable Object method or alarm | One `ManagedRuntime` per instance, built in the constructor. Migrations run in `blockConcurrencyWhile` | **No `await` on the decision path**: do async lookups first, then `decide`, then commit state and outbox in one `transactionSync` through the synchronous `EntityStore`. RPC returns an **Exit envelope** encoded with Effect Schema, because errors do not survive structured clone; the caller decodes it back into tagged errors |
| Workflow step | Built from `this.env` on each `run()` | Transient failures throw, so the step retries; permanent ones throw `NonRetryableError`. Retries are configured on the step, never with `Effect.retry`. IDs, time and randomness come only from inside steps |
| Queue consumer | The isolate runtime | `Effect.forEach(messages, …, { concurrency })`, with an explicit ack or retry per message |
| Verifier and runner control | One `Scope` per job | Child processes and isolates are `acquireRelease`d and killed on interrupt. Timeouts kill explicitly |

## Schemas

| Side | Schema system |
|---|---|
| Published wire: HTTP, MCP, MFP records read back from git | Zod, in generated code only |
| Unpublished: DO SQLite JSON, Queue and Workflow payloads, the runner protocol, third-party payloads | Effect Schema |
| Domain types | Written by hand; neither schema system generates them |

Pure mappers in `apps/keel/src/adapters/driving/http/mappers.ts` translate between the two sides, so a spec change breaks compilation exactly there. Error mapping is exhaustive at compile time: a new error tag stops its handler compiling until it is mapped, and a status the spec does not declare is rejected by the generated types.

## Pitfalls

1. Never cache request-scoped I/O objects in isolate-level Layers.
2. A forked fiber dies with the response. Work that must happen goes through the outbox, a Queue or a Workflow.
3. The Workers clock is frozen during CPU work.
4. A client abort interrupts the fiber, so mutations must be atomic or idempotent.
