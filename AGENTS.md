# Working in Keel

Keel is an agent-first Git platform on Cloudflare Workers and Artifacts. Use the terms in [CONTEXT.md](CONTEXT.md) exactly: in code, docs, commits and API names. Hard-to-reverse choices are in [docs/adr](docs/adr); read the relevant ADR before changing a boundary it fixes.

## Commands

| Command | What it does |
|---|---|
| `pnpm install` | Install. CI uses `--frozen-lockfile` |
| `pnpm gen` | Regenerate everything gitignored: TypeSpec output (`*.gen.ts`, `packages/contracts/openapi.json`) and each Worker's `worker-configuration.d.ts`. Run it after any change to `packages/spec` or a `wrangler.jsonc` |
| `pnpm lint` | oxlint, type-aware, over the workspace paths only. Type-aware rules find files through every tsconfig they meet, so `spikes/` and `fixtures/` (which lint themselves) are excluded by path rather than by `ignorePatterns` |
| `pnpm format` / `pnpm format:check` | oxfmt: write, or check (CI runs the check after lint). Run `pnpm format` on your changes before every push |
| `pnpm typecheck` | `tsc --noEmit` in every package (TypeScript 7) |
| `pnpm guards` | Workspace guards: nothing private in a public file |
| `pnpm test` | vitest projects `unit` and `arch` (Node) |
| `pnpm test:pool` | vitest projects `pool:*`: each Worker's tests inside workerd |
| `pnpm tooling:controls` | Runs every guard and rule R1–R15 against its control fixture; all must go red |
| `pnpm deploy:dry` | `wrangler deploy --dry-run` for every Worker |
| `pnpm check` | All of the above, in CI order. Green `pnpm check` is the bar for every push |

## The hexagon

One hexagon (`packages/core`), entered through several **doorways**: HTTP, MCP, Durable Objects, Workflows and Queues. A DO is another doorway into the same hexagon, not a second hexagon.

- `domain/` is pure and synchronous. `application/` holds use-cases (`Effect.fn`) and **ports** (`Context.Service` shapes). Each bounded context exposes only its `index.ts`.
- Driving adapters (doorways) and driven adapters (port implementations) meet only in `composition/`, the one place `env` becomes objects.
- `src/rpc/` holds DO RPC contracts that both sides import; it imports nothing but `core` domain types and `effect`.
- Import core by subpath: `@keeltown/core/kernel` (the shared kernel: ids, evidence classes, hashes, globs, citations, the event envelope), `@keeltown/core/domain/<context>`, `@keeltown/core/application/<context>`, `@keeltown/core/ports`. The kernel imports no context; every context may import it.
- Every port has an in-memory adapter and a contract suite in `@keeltown/testing` (`PORTS`). A real adapter registers the same suite with `PORTS.<Port>.contract("d1", makeLayer)`; a contract still marked `todo` is still to be written.
- **Durable Objects and the event backbone.** Every Durable Object in `apps/keel` extends `KeelObject`. A method answers with `this.answer(Codecs.method, program)`, and the program changes state only through `commit(spec, decide)` from `@keeltown/core/ports`. `decide({store, outbox, at})` reads and writes synchronously, takes the time only from `at` (the instant the events are stamped with, so the state it writes is what the log folds to), and returns `Result.succeed({drafts, value, after?})` or a refusal; the state and its events commit in one transaction, a refusal writes nothing, and `after(tx)` runs in that transaction once the events are appended (a subscription change that must not alter their `notified[]`). Subscribe inside `decide` with `outbox.subscribe(address, types | "*")`. `spec.cause` makes a retry a no-op: the Idempotency-Key, `<instanceId>:<method>` for a Workflow, the incoming dedupeKey for a reaction, or `<reason>@<at>` for an alarm. Override `react(event, tx)` to receive events: delivered at least once, applied once; a reaction that commits nothing returns `{drafts: []}`. Every object but the Projector subscribes `projector` to `*` as it starts, so the Projector's feed holds every committed event. Set `spec.actor` for a principal's command (`agentActor(agentId)`, or `operator:<by>`) and leave it absent for the platform's (Precheck, alarms, reactions): an AgentSession never records an event its own agent caused, so an agent is never woken by its own command. Notices ride every agent-envelope response, typed refusals included, taken after the answer with `Notifier.take(agentId, 3)`. The piggyback is at most once (the take commits before the response leaves), so the inbox is the durable path. Override `received()` for what may leave the object only once a delivery is committed (the AgentSession's WebSocket pushes, after `ctx.storage.sync()`: `send` is outside the output gate). Override `onDeadline(request)` for the object's own alarms, armed only through `scheduleAlarm`.

