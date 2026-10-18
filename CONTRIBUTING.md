# Contributing to Keel

Thank you for helping. This page says how to propose a change. [AGENTS.md](AGENTS.md) holds the commands, the repository layout and the conventions in full, for people and coding agents alike; [CONTEXT.md](CONTEXT.md) holds the terms to use.

## Setting up

You need Node 22.18 or later and pnpm 11.

```sh
git clone https://keel.town/keel/keel.git
cd keel
pnpm install
pnpm gen
```

`pnpm gen` regenerates the TypeSpec output and each Worker's types, which are not committed. Run it again after any change to `packages/spec` or to a `wrangler.jsonc`.

## Running the checks

```sh
pnpm check
```

`pnpm check` runs what CI runs, in the same order: generation, lint, format check, typecheck, the workspace guards, the unit and architecture tests, each Worker's tests inside workerd, and a deploy dry run. A change is ready to submit when the checks are green. Run `pnpm format` on your changes before you push.

## Tests and mutation proofs

A check counts only once it has been seen to fail. A new rule or guard lands with a control fixture under `test/controls/`, and `pnpm tooling:controls` must turn every control red. A new property test lands with a seeded wrong implementation: a patch under `test/mutants/` whose header names the command that must fail and the test tags it must kill.

```sh
pnpm prove:red <filter>
```

applies each matching patch, runs its tests, reverts it, and reports any patch that survives. Generate a patch with `git diff -- <paths>`, and regenerate it when the runner reports it `STALE`. [AGENTS.md](AGENTS.md#proving-a-check) describes the runner in full.

## Commit messages

Write plain, imperative subjects that say what changed, such as "Refuse a lease renewal after the lease has lapsed". Use the body to say why. Keep each commit to one change, and use the terms in [CONTEXT.md](CONTEXT.md).

## Proposing a change

A change to Keel lands through Keel, never through a pull request: trunk takes no push, and Keel verifies every change before trunk advances. [docs/quickstart.md](docs/quickstart.md#5-land-a-change) walks through the steps with the `keeltown` CLI; each one is also an MCP tool of the same name.

Declaring a change on keel/keel takes a place in the `keel` org: its members, and the agents they invite, land changes here. If you are not a member, you can still help:

- **Report a bug or ask for something** in an issue at [github.com/bimsonz/keel/issues](https://github.com/bimsonz/keel/issues). Issues on keel.town itself are being built and will take over from these.
- **Propose a change from a fork** of keel/keel, once that is built: a maintainer approves each proposal before Keel verifies and lands it. Until then, describe the change in an issue.
- **Report a vulnerability** privately, as [SECURITY.md](SECURITY.md) says, never in an issue.

The steps below are a member's.

1. **Ask `why`** about each file you mean to change. Keel answers with the decisions anchored there and the guards that hold them, so your change does not undo what was decided. Read the relevant [ADR](docs/adr) before changing a boundary one fixes.
2. **Declare** the change before you write code: a goal that says what it does and why, its footprint (the paths it edits, creates or deletes), and any premises it relies on about code it does not own. Keel answers with a workspace of the change's own, starting at trunk's head, a lease, and a preflight that names the changes near yours; `nearby` asks again later. Leave alone what a neighbour is already changing.
3. **Commit** to the change's workspace: push to its remote with its token, or call `commit`, which needs no clone. The message follows the rules above; say in its body how you checked the change.
4. **Submit** the commit under the lease once `pnpm check` is green. A push alone lands nothing.
5. **Wait in the inbox.** Keel tells you there as the change moves through precheck, the queue and verification. It has landed only when the inbox says `ChangeLanded`. A `ChangeBounced` notice says what to do: fix what it names, `revise` the footprint if the change has grown, commit, and submit again under the same lease.

A change to a contract (the API in `packages/spec`, the ports, the DO RPC contracts or the runner protocol) adds a changelog fragment, a file of its own in `changes/unreleased/` ([changes/README.md](changes/README.md)), rather than a line in [CHANGELOG.md](CHANGELOG.md), which a release writes. Contract changes are additive; a breaking change says so in its entry and in its goal.

## Reporting a vulnerability

Do not open a public issue. Follow [SECURITY.md](SECURITY.md).

## Licence

Keel is MIT licensed. By contributing, you agree that your contributions are licensed under the [MIT Licence](LICENSE).
