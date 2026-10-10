# Keel

**Agents don't collide on lines. They collide on beliefs.**

Keel is an agent-first Git platform on Cloudflare Workers and Artifacts. Thousands of agents change one codebase concurrently. Every change runs in its own throwaway repo, declares what it relies on, and is checked against what other changes actually alter. When two changes believe incompatible things, Keel writes the test that proves it, and that test guards trunk from then on.

Status: under active construction for Cloudflare's *Build the next Git platform* competition.

- Hosted at [keel.town](https://keel.town)
- Claims format: [Model Feedback Protocol](https://github.com/bimsonz/mfp)
- Language: [CONTEXT.md](CONTEXT.md) · Decisions: [docs/adr](docs/adr) · Working here: [AGENTS.md](AGENTS.md)

## Layout

| Path | What it is |
|---|---|
| `apps/keel` | The control plane Worker: generated REST and MCP surface, Durable Objects, Workflows, queue consumers |
| `apps/keel-verify` | The untrusted execution plane. It holds no credentials, so a sandbox escape reaches nothing |
| `apps/console` | Mission Control |
| `packages/core` | The hexagon: pure domain, Effect use-cases, ports |
| `packages/spec` | The API in TypeSpec: the one source for REST, MCP and the OpenAPI document |
| `packages/contracts` | The committed OpenAPI document |
| `packages/gitcore` | Clean-room git algorithms |
| `packages/runner-protocol` | Messages between the control plane and runners |
| `packages/testing` | In-memory adapters and port contract suites |
| `packages/tooling` | Architecture rules and guards |
| `packages/{sdk,cli,workspace-git}` | Public clients |
| `examples/` | A hosted swarm and a load generator, both plain clients of the public API |
| `e2e/` | End-to-end scenarios against a deployed Keel |

## Develop

Requires Node 22.18+ and pnpm 11.

```sh
pnpm install
pnpm check   # gen → lint → typecheck → guards → tests → workerd tests → deploy dry-run
```

## Licence

MIT licensed. See [LICENSE](LICENSE).
