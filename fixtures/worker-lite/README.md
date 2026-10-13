# worker-lite

A small Worker that Keel builds, previews and deploys. It is a test fixture for
Keel, and a project template on a Keel instance (`fixture-worker-lite`).

- `src/index.ts`: `/health` answers `ok`; `/` answers the greeting its
  `GREETING` var holds.
- `wrangler.jsonc`: the Worker's name, entry, compatibility date and vars.
- `.keel/deploy.json`: which of the project's deploy targets its previews and
  deploys go to, the Worker's name there, and the smoke checks a preview must
  pass before a change lands.

Its `package.json` dependencies and `pnpm-lock.yaml` are the same as
`fixtures/forge-lite`'s, byte for byte, so its suite and its build run on the
dependencies Keel's suite image already holds.
