# Changelog

Keel's contracts: the public API (`packages/spec`, emitted to `packages/contracts/openapi.json`), the MFP schema it imports, the ports in `packages/core/src/application/ports`, the DO RPC contracts in `apps/*/src/rpc`, and the runner protocol in `packages/runner-protocol`.

From `contracts-v0` on, every contract change gets a line here. Contract changes are additive (a new operation, an optional field, a new port or RPC method); a breaking change is listed under **Changed (breaking)** and says what a caller must do.

## Unreleased

Changes since `contracts-v0-rc1` (`3e7c7f1`, 10 Oct 2026), all additive or fixes:

### Added

- `AgentDirectory.verifyCredential(clientId, secret)`: the adapter hashes and compares in constant time, so a client secret never leaves it.
- `declaredEffects?: MFP.Proposition[]` on declaring and revising a change. Advisory only: Keel derives effects from the diff.
- Kernel: pure content hashing (`ContentHash`, `sha256:` + 64 hex) and glob matching.
- Identity: every agent is enrolled in exactly one project. `Agent.projectId`, `Principal.projectId`, the token's `prj` claim, `AgentEnrolled.projectId`, the D1 column `agents.project_id` (migration 0002) and `projectId` on the API's `AgentProfile`.
- Ports `Changes` (the isolate's gateway to the Change DOs: `declare`, `submit`, `get`, `awaitSubmission`) and `Inbox` (`read`, long-polling), each with an in-memory adapter.
- Change RPC `submission(waitMs)`, answering `SubmissionStatus {change, commitSha}`; AgentSession RPC `reserveChange({idempotencyKey, fingerprint})` (a declare retried with the same key reaches the same change; the same key with another body is `IdempotencyConflict`) and `inbox({cursor, waitMs})`.
- Identity domain: `IdempotencyConflict`, and the `AgentNotice` and `InboxPage` schemas (the `Notifier` port re-exports `AgentNotice`, unchanged in shape).

### Fixed

- Scopes are per operation. Each operation now demands only its own scope; the OAuth flow model used to list all four, which overrode the operations and made every operation demand all of them.
- The Change RPC `submit` codec now carries submit's own errors, `ChangeNotFound | LeaseStale | ChangeStateRefused | CommitNotInWorkspace`. It had `RevisionMismatch`, which belongs to revise alone.

### Changed

- The MFP library is pinned at `github:bimsonz/mfp#v0.1.0-pre.3`.

## contracts-v0-rc1 (10 Oct 2026)

The interface freeze candidate: the TypeSpec spec and its OpenAPI document, the MFP schema v0, every port with an in-memory adapter and contract-suite stub, the use-case signatures, the DO RPC contracts with the Exit envelope, and the runner protocol v0.
