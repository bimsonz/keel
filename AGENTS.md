# Working in Keel

Keel is an agent-first Git platform on Cloudflare Workers and Artifacts. Use the terms in [CONTEXT.md](CONTEXT.md) exactly: in code, docs, commits and API names. Hard-to-reverse choices are in [docs/adr](docs/adr); read the relevant ADR before changing a boundary it fixes.

## Commands

| Command | What it does |
|---|---|
| `pnpm install` | Install. CI uses `--frozen-lockfile` |
| `pnpm gen` | Regenerate everything gitignored: TypeSpec output (`*.gen.ts`, `packages/contracts/openapi.json`) and each Worker's `worker-configuration.d.ts`. Run it after any change to `packages/spec` or a `wrangler.jsonc` |
| `pnpm lint` | oxlint, type-aware, over the workspace paths only. Type-aware rules find files through every tsconfig they meet, so `spikes/` and `fixtures/` (which lint themselves) are excluded by path rather than by `ignorePatterns` |
| `pnpm typecheck` | `tsc --noEmit` in every package (TypeScript 7) |
| `pnpm guards` | Workspace guards: nothing private in a public file |
| `pnpm test` | vitest projects `unit` and `arch` (Node) |
| `pnpm test:pool` | vitest projects `pool:*`: each Worker's tests inside workerd |
| `pnpm tooling:controls` | Runs every guard against its control fixture; all must go red |
| `pnpm deploy:dry` | `wrangler deploy --dry-run` for every Worker |
| `pnpm check` | All of the above, in CI order. Green `pnpm check` is the bar for every push |

## The hexagon

One hexagon (`packages/core`), entered through several **doorways**: HTTP, MCP, Durable Objects, Workflows and Queues. A DO is another doorway into the same hexagon, not a second hexagon.

- `domain/` is pure and synchronous. `application/` holds use-cases (`Effect.fn`) and **ports** (`Context.Service` shapes). Each bounded context exposes only its `index.ts`.
- Driving adapters (doorways) and driven adapters (port implementations) meet only in `composition/`, the one place `env` becomes objects.
- `src/rpc/` holds DO RPC contracts that both sides import; it imports nothing but `core` domain types and `effect`.
- Import core by subpath: `@keeltown/core/kernel` (the shared kernel: ids, evidence classes, hashes, globs, citations, the event envelope), `@keeltown/core/domain/<context>`, `@keeltown/core/application/<context>`, `@keeltown/core/ports`. The kernel imports no context; every context may import it.
- Every port has an in-memory adapter and a contract suite in `@keeltown/testing` (`PORTS`). A real adapter registers the same suite with `PORTS.<Port>.contract("d1", makeLayer)`; a contract still marked `todo` is still to be written.

The architecture rules (R1–R15) and guards run in `pnpm test` (project `arch`). Each one reports how many files it read and checks a canary, so a rule aimed at the wrong path fails instead of passing on nothing. When a rule goes **red**, fix the code.

## TypeSpec

- `packages/spec` is the single source for REST, MCP and the OpenAPI document. One `.tsp` file per resource group.
- Only `packages/contracts/openapi.json` is committed. Every `*.gen.ts` is gitignored and comes from `pnpm gen`; CI fails if regenerating changes `openapi.json`.
- Request bodies are always models. Optional response fields are omitted, never set to `undefined`. Errors are `application/problem+json` and always carry `nextActions`.
- `seal-object-schemas` is on, so an unknown field is a 400 that names it.
- An operation tagged `mcp` is also an MCP tool, named by its operation id, so work-loop operations carry `@operationId` with the verb an agent calls (`whoami`, `declare`, `submit`). Other operations keep the default `Group_operation` id.
- Each operation's id is also its key in the one handler object (`apps/keel/src/adapters/driving/http/handlers.ts`), which the generated REST routes and MCP tools both dispatch into.
- v1 only grows: no `@versioned` until a v2 exists.
- Temporary, each removed when typespec-hono 0.25 and typespec-http-mcp 0.2 land:
  - no `@cookie` parameters;
  - no negotiated `@sharedRoute`;
  - one `@useAuth(OAuth2Auth<…>)` alias per scope set, declared once in `common.tsp`.

## Effect 4

Read `node_modules/effect/ai-docs` first, then [docs/effect.md](docs/effect.md) for where Effect may appear and the per-host runtime rules. Effect 3 spellings do not compile here:

| Effect 3 | Effect 4 |
|---|---|
| `Context.Tag`, `Effect.Service` | `Context.Service` |
| `Either`, `Effect.either` | `Result`, `Effect.result` |
| `catchAll`, `catchAllCause` | `Effect.catch`, `catchCause`; `catchTag` for one tag |
| `fork`, `forkDaemon` | `forkChild`, `forkDetach` |
| `Layer.scoped` | `Layer.effect` |
| hand-written generator functions | `Effect.fn("context/name")` |
| `TestClock` from `effect` | `effect/testing` |

## Adding an operation

1. **Spec.** Add the operation to its group's `.tsp` with `@useAuth`, its error models, and the `mcp` tag if agents call it in their work loop. Done when `pnpm gen` succeeds and the `openapi.json` diff shows only the new operation.
2. **Use-case.** Add `application/<context>/<name>.ts` as `Effect.fn` with exact `R` and `E`. Done when its unit test passes against in-memory Layers, for success and for every error tag.
3. **Mapper.** Map the use-case result and every error tag to the generated result union in `adapters/driving/http/mappers.ts`. Done when it typechecks with no casts.
4. **Handler.** Replace the operation's stub in the handler object. REST and MCP share it. Done when the pool test calls the real fetch handler, and the MCP tool result equals the REST body.
5. **Control.** Break it once on purpose (wrong status, dropped error tag) and watch the suite go **red**, then revert.

## Proving a check

A check counts only after it has been seen **red**. Every rule and guard has a control in `test/controls/`; every property test has a seeded wrong implementation; every e2e scenario has a negative-control arm. A new check lands with its control.

## Git

- Trunk-based: commit to `main`, `git pull --rebase` before every push, and push every commit. A red `main` stops the line: whoever broke it fixes or reverts within 15 minutes.
- After the `contracts-v0` tag, contract changes are additive (a new operation, an optional field, a new port method) with a CHANGELOG line. A breaking change is marked as one in its CHANGELOG entry.
- Never `--no-verify`. Commit messages say what changed and why.
