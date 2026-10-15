### Fixed

- **No external wait can hold an agent or a lane for good.**
  - Every git HTTP request Keel makes (to Artifacts or to an upstream) carries a deadline: gitcore's `GitRemote.deadlineMs`, which Keel sets for each remote through `gitRemote()` at `GIT_HTTP_DEADLINE_MS` (120 s). A request that never answers is aborted with a TimeoutError, its body included.
  - The waits that DOs hold are bounded where they wait:
    - a workspace's relay onto trunk (`RELAY_MS`, 120 s), so a declare whose grant relays answers `PoolExhausted` with a retry rather than hanging;
    - the Lane's move of staging onto trunk (`STAGING_MOVE_MS`, 240 s), so the step fails into its backoff rather than holding the Lane's alarm;
    - the Lane's wait on its MergeBox (`BOX_COMPOSE_MS`, 8 min, inside the box's lease), which is then `box-failed`.
  - Inside the box, git aborts a fetch or push that stalls below 1,000 bytes a second for 60 s (`GIT_HTTP_LOW_SPEED_*`), so one stalled transfer no longer holds the box past its lease.
  - On 15 Oct a git request that never answered held trunk's promotion for 20 minutes.
