### Added

- **A verification spends its namespace's container-minutes.** Before any step runs, KeelVerify admits one attempt of the plan's Tier 2 steps (each step's runner timeout, rounded up to the minute), and once the verdict is in it settles the count to what the runners reported. A deps build is counted once a UTC day for its install digest. Past the day's limit nothing runs: the batch parks unrun, saying how much was used and when the limit resets, and the lane forms nothing more until then. Limits come from the instance's `KEEL_QUOTAS`, under each namespace's own.
- **`KEEL_QUOTAS` takes `halted`, a list of namespace ids** whose verification spend is stopped. A halted namespace's changes bounce once, through no fault of their own, with what their owner does next: ask whoever runs the Keel to resume it, then submit again.
- **A submission while its namespace is halted is `403 namespace.halted`**, over REST and MCP, with the same next actions, and nothing is submitted: a verification there would run nothing and bounce the change.
- **`BatchAttribution` gains `halted`:** a batch failed because its namespace is halted. Every member bounces, and none is blamed.
