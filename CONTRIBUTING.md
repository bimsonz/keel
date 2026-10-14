# Contributing to Keel

Thank you for helping. This page says how to propose a change. [AGENTS.md](AGENTS.md) holds the commands, the repository layout and the conventions in full, for people and coding agents alike; [CONTEXT.md](CONTEXT.md) holds the terms to use.

## Setting up

You need Node 22.18 or later and pnpm 11.

```sh
git clone https://github.com/bimsonz/keel.git
cd keel
pnpm install
pnpm gen
```

`pnpm gen` regenerates the TypeSpec output and each Worker's types, which are not committed. Run it again after any change to `packages/spec` or to a `wrangler.jsonc`.

## Running the checks

```sh
pnpm check
```

`pnpm check` runs what CI runs, in the same order: generation, lint, format check, typecheck, the workspace guards, the unit and architecture tests, each Worker's tests inside workerd, and a deploy dry run. A pull request is ready for review when it is green. Run `pnpm format` on your changes before you push.

## Tests and mutation proofs

A check counts only once it has been seen to fail. A new rule or guard lands with a control fixture under `test/controls/`, and `pnpm tooling:controls` must turn every control red. A new property test lands with a seeded wrong implementation: a patch under `test/mutants/` whose header names the command that must fail and the test tags it must kill.

```sh
pnpm prove:red <filter>
```

applies each matching patch, runs its tests, reverts it, and reports any patch that survives. Generate a patch with `git diff -- <paths>`, and regenerate it when the runner reports it `STALE`. [AGENTS.md](AGENTS.md#proving-a-check) describes the runner in full.

## Commit messages

Write plain, imperative subjects that say what changed, such as "Refuse a lease renewal after the lease has lapsed". Use the body to say why. Keep each commit to one change, and use the terms in [CONTEXT.md](CONTEXT.md).

## Pull requests

- Open pull requests against `main`, rebased on its current head.
- Say what the change does and why, and how you checked it.
- A change to a contract (the API in `packages/spec`, the ports, the DO RPC contracts or the runner protocol) adds a changelog fragment, a file of its own in `changes/unreleased/` ([changes/README.md](changes/README.md)), rather than a line in [CHANGELOG.md](CHANGELOG.md), which a release writes. Contract changes are additive; a breaking change says so in its entry and in the pull request.
- Read the relevant [ADR](docs/adr) before changing a boundary one fixes.

## Reporting a vulnerability

Do not open a public issue. Follow [SECURITY.md](SECURITY.md).

## Licence

Keel is MIT licensed. By contributing, you agree that your contributions are licensed under the [MIT Licence](LICENSE).
