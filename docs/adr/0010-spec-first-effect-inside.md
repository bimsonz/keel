# TypeSpec first, Zod only in generated code, Effect only inside the hexagon

**One source for the API.** The HTTP API, the MCP tools and the SDK are all generated from one TypeSpec source, using the MIT emitters `typespec-hono`, `typespec-http-mcp` and `typespec-openapi-document`.

**Zod is generated, never handwritten.** It appears only in generated code and validates the published wire.

**Effect lives inside the hexagon:**
- **Application:** use-cases are `Effect.fn` with exact port and error types.
- **Ports:** declared as `Context.Service` shapes.
- **Adapters:** provided as `Layer`s.
- **Composition:** runtimes are built only in the composition roots, one recipe per host.
- **Domain:** stays pure and synchronous.
- **Consumers** (SDK, CLI, console, examples) never need Effect.
- **Internal payloads** use Effect Schema.

**Errors are mapped exhaustively in both directions at compile time.**

Why:
- Spec-first gives agents one stable, self-describing contract on both REST and MCP.
- Effect gives typed errors and per-host dependency injection without reflection. Reflection-based DI breaks under esbuild.

The hexagonal layout and its rules are re-derived for Keel, not copied from earlier work; ADR 0013 covers why.

## Considered options

- **The Effect `HttpApi` server.** Rejected: it would duplicate the TypeSpec contract.
- **Effect cluster/workflow.** Rejected: Workflows and DOs already do that job.
- **Effect 3.** Rejected: starting on v3 means a guaranteed migration onto v4, which shipped 2026-10-01.

## Consequences

- Agents tend to write Effect 3 code, so AGENTS.md carries a v3→v4 cheat sheet.
