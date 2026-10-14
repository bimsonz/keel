### Added

- **Changelog fragments.** A change records its entry in a file of its own under `changes/unreleased/` (`changes/README.md`), and `node scripts/changelog.ts release <version>` folds them into CHANGELOG.md, whose Unreleased section stays empty. The `changelog-fragments` guard refuses an entry written there and a fragment that does not read as one. Concurrent changes no longer conflict on CHANGELOG.md.