The architecture rules run in `pnpm guards` and in `pnpm test` (project `arch`), from `packages/tooling/src/arch`:

| Rule | Holds |
|---|---|
| R1 | `domain/**` imports only the domain, and from `effect` only `Schema`, `Data`, `Brand`, `Option`, `Result`, `Match`, `Array`, `Order`, `Equal`, `Predicate`, `pipe` |
| R2 | `application/**` imports only the domain, the application and `effect` |
| R3 | Driving adapters never import driven adapters; they meet in `composition/` |
| R4 | No import cycles; a context reaches another only through its `index.ts` (the kernel and the ports are open to all) |
| R5 | `core`, `gitcore` and `syntax` import no `hono`, `zod`, `cloudflare:*`, `@cloudflare/*`, `agents` or MCP SDK |
| R6 | `zod` only in generated code |
| R7 | `cloudflare:workers` only in the DO and Workflow doorways and `composition/` |
| R8 | Runtimes are built and run only in `composition/` and driving adapters; driving adapters never `forkDetach` or `runFork` |
| R9 | Public consumers (console, examples, CLI, e2e) depend only on `contracts`, `sdk`, `workspace-git`, `cli` and MFP |
| R10 | Keel's Workers import no agent runtime, MCP client or model SDK |
| R11 | No `setInterval`; alarms only through `scheduleAlarm({ kind: "deadline" \| "debounce", reason })` |
| R12 | Every layer folder exists and holds something |
| R13 | Wrangler configs: one compatibility date, explicit `workers_dev`/`preview_urls`/`KEEL_HOST`, no `account_id`, every id a sentinel, `max_instances` on containers, no test-only bindings (bar `TEST_*`) |
| R14 | No literal-against-literal assertions, no `.only` |
| R15 | `src/rpc/**` imports only core domain types and `effect` |

R1, R3 and R4 run twice: on oxc-parser import records and on ArchUnitTS's dependency graph, which must match at least as many files as the scan read. Every rule reports how many files it read and checks a canary, so a rule aimed at the wrong path fails instead of passing on nothing. Each has a control under `test/controls/R<n>/` that `pnpm tooling:controls` must turn red, for the reasons listed in the arch test. When a rule goes **red**, fix the code, not the rule. A change to a rule says why in its commit message and lands with its control.

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
3. **Policy.** Add the operation's action to `SPEC_ACTIONS` in `packages/core/src/domain/identity/authorize.ts` (the resource kind it is decided on and what it needs of the caller; `[authz.spec-covered]` holds the list equal to the spec) and its resolver to `RESOLVERS` in `adapters/driving/http/authorize-handlers.ts` (typed total: a missing one does not compile). The handler then runs only for a caller the policy granted, with `caller.resource` and, on a read, `caller.audience`. Never check a scope, a role or the caller's kind in a handler or a use-case: `[authz.no-hand-checks]` fails on one.
4. **Mapper.** Map the use-case result and every error tag to the generated result union in `adapters/driving/http/mappers.ts`. Done when it typechecks with no casts.
5. **Handler.** Replace the operation's stub in the handler object. REST and MCP share it. Done when the pool test calls the real fetch handler, and the MCP tool result equals the REST body.
6. **Control.** Break it once on purpose (wrong status, dropped error tag) and watch the suite go **red**, then revert.

## The SDK and the CLI

- `@keeltown/contracts` is generated: `openapi.json` and the wire types in `src/generated/requests.gen.ts` (no imports). Public code (console, examples, CLI, e2e) types itself from these, never from core (R9).
- `@keeltown/sdk` calls the operations in `packages/sdk/src/routes.ts`. To give it another operation, add its route (the `[sdk.routes]` test holds it to the document) and, if agents call it often, a convenience method. It has no runtime dependencies and runs wherever `fetch` is global.
- `@keeltown/cli` (`keeltown`) uses the SDK only. Node runs its TypeScript directly, so the SDK and the CLI keep to erasable syntax (`erasableSyntaxOnly`).

## Secrets and credentials

