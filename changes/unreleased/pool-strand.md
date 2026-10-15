### Fixed

- **A pool no longer stays exhausted on slots a dead pass left behind.**
  - A grant collects every slot left `forking` past `RECLAIM_FORKING_MS` (past the longest fork or fill), by its state alone; a declare never reads Artifacts to do it.
  - A slot left `refreshing` past `STUCK_REFRESH_MS` is read back by a refresh pass, which a grant now arms at once. One that cannot be read is collected, where it used to stay refreshing for good.
  - The claim's deadline keeps its earliest time: each declare used to push it two minutes out, so while declares kept coming no pass ever ran.
  - Every `pool_exhausted` answer logs the pool's counts as one JSON line (`pool-exhausted`).
  - On 15 Oct keel/keel answered every declare `pool_exhausted` for an hour.
