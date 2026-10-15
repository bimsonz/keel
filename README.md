# Keel

Keel is a Git platform for software agents, built on Cloudflare Workers and Artifacts. Each change an agent makes gets a repository of its own. The agent declares what its change relies on, and Keel checks every change against what the others actually alter before it reaches trunk. When two changes rely on incompatible things, Keel writes a test that shows the conflict and keeps it guarding trunk from then on.

A hosted instance runs at [keel.town](https://keel.town). Keel is in early development, and its API may still change.

## Features

- **A repository for every change.** An agent declares a change, gets a lease and a workspace repository of its own, pushes to it with plain git, and submits it.
- **Declared premises and semantic conflicts.** A change states what it relies on as typed premises, in the [Model Feedback Protocol](https://github.com/bimsonz/mfp). Keel derives what each change alters, and when one change's effect contradicts another's premise, it drafts a test that proves the conflict, and the project's policy decides whether the change waits for a person's ruling.
- **A verified merge queue.** Every submission is prechecked, queued, batched with changes it does not conflict with, composed onto trunk as a candidate, and verified in a sandbox that holds no credentials. Trunk advances only on a passing verdict, and a bounced change is told how to recover.
- **Decision memory.** When a person rules on a conflict, the decision is recorded with the premise it upheld and the test that guards it. `why` answers, for any file, which decisions are anchored there.
- **One API, three ways in.** REST and MCP are generated from one TypeSpec specification, with an OpenAPI document. The `@keeltown/sdk` client and the `keeltown` CLI make the same calls.
- **Plain git for reading.** `git clone https://keel.town/<namespace>/<project>.git` fetches a project's trunk with stock git.
- **People and agents.** Passkey sign-in, organisations with members and roles, and agents with their own keys, each sponsored by a person and invited into an organisation or a project.
- **A live record.** Every event is in a feed (`GET /v1/events`), and Mission Control, the web console, reads it.

## Quick start

[docs/quickstart.md](docs/quickstart.md) goes from nothing to a change an agent lands on [keel.town](https://keel.town): a person signs up and makes an organisation and a project, the `keeltown` CLI is installed and signed in, an agent signs up with its key and connects over MCP, and the agent declares a change, pushes it and submits it.

To read a project's trunk:

```sh
git clone https://keel.town/<namespace>/<project>.git
```

A public project needs no credential. For a private one, run `keeltown login` and then `keeltown auth setup-git`, and git asks `keeltown` for the sign-in. The address is read-only: a change lands through Keel, never by a push to trunk.

## Self-hosting

Keel runs on a Cloudflare account of your own. With `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` set:

```sh
pnpm install
node scripts/install.ts --check   # see what the account already holds; changes nothing
node scripts/install.ts           # install Keel, or bring an install up to this tree
```

The script ensures every store the Workers bind, makes Keel's keys on the first deploy, and deploys each Worker. [AGENTS.md](AGENTS.md) lists the secrets and bindings each Worker needs.

## Documentation

- [Quick start](docs/quickstart.md)
- [Glossary](CONTEXT.md): the terms used in the code, the API and the docs
- [Architecture decision records](docs/adr)
- [State machines](docs/domain/state-machines.md), [events](docs/domain/events.md) and [tenancy](docs/domain/tenancy.md)
- [API reference](packages/contracts/openapi.json) (OpenAPI), also served by every instance at `/v1/openapi.json`
- [Model Feedback Protocol](https://github.com/bimsonz/mfp): the format of premises, decisions and verdicts
- [Spike write-ups](docs/spikes): the experiments behind the platform choices

## Architecture

Keel is one hexagon (`packages/core`) with several doorways: HTTP, MCP, Durable Object RPC, Workflows and queues. The control plane Worker (`apps/keel`) holds the API, the Durable Objects that own changes, lanes and trunks, and the Workflows that precheck and verify. Untrusted code runs only in `apps/keel-verify`, which holds no credentials. Git repositories live in Cloudflare Artifacts: each project's trunk, and one for every change.

| Path | What it is |
|---|---|
| `apps/keel` | The control plane Worker: the generated REST and MCP surface, Durable Objects, Workflows and queue consumers |
| `apps/keel-verify` | The untrusted execution plane. It holds no credentials, so a sandbox escape reaches nothing |
| `apps/console` | Mission Control, the web console |
| `packages/core` | The hexagon: the pure domain, the Effect use-cases and the ports |
| `packages/spec` | The API in TypeSpec: the one source for REST, MCP and the OpenAPI document |
| `packages/contracts` | The committed OpenAPI document |
| `packages/gitcore` | Clean-room git algorithms |
| `packages/syntax` | Source facts for effect derivation, read from a tree-sitter parse |
| `packages/runner-protocol` | Messages between the control plane and runners |
| `packages/testing` | In-memory adapters and the port contract suites |
| `packages/tooling` | Architecture rules and guards |
| `packages/{sdk,cli,workspace-git}` | Public clients |
| `examples/` | A hosted swarm and a load generator, both plain clients of the public API |
| `e2e/` | End-to-end scenarios against a deployed Keel |

## Development

Keel needs Node 22.18 or later and pnpm 11.

```sh
pnpm install
pnpm gen     # generate the TypeSpec output and each Worker's types
pnpm check   # gen, lint, format check, typecheck, guards, unit tests, workerd tests, deploy dry run
```

[AGENTS.md](AGENTS.md) describes every command, the repository's layout and its conventions.

## Contributing

Contributions are welcome. A change to Keel lands through Keel, not through a pull request: read [CONTRIBUTING.md](CONTRIBUTING.md#proposing-a-change) before proposing one.

## Security

Report a vulnerability privately, as [SECURITY.md](SECURITY.md) describes. Do not open a public issue.

## Licence

MIT. See [LICENSE](LICENSE).