- `keel` requires its secrets: `KEEL_SIGNING_KEY` (the Ed25519 JWK that signs bearer tokens), `CLOUDFLARE_ACCOUNT_ID` (read by `@cloudflare/ci`; a secret so it is never committed), `KEEL_BOOTSTRAP_SECRET` (Terraform's `bootstrap_secret` output), `BETTER_AUTH_SECRET` and `KEEL_CLAIM_DIGEST` (from Terraform's outputs). `scripts/deploy.ts` sets them all.
- **The bootstrap credential.** Client `keel-bootstrap` with `KEEL_BOOTSTRAP_SECRET` exchanges for a token whose agent is never stored. The policy grants it `Auth_exchangeToken` and `Admin_createUser` only (`BOOTSTRAP_ACTIONS`), so its one use is creating automation users. Retire it by replacing `random_password.bootstrap` and redeploying.
- **The claim code.** Terraform's sensitive `claim_code` output; the Worker holds only its SHA-256 (`KEEL_CLAIM_DIGEST`, set by `scripts/deploy.ts`). The instance's first admin presents it once, as `Keel-Claim` on a passkey sign-up with a held handle; Keel never logs it. Read it without printing it (`terraform -chdir=infra/<env> output -raw claim_code | pbcopy`).
- **The console's keys.** `CONSOLE_PRESENTER_KEY` (unlocks the presenter's controls) and `CONSOLE_CAPABILITY_KEY` (signs capability links) cannot be read back from the Worker, so `scripts/deploy.ts` keeps each one it generates in the gitignored `.keel/<env>.json` under `console` (0600), and never prints it: the log shows a `sha256:` prefix to match against the file. A key the file holds is set from it on every deploy; one the Worker holds and the file does not is left alone; `--rotate <NAME>` replaces it. `scripts/seed.ts` keeps the `console` entry when it rewrites the file. `--only <app>` deploys one Worker and logs the others as untouched; announce it like any deploy, since it mixes versions. `deploy.ts` refuses any argument it does not know before it renders anything.
- `@cloudflare/ci` also mentions `CF_TOKEN` and R2 S3 keys. Keel provides neither: sandbox backups go through the `BACKUP_BUCKET` binding (`localBucket: true`), and no runner step asks for credentials. The `runner-credentials` guard fails if one sets `cloudflareCredentials` or `sourceControlCredentials`.
- Never put a credential in a container's start environment: it lands on disk and in `/proc/1/environ`. A container reaches git through outbound interception, which injects a short token per request.
- `KeelSandbox`'s egress: the internet is off and `allowedHosts` is only `*.keel.internal`, which puts the container in intercept-all mode (`interceptAllOutboundHttp` plus HTTPS `*`). `outboundByHost` answers the bundle hosts from `BUNDLES` and refuses `*` at once, rather than leaving a blocked host to hang on DNS. Assign `outboundByHost`; never declare it as a static field, which bypasses the setter.
- `keel-verify` only reads `BUNDLES`. R2 has no read-only binding, so the `readonly-bundles` guard fails on any use of `BUNDLES` other than `.get`, `.head` or `.list`, including an alias.
- `@cloudflare/ci` ships unbuilt TypeScript that fails this repo's flags. It is imported through typed boundaries (`apps/keel/src/adapters/driving/workflow/ci.js` + `ci.d.ts`, `apps/keel-verify/src/adapters/driving/do/ci-sandbox.js` + `.d.ts`); grow the declarations as you use more of it.

## Proving a check

A check counts only after it has been seen **red**. Every rule and guard has a control in `test/controls/`; every property test has a seeded wrong implementation; every e2e scenario has a negative-control arm. A new check lands with its control.

Seeded wrong implementations live in `test/mutants/*.patch`. Line 1 is `# expect-red: <command>`; a property-test mutant adds `# kills: tag-a, tag-b`, naming tests whose titles carry `[tag-a]`. `pnpm prove:red [filter] [--unseeded N]` applies each patch, runs it and reverts it:
- a tagged patch runs under `FC_SEED` 42, 1337 and 20261014 plus N unseeded runs (default 2), with vitest's JSON reporter, and is red only if **every claimed tag** fails in **every** run. An exit code is not enough: one tag failing can hide another that passes;
- a tagged patch runs only the tests that carry a claimed tag: the runner adds `-t '\[tag-a\]|\[tag-b\]'` unless the command already has a `-t`, and each result line says how many tests ran (`2 of 15 tests`);
- an untagged patch is red when its command exits non-zero.

The runner's own control is `node scripts/prove-red.ts --dir test/controls/prove-red`, which must report its two-tag patch as a survivor. Generate a patch with `git diff -- <paths>` so it carries nothing else, and regenerate it when it reports `STALE`. When code was only reformatted, `node scripts/rebase-mutants.ts <ref before the format>` rebuilds the stale patches mechanically.

## Git

- Trunk-based: commit to `main`, `git pull --rebase` before every push, and push every commit. A red `main` stops the line: whoever broke it fixes or reverts within 15 minutes.
- After the `contracts-v0` tag, contract changes are additive (a new operation, an optional field, a new port method) with a CHANGELOG line. A breaking change is marked as one in its CHANGELOG entry.
- Never `--no-verify`. Commit messages say what changed and why.
