# Changelog fragments

Each change describes itself in a file of its own in `changes/unreleased/`, never in [CHANGELOG.md](../CHANGELOG.md). Two changes that each add a line to CHANGELOG.md conflict when they are composed together; two new files never do.

A fragment is a Markdown file with a short, descriptive name (`changes/unreleased/sync-from-upstream.md`). It holds one or more sections, each a `### ` heading followed by its entries as a list:

```markdown
### Added

- **Sync from upstream.** `POST /v1/projects/{projectId}/sync` brings an imported project's trunk level with its upstream, fast-forward only.
```

The sections, in the order a release prints them: `Changed (breaking)`, `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed` and `Security`. A breaking change goes under `Changed (breaking)` and says what a caller must do.

`pnpm guards` (`changelog-fragments`) refuses a fragment that does not read this way, and any entry in CHANGELOG.md's Unreleased section.

To cut a release, `node scripts/changelog.ts release <version>` folds every fragment into CHANGELOG.md under `## <version> (<date>)`, each section's entries in file-name order, and removes the fragments. `node scripts/changelog.ts` prints what that section would read.
