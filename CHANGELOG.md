# Changelog

All notable changes to Keel's contracts are documented here: the public API (`packages/spec`, emitted to `packages/contracts/openapi.json`), the MFP schema it imports, the ports in `packages/core/src/application/ports`, the DO RPC contracts in `apps/*/src/rpc`, and the runner protocol in `packages/runner-protocol`.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). From `contracts-v0` on, every contract change gets an entry. Contract changes are additive (a new operation, an optional field, a new port or RPC method); a breaking change is listed under **Changed (breaking)** and says what a caller must do.

Entries for the next release are kept as fragments in [`changes/unreleased/`](changes/README.md), one file a change, and folded in here when a release is cut, so the Unreleased section below stays empty.

## Unreleased

## contracts-v0 (10 Oct 2026)

Changes since `contracts-v0-rc1` (`1e7c5cb`, 10 Oct 2026). Everything is additive or a fix except the `EventOutbox` reshape, which landed before the freeze.

### Added

- `AgentDirectory.verifyCredential(clientId, secret)`: the adapter hashes and compares in constant time, so a client secret never leaves it.
- `declaredEffects?: MFP.Proposition[]` on declaring and revising a change. Advisory only: Keel derives effects from the diff.
- Kernel: pure content hashing (`ContentHash`, `sha256:` + 64 hex) and glob matching.
- Identity: every agent is enrolled in exactly one project. `Agent.projectId`, `Principal.projectId`, the token's `prj` claim, `AgentEnrolled.projectId`, the D1 column `agents.project_id` (migration 0002) and `projectId` on the API's `AgentProfile`.
- Ports `Changes` (the isolate's gateway to the Change DOs: `declare`, `submit`, `get`, `awaitSubmission`) and `Inbox` (`read`, long-polling), each with an in-memory adapter.
- Change RPC `submission(waitMs)`, answering `SubmissionStatus {change, commitSha}`; AgentSession RPC `reserveChange({idempotencyKey, fingerprint})` (a declare retried with the same key reaches the same change; the same key with another body is `IdempotencyConflict`) and `inbox({cursor, waitMs})`.
- Identity domain: `IdempotencyConflict`, and the `AgentNotice` and `InboxPage` schemas (the `Notifier` port re-exports `AgentNotice`, unchanged in shape).
- `CodeHost.diffTrees(repo, base, head)`: the leaves that differ between two commits, as `git diff-tree -r --no-renames` reports them, as `TreeChange` rows in bytewise path order. Unchanged subtrees are skipped by id.
- `CodeHost.delete(repo)`: idempotent. Workspaces are collected by deleting their repo.
- `CodeHost.info(repo)`: `{remote, defaultBranch}`. The remote's host carries the account id, so it goes only to a grant's holder and is never logged.
- `WorkspaceGrant.baseSha` and `WorkspaceGranted.baseSha`: the workspace's head at grant time, which is the change's base. Precheck diffs against it, so a mirror that lags trunk can't leave the base missing.
- WorkspacePool: `grant` is idempotent per holder; a retry returns the same workspace with a freshly minted token. `release(workspaceId, reason?)` takes the `WorkspaceCollected` reason (`landed`, `withdrawn` or `expired`; `withdrawn` when absent). The RPC gains `configure({source, target})` and `status()`.
- `commit()` in the ports: read the clock, then in one `EntityStore` transaction either return what the cause already committed or run the decision and append its events (gap-free `seq` per entity, dedupe keys `<kind>:<id>/<cause>/<type>#<n>`, `notified[]` from the subscription table at commit time). A refusal rolls back every write.
- `EventReceiverRpc.receive(envelopes)`: every Keel Durable Object receives events through this one method; `ChangeRpc`, `AgentSessionRpc` and the other DO contracts extend it. `DeliveryReceipt` and `EventCodecs` in `apps/keel/src/rpc/events.ts`.
- `CodeHostFixture` in `@keeltown/testing`: `commit(repo, ref, files)` and `scratch()`, provided by `makeCodeHostMemory().layer`. Tests seed repos through it, because `CodeHost` never writes git content.

### Fixed

- Scopes are per operation. Each operation now demands only its own scope; the OAuth flow model used to list all four, which overrode the operations and made every operation demand all of them.
- The Change RPC `submit` codec now carries submit's own errors, `ChangeNotFound | LeaseStale | ChangeStateRefused | CommitNotInWorkspace`. It had `RevisionMismatch`, which belongs to revise alone.

### Changed

- `EventOutbox` is reshaped around the outbox fan-out: `append(spec, at, drafts)`, `committed(entity, cause)`, `log(entity)`, `subscribe`, `unsubscribe`, `subscribers(type)` and `receive(dedupeKey, at)`, with its in-memory adapter on the in-memory `EntityStore` so one transaction covers both. It replaces rc1's `append`/`pending`/`acknowledge`.
- The MFP library is pinned at `github:bimsonz/mfp#v0.1.0-pre.3`.
- `CodeHost` reads fail with typed errors instead of dying: `RepoNotFound` (every read, `diffTrees`, `mintToken`, and `fork`'s source), `RefNotFound` (`head`), and `ObjectNotFound` (`readTree`, `readBlob`, and `diffTrees` when the repo lacks `base` or `head`). This narrows the error channels, but the port had no callers yet. Transport failures stay defects. `TreeEntry.type` gains `"commit"` for submodules, and `readTree` is documented as the commit's recursive listing.
- The in-memory `CodeHost` stores real git objects through gitcore. It fails `RepoNotFound` for a repo it never created or has deleted; it used to create the repo on the first read. Its `seed()` is replaced by `CodeHostFixture`.

## contracts-v0-rc1 (10 Oct 2026)

The interface freeze candidate: the TypeSpec spec and its OpenAPI document, the MFP schema v0, every port with an in-memory adapter and contract-suite stub, the use-case signatures, the DO RPC contracts with the Exit envelope, and the runner protocol v0.
