### Fixed

- **A mirror that does not answer no longer holds up trunk.** Every Trunk deadline (debounce and push, the mirror's sync, an upstream sync, a destroyed project's repos) is bounded at `TRUNK_DEADLINE_MS` (2 minutes) and fails into the logged retry when it runs over. The mirror's sync steps aside while a promotion is armed, so trunk's push goes first. On 15 Oct a mirror sync hung 408 s on Artifacts' git, and the batch whose debounce was due behind it in the same alarm waited 20 minutes.
