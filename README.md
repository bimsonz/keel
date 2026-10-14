# Keel

**Agents don't collide on lines. They collide on beliefs.**

Keel is an agent-first Git platform on Cloudflare Workers and Artifacts. Thousands of agents change one codebase concurrently. Every change runs in its own throwaway repo, declares what it relies on, and is checked against what other changes actually alter. When two changes believe incompatible things, Keel writes the test that proves it, and that test guards trunk from then on.

Status: under active construction for Cloudflare's *Build the next Git platform* competition.

- Hosted at [keel.town](https://keel.town)
- Claims format: [Model Feedback Protocol](https://github.com/bimsonz/mfp)
- Language: [CONTEXT.md](CONTEXT.md) · Decisions: [docs/adr](docs/adr) · Working here: [AGENTS.md](AGENTS.md)

## What works (v0.1)

Live on [keel.town](https://keel.town) at the tag `v0.1`:

- **A bounced agent rebases itself.** `rebase` puts trunk's head into the change's own repo as `keel/trunk`; the agent merges it with plain git, resolves, pushes and submits again. In the run of two real agents, one bounced at composition, called `rebase` without being told to, merged, resolved and landed.
- **Agents work through Keel over REST or MCP, through one handler.** An agent enrols, declares a change (a lease plus an Artifacts repo of its own), pushes to it with plain git, submits, and reads its status and inbox. `@keeltown/sdk` and the `keeltown` CLI make the same calls.
- **Trunk moves only through verified candidates.** Each submitted change is prechecked, queued, composed onto trunk as a candidate, and verified in KeelVerify's sandbox, which holds no credentials. Trunk advances only when a verdict says land, and every advance names its landings. Nothing audits trunk after a landing: that it stays green rests on each candidate being verified before it is promoted.
- **Conflicts and failures bounce with next actions.** A same-line textual conflict bounces at composition, and its next actions say how to rebase. A failing change bounces at verification. Trunk is untouched either way.
- **A negative control proves the check can fail.** In a project with verification switched off, the same red change lands, marked `verified: false`.
- **Everything is live.** Every event is in the feed (`GET /v1/events`, a long-poll with a cursor), and Mission Control reads it.

S-0 (`e2e/src/s0.ts`) runs the conflict, failure and landing cases as one scenario against a deployed Keel; it was green twice in a row on the `v0.1` deploy, 9 of 9 checks each time.

Not yet in `v0.1`: declared premises and semantic conflict detection, a hunk-level merge of two changes to different parts of one file, withdrawing a change, and sign-up.

## Use Keel

[docs/quickstart.md](docs/quickstart.md) goes from nothing to a change an agent lands on [keel.town](https://keel.town): a person signs up with a passkey and makes an org and a project, `keeltown` is installed and signed in, an agent signs up with its key, connects over MCP and is sponsored and invited, and then declares a change, pushes it to its own workspace and submits it.

`git clone https://keel.town/<namespace>/<project>.git` fetches a project's trunk with stock git: its `main` and no other ref. A public project needs no credential. For a private one, `keeltown login` and then `keeltown auth setup-git` have git ask `keeltown` for the sign-in, so the clone needs nothing pasted; an agent passes its token as git's bearer for the one command. The address is read-only: a change lands through Keel (declare it, push to its own workspace, submit it), never by a push to trunk.

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
| `packages/syntax` | Source facts for effect derivation, read from a tree-sitter parse |
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
