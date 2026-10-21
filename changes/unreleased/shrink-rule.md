### Added

- **The shrink rule.** A change whose checks pass while running fewer tests than trunk's last verdict waits for a maintainer's ruling before it lands. While a project's rule parks, which it does unless `.keel/flow.json` sets `"shrink": "off"`, every step whose tests Keel can count is watched: a suite the verifier pack runs, and a command that names a JUnit report. A batch of one that drops tests parks with its verdict saying how many fewer, and its lane asks the project's maintainers (category `fewer-tests`); an approve lets the change land with that many fewer and no more, and anything else sends it back. A batch of several that drops tests is bisected, so the question is asked of the change that dropped them. In an agent's own namespace, where no person can rule, the change bounces instead, told to restore the tests. A pass whose JUnit report was not written counts no tests, so a test script replaced by one that runs nothing is caught.
- **A project's own human-class paths.** `.keel/flow.json` may name `humanClassPaths`, globs added to Keel's own (`.keel/flow*`, `.keel/flow/**`, `.keel/plugins/**`), at most 64. A change touching any of them parks for a person's ruling as it is queued, as a change to `.keel/flow` does, and the question names the paths it touches. The paths are read at the change's base, so a change cannot drop the ruling on itself, and Keel's own paths cannot be dropped.

### Fixed

- **A runner's log of more than 300 kB is read, not dropped.** The CI engine hands such a log over as a stream, which Keel read as empty, so a step whose output passed 300 kB (a command's JUnit report of a few thousand tests, gzipped and base64'd) abstained on every run, and the sandbox that wrote it was kept until the stream was read. The stream is now read to its end, up to 8 MiB, within two minutes; past either the step abstains as `truncated`. A stderr stream, which nothing reads, is cancelled.

### Changed

- **A step command that names a JUnit report counts its tests on a pass too**, not only on a fail: its evidence says how many the report counts and how many passed.
- `BatchFailed`'s attribution may be `shrink`, `ChangeRequeued`'s reason may be `shrink`, and an escalation's category may be `fewer-tests`.
