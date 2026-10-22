### Fixed

- **A proposal moved to another commit carries that commit's footprint.** It kept its first commit's, so the review box, nearby and preflight named paths the proposal no longer touched and missed the ones it did. `ProposalUpdated` gains `footprint?` (each path the new commit touches against the proposal's base), the change takes it, and the project's index finds the proposal by it from then on, including a proposal opened before this release, from its next move.
