### Changed

- A step no runner can run (a world at a lane, a deploy with no deploy runner, a Tier 2 step with no command) abstains `no-runner` instead of `unavailable`, and a Tier 2 box the engine gave up on abstains `unavailable`. A stored step report that says `no-runner` does not decode on a build from before this change, so a rollback past it cannot read those reports.
