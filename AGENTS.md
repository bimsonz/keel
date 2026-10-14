# Working in Keel

This guide is for anyone changing Keel, people and coding agents alike. Keel is an agent-first Git platform on Cloudflare Workers and Artifacts. Use the terms in [CONTEXT.md](CONTEXT.md) exactly: in code, docs, commits and API names. Hard-to-reverse choices are in [docs/adr](docs/adr); read the relevant ADR before changing a boundary it fixes. How to propose a change is in [CONTRIBUTING.md](CONTRIBUTING.md).

## Setup

Keel needs Node 22.18 or later (`.node-version` pins the version CI uses) and pnpm 11 (`packageManager` in `package.json` pins the exact version).

```sh
pnpm install
pnpm gen
pnpm check
```

## Commands

| Command | What it does |
|---|---|
| `pnpm install` | Install. CI uses `--frozen-lockfile` |
| `pnpm gen` | Regenerate everything gitignored: TypeSpec output (`*.gen.ts`, `packages/contracts/openapi.json`) and each Worker's `worker-configuration.d.ts`. Run it after any change to `packages/spec` or a `wrangler.jsonc` |
| `pnpm lint` | oxlint, type-aware, over the workspace paths only. Type-aware rules find files through every tsconfig they meet, so `spikes/` and `fixtures/` (which lint themselves) are excluded by path rather than by `ignorePatterns` |
| `pnpm format` / `pnpm format:check` | oxfmt: write, or check (CI runs the check after lint). Run `pnpm format` on your changes before every push |
| `pnpm typecheck` | `tsc --noEmit` in every package (TypeScript 7) |
| `pnpm guards` | Workspace guards: every dependency resolves from the public npm registry, nothing private in a public file, every mutant patch still applies, and the other repository-wide checks in `packages/tooling/src/guards` |
| `pnpm test` | vitest projects `unit` and `arch` (Node) |
| `pnpm test:pool` | vitest projects `pool:*`: each Worker's tests inside workerd |
| `pnpm tooling:controls` | Runs every guard and rule R1–R15 against its control fixture; all must go red |
| `pnpm prove:red` | Applies each seeded wrong implementation in `test/mutants/`, runs its tests and reverts it; see [Proving a check](#proving-a-check) |
| `pnpm deploy:dry` | `wrangler deploy --dry-run` for every Worker |
| `pnpm check` | gen, lint, format check, typecheck, guards, `test`, `test:pool` and `deploy:dry`, in CI order. A green `pnpm check` is the bar for every push |
| `pnpm deploy` | Install Keel on a Cloudflare account (`scripts/install.ts`) |
| `pnpm e2e:s0`, `pnpm e2e:agents`, `pnpm e2e:chain` | End-to-end scenarios against a deployed Keel |

## Repository layout

| Path | What it holds |
|---|---|
| `packages/spec`, `packages/contracts` | The API in TypeSpec, and the OpenAPI document generated from it |
| `packages/core` | The hexagon: the pure domain (the shared kernel and one folder per bounded context), the Effect use-cases and the ports |
| `packages/gitcore` | Clean-room git algorithms, including the tree diff |
| `packages/syntax` | Source facts for effect derivation, read from a tree-sitter parse |
| `packages/runner-protocol` | Messages between the control plane and runners |
| `packages/{sdk,cli,workspace-git}` | Public clients |
| `packages/testing` | In-memory adapters and the port contract suites |
| `packages/tooling` | Architecture rules, guards and their command-line entry points |
| `apps/keel` | The control plane Worker: the `http` and `mcp` doorways, auth and problem responses, the Durable Objects, Workflows, queue consumers and the driven adapters |
| `apps/keel-verify` | The untrusted execution plane: `KeelVerify` and its sandbox. It holds no credentials |
| `apps/console` | Mission Control |
| `examples/`, `e2e/` | A hosted swarm, a load generator and end-to-end scenarios, all plain clients of the public API |
| `infra/` | Terraform for the hosted instance |
| `scripts/` | Install, deploy, seed and the mutation-proof runner |
| `test/controls/`, `test/mutants/` | Each check's control fixture, and the seeded wrong implementations |
| `spikes/`, `docs/spikes/`, `fixtures/` | Time-boxed experiments and their write-ups, outside the pnpm workspace |

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
- **An agent's key in the SDK** (`packages/sdk/src/agent-key.ts`, WebCrypto only). A key is an `AgentSigner`: its public half and a way to sign, never its private half, so a key that cannot leave its store fits as it stands. A client made with a key (`KeyClientOptions`) reads where to ask from `/.well-known/oauth-authorization-server`, which must name Keel's own origin over https; asks for five-minute tokens with a request the key signs, each for one project and one run; and binds them to a second key it makes in memory, with a proof by that key on every call. The account's key signs requests for tokens and nothing else. `bound: false` asks for a plain bearer, to hand to a tool that cannot sign.
- **Where the CLI keeps that key** (`packages/cli/src/key-store.ts`): the machine's own key store, through the program the system ships for it (the macOS keychain through `/usr/bin/security`, the Secret Service through `secret-tool`). It never writes a key to a file, and a secret never rides a command line: it goes in on stdin. Where there is no store (a container, CI, Windows for now) the key comes from `KEEL_AGENT_KEY` with `KEEL_AGENT_ID`, and `keeltown agent signup --print-key` prints one once, on stdout only, for a secret manager. `keeltown token --header` is how a tool that sends only a bearer, an MCP client among them, gets a token minted from the key.

## Secrets and credentials

- `keel` requires its secrets: `KEEL_SIGNING_KEY` (the Ed25519 JWK that signs bearer tokens), `CLOUDFLARE_ACCOUNT_ID` (read by `@cloudflare/ci`; a secret so it is never committed) `BETTER_AUTH_SECRET` (Terraform's `better_auth_secret` output), `BUNDLE_URL_SIGNING_KEY` (Terraform's `bundle_url_signing_key` output: the Ed25519 private key that signs every bundle URL a sandbox is handed) and `KEEL_COMMIT_SIGNING_KEY` (Terraform's `commit_signing_key` output: the Ed25519 private key that signs every commit Keel composes; its public half is in the var `KEEL_COMMIT_SIGNERS`, which Keel serves as its allowed-signers file). `scripts/deploy.ts` sets them all.
- **`keel-verify` holds no secret.** Its bundle host verifies a bundle URL's signature with `BUNDLE_URL_PUBLIC_KEY`, a plain var `scripts/deploy.ts` fills from Terraform's `bundle_url_public_key` output: the public half, which signs nothing.
- **No account is made for anyone.** There is no bootstrap credential, claim code or instance admin: the first person signs up like every other, and so does automation. `scripts/accounts.ts` signs an automation account up with a passkey it keeps (`~/.keel/<x>-passkey.json`) and signs in to it again from that key; `scripts/seed.ts` does the same for its own user. Suspensions, quota overrides and the spend switch are the operator's configuration of the instance, not operations in Keel.
- **The console holds no secret.** Its Worker serves the page and has no binding to Keel: the page reads `/v1` on its own origin as whoever is signed in. `apps/console/wrangler.jsonc` requires no secret, `scripts/deploy.ts` sets none for it, and the console's `guard-build` fails if a credential or a proxy path is named in its build, its Worker or its config again. `--only <app>` deploys one Worker and logs the others as untouched; it mixes versions, so use it with care. `deploy.ts` refuses any argument it does not know before it renders anything.
- `@cloudflare/ci` also mentions `CF_TOKEN` and R2 S3 keys. Keel provides neither: sandbox backups go through the `BACKUP_BUCKET` binding (`localBucket: true`), and no runner step asks for credentials. The `runner-credentials` guard fails if one sets `cloudflareCredentials` or `sourceControlCredentials`.
- Never put a credential in a container's start environment: it lands on disk and in `/proc/1/environ`. A container reaches git through outbound interception, which injects a short token per request.
- `KeelSandbox`'s egress: the internet is off and `allowedHosts` is only `*.keel.internal`, which puts the container in intercept-all mode (`interceptAllOutboundHttp` plus HTTPS `*`). `outboundByHost` answers the bundle hosts from `BUNDLES` and refuses `*` at once, rather than leaving a blocked host to hang on DNS. Assign `outboundByHost`; never declare it as a static field, which bypasses the setter.
- `keel-verify` only reads `BUNDLES`. R2 has no read-only binding, so the `readonly-bundles` guard fails on any use of `BUNDLES` other than `.get`, `.head` or `.list`, including an alias.
- Every object Keel keeps in R2 for a project sits under its namespace, at `ns/<namespaceId>/<family>/<hex>`, and core's `namespaceKey` is the one place that key is built. The `r2-namespace-keys` guard fails on any string or template in an app's or a package's `src` that opens with `ns/` or with a family of `KeyFamily` and a slash, outside `namespace-keys.ts`.
- `@cloudflare/ci` ships unbuilt TypeScript that fails this repo's flags. It is imported through typed boundaries (`apps/keel/src/adapters/driving/workflow/ci.js` + `ci.d.ts`, `apps/keel-verify/src/adapters/driving/do/ci-sandbox.js` + `.d.ts`); grow the declarations as you use more of it.

## Proving a check

A check counts only after it has been seen **red**. Every rule and guard has a control in `test/controls/`; every property test has a seeded wrong implementation; every e2e scenario has a negative-control arm. A new check lands with its control.

Seeded wrong implementations live in `test/mutants/*.patch`. Line 1 is `# expect-red: <command>`; a property-test mutant adds `# kills: tag-a, tag-b`, naming tests whose titles carry `[tag-a]`. `pnpm prove:red [filter] [--unseeded N] [--all-seeds]` applies each patch, runs it and reverts it (an option it does not know is refused):
- a tagged patch runs under `FC_SEED` 42, 1337 and 20261014 plus N unseeded runs (default 2), with vitest's JSON reporter, and is red only if **every claimed tag** fails in **every** run. An exit code is not enough: one tag failing can hide another that passes;
- a tagged patch runs only the tests that carry a claimed tag: the runner adds `-t '\[tag-a\]|\[tag-b\]'` unless the command already has a `-t`, and each result line says how many tests ran (`2 of 15 tests`);
- a tagged patch whose command names pool projects alone (every `--project` it names begins `pool:`) takes one patched run, under `FC_SEED` 42, and its line says so (`failed under seed 42, run once (a pool project)`): almost no test in workerd draws from the seed, so the other runs were copies. A patch whose pool test does draw carries a `# all-seeds` line in its header and keeps every run, as does a patch that names `unit` or `arch` beside a pool project. `--all-seeds` gives every patch every run;
- an untagged patch is red when its command exits non-zero;
- before a patch is applied, its command runs once with no patch, under `FC_SEED` 42: the baseline. A claimed tag that fails there, a claimed tag no test carries, or a run that leaves no report is reported `BASELINE RED <patch>: [tag] fails without the mutant`. That patch is never applied and counts with the survivors: a test that fails by itself says nothing about the mutant. So does a claimed tag whose tests were all left out, by the header's own `-t` or by a skip (`no test carrying [tag] ran without the mutant`): it could never fail. An untagged patch's command must exit 0 there. Patches that share a command share one baseline run.

`pnpm prove:red [filter] --baseline-only` is the sweep: it takes the baselines and applies no patch, so it proves no mutant. It runs each command once, narrowed to every tag the patches sharing it claim, prints `baseline green <patch>` or `BASELINE RED <patch>: …` for each, and exits 1 if any baseline is red or any patch is stale. It finds the patches whose proof would lie at about one run for each test file. It is a screen: a patch it reports is then proved by itself, and that proof's own baseline is the judge.

The runner's own controls are `node scripts/prove-red.ts --dir test/controls/prove-red`, which must report its two-tag patch as a survivor and `red-without-mutant.patch`, whose command fails with no patch applied, as `BASELINE RED`. Generate a patch with `git diff -- <paths>` so it carries nothing else, and regenerate it when it reports `STALE`. A patch that no longer applies fails `pnpm guards` (the `patches-apply` guard): whoever moved the lines under it makes it again as the same edit, in the same change. In a repository the guard reads the index, so it says nothing of an edit until it is staged, and a mutant the runner has applied does not count against its own patch. When code was only reformatted, `node scripts/rebase-mutants.ts <ref before the format>` rebuilds the stale patches mechanically.

## Commits and contract changes

- `main` is trunk. Keep changes small, rebase on `main` before you push, and keep `main` green: a change that turns it red is fixed or reverted at once.
- Commit messages are plain and imperative. The subject says what changed; the body, when there is one, says why, in the author's own words. Never `--no-verify`.
- After the `contracts-v0` tag, contract changes are additive (a new operation, an optional field, a new port method) and each one gets a line in [CHANGELOG.md](CHANGELOG.md). A breaking change is marked as one in its CHANGELOG entry and says what a caller must do.
