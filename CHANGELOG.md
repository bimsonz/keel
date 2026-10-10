# Changelog

Keel's contracts: the public API (`packages/spec`, emitted to `packages/contracts/openapi.json`), the MFP schema it imports, the ports in `packages/core/src/application/ports`, the DO RPC contracts in `apps/*/src/rpc`, and the runner protocol in `packages/runner-protocol`.

From `contracts-v0` on, every contract change gets a line here. Contract changes are additive (a new operation, an optional field, a new port or RPC method); a breaking change is listed under **Changed (breaking)** and says what a caller must do.

## Unreleased

### Added

- Change RPC commands `DeclareCommand` (`changeId`, checked by the DO against its own name; `agentId`, `projectId`, `origin` defaulting to `agent`, the intent, `sketchId?`, `idempotencyKey` as the commit's cause, and `fingerprint`) and `SubmitCommand` (`agentId`, `leaseId`, `commitSha`, `idempotencyKey`). `ChangeRpc.declare` and `submit` take their encoded forms instead of `unknown`.
- Change RPC for Precheck, implemented in the Change DO: `workspace()` answers `ChangeWorkspace {workspaceId, repo, baseSha, projectId}`; `precheckStarted(PrecheckStartedCommand {revision, instanceId})` commits PrecheckStarted and answers the change; `precheckRefused(PrecheckRefusedCommand {revision, instanceId, reasons, nextActions})` commits VerdictIssued (`bounce`, `ruling`) and ChangeBounced in one transaction and answers `{change, verdictId}`; `planCompiled(PlanCompiledCommand {revision, instanceId, planHash, steps, costEstimate})` commits PlanCompiled and answers the change. Each is idempotent by `instanceId` (cause `<instanceId>:<method>`) and fails with `ChangeNotFound | ChangeStateRefused`, the latter for a stale revision. `nextActions` is the kernel `NextAction`, never empty, and goes onto ChangeBounced. `RepoRef` is exported from the WorkspacePool contract.
- The Change and Lease state machines: `decideChange(state, command, {now, changeId})` and `evolveChange(state, {at, payload})`, with `replayChange`, the `ChangeCommand` union and the `ChangeEvent` schema; lease helpers `isLapsed`, `lapsesAt`, `checkLease` and `renew`. Kernel `Decide` takes a trailing `facts` parameter; new `Committed<E>`, `IllegalTransition` and the `NextAction` schema.
- Event `ChangeStarted {changeId, workspaceId}` (Declared → Working). `ChangeBounced.nextActions?` (never empty when emitted). Optional `commitSha`, `laneId`, `batchId` and `escalationId` on `Change`.
- Errors `ChangeBlocked` and `LeaseNotLapsed`; `LeaseStale` gains `reason?: stale|lapsed`, and every change error gains `nextActions?`.
- The Candidate and trunk Promotion state machines: `decideCandidate`/`evolveCandidate`/`replayCandidate` with `CandidateCommand`, `CandidateEvent`, `isBisectable`, `isCandidateTerminal`; `decidePromotion`/`evolvePromotion`/`replayPromotion` with `PromotionCommand`, `TrunkEvent`, `CommutationFacts`, `pushTarget`; schemas `Trunk`, `QueuedBatch`, `PendingGroup`.
- Entity kind `trunk` (`trunk:<projectId>`). Events `TrunkInitialized {projectId, head, by}`, `PromotionStarted` (the WAL entry) and `PromotionComposed {projectId, groupId, sha}`. `BatchFailed.attribution` gains `unattributed`; `PromotionDeclined.reason` gains `frozen`. Optional `projectId` and `predecessors` on `BatchFormed`, `members`, `base` and `predecessors` on `BatchVerified`, `head` on `PromotionResumed`, `predecessors` and `attribution` on `Batch`.
- Errors `CandidateStateRefused`, `ResultFenced` (terminal: a fenced result is never retried), `InvalidBatch`, `TrunkNotInitialized`, `PromotionStateRefused`.
- `ChangeStarted.baseSha?` and `Change.baseSha?`: the workspace's head at grant, which Precheck diffs against (the `Start` command requires it).
- Change RPC commands `ReviseCommand` (`agentId`, `leaseId`, `ifMatchRevision`, the revised intent, `idempotencyKey`), `AbandonCommand` (`agentId`, `authority`: the lease holder's `{_tag: "Lease", leaseId}` or `{_tag: "Operator", by}`, `reason?`, `idempotencyKey`) and `AdoptCommand` (`agentId`, `idempotencyKey`). `ChangeRpc.revise`, `abandon` and `adopt` take their encoded forms instead of `unknown`.
- The Workspace, Sketch and Agent state machines: `decideWorkspace`/`evolveWorkspace`/`replayWorkspace`, `decideSketch`/`evolveSketch`/`replaySketch` with `sketchExpired`, `decideAgent`/`evolveAgent`/`replayAgent`; schemas `Workspace`, `WorkspaceState`, `Sketch`, `SketchState`; `WorkspaceEvent`, `SketchEvent`, `AgentEvent`.
- Event `WorkspaceReassigned {workspaceId, sketchId, changeId}`. Errors `WorkspaceStateRefused`, `SketchStateRefused {reason?: expired, nextActions}`, `AgentStateRefused`.
- `VerdictIssued.planHash` is optional: absent only for a Precheck refusal, a ruling-class verdict with no compiled plan. A present hash always resolves to a plan.
- `EventDraft.entity?`: a draft may name another entity its Durable Object owns (the Change DO's verdicts). That entity gets its own gap-free `seq` and dedupe keys; the default is still `CommitSpec.entity`.

- `WorkspaceGrant.repo: RepoRef`, on the port and on the WorkspacePool RPC's grant: the workspace's repo on the code host. The Change DO keeps it for `hasCommit` and Precheck for `diffTrees`. It is never logged next to the remote.
- WorkspacePool use-cases in `@keeltown/core/application/coordination`: `grantWorkspace`, `refillPool`, `releaseWorkspace`, `collectWorkspaces`, `configurePool` and `poolStatus`.
- `CodeHost.hasCommit(repo, sha) => Effect<boolean, RepoNotFound>`: whether the repo holds a commit, in one object read. Submit's commit-in-workspace check uses it.

- The work loop's first operations, end to end: `declare`, `submit`, `status` and `inbox` reach one handler object over REST and MCP. The isolate's use-cases `declareChange`, `submitChange`, `submissionOf` and `readInbox` (`application/coordination/gateway.ts`); `Changes` and `Inbox` over Durable Object RPC (`adapters/driven/do-rpc`), with `fingerprint` a SHA-256 of the canonical declare body.
- ProblemCodes `change.not_found`, `change.lease_stale`, `change.state_refused`, `change.commit_not_in_workspace`, `workspace.pool_exhausted` (503 with `retryAfterMs` and `retry-after`) and `sketch.not_found`. `declare` gains a 404 for an unknown sketch.
- Contract suites for `Changes` (10 cases) and `Inbox` (4 cases) in `@keeltown/testing`. A real adapter registers with a harness (`push` a commit into a grant's workspace, `deliver` a notice). The in-memory adapters wait with deadlines, as the DOs do; declare answers `working`; and a submit replays by its Idempotency-Key.
- Project RPC `createProject(CreateProjectCommand {projectId, name, source, by, idempotencyKey, fingerprint})`, answering `ProjectView {id, name, createdAt}` and failing with `IdempotencyConflict | RepoNotFound`. The isolate derives `projectId` from the operator and the Idempotency-Key; `source` is the core-namespace repo trunk is forked from; `RepoNotFound` is CodeHost's error carried by shape (rule R15). The Project DO answers NotImplemented until it is built.
- AgentSession RPC `enrol(EnrolCommand {projectId, name, kind, scopes, clientId, secretHash, idempotencyKey, fingerprint})`, answering `Agent` and failing with `IdempotencyConflict`. It writes the D1 projection before answering; a same-key replay replaces `secretHash`. NotImplemented until it is built.

- Lane RPC `recordVerdict(RecordVerdictCommand {instanceId, fence: {batchId, attempt, chainEpoch}, candidateId, verdictId, outcome, planHash, evidence, failingTests})` (implemented in the Lane DO): KeelVerify's verdict on a batch's candidate. The lane commits VerdictIssued with BatchVerified (a land) or BatchFailed (anything else, attributed by the lane from `failingTests`) in one transaction. Idempotent by `instanceId` (cause `<instanceId>:recordVerdict`); answers nothing, or fails `ResultFenced` (terminal) or `CandidateNotFound`.
- Runner protocol: the candidate bundle format (shared with the candidate composer). `writeBundle(files)` writes a gzipped ustar archive under one top directory (`BUNDLE_ROOT`, stripped by the archive checkout) with `.keel-bundle.sha256` (`BUNDLE_MANIFEST`, sha256sum lines) at its root; a bundle's address is `sha256:` + `sha256Hex` of its bytes. Regular files only (`BundleRefused` otherwise). `bundleUrl(hash)` names it on the virtual host `bundles.keel.internal`, and `VERIFY_BUNDLE_SH` is the sh function a runner uses to check an extracted tree against the manifest before running anything.

### Changed

- The submission status operation is an MCP tool: `@tag("mcp")` with `@operationId("status")`. Its operationId was `Submissions_getSubmission` (an unused rename), so an agent over MCP can wait on its own submission.
- `ChangeCodecs.declare` answers `{change, preflight, grant: WorkspaceGrant}` and fails with `ChangeStateRefused | PoolExhausted | SketchNotFound`, because the Change DO takes its workspace before it decides (unused since contracts-v0).

## contracts-v0 (10 Oct 2026)

Changes since `contracts-v0-rc1` (`3e7c7f1`, 10 Oct 2026). Everything is additive or a fix except the `EventOutbox` reshape, which landed before the freeze.

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
