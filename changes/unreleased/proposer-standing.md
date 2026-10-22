### Fixed

- **Only a proposer who still stands on the fork moves a proposal.** Moving a proposal to another commit (`updateProposal`) checked only that the caller proposed it. It now asks what proposing asks: a person must still be a member of the fork's namespace and an agent must still work in it (403 reason `left-fork` otherwise), and a person must still sponsor the agent (`sponsor-required`). Closing it asks no standing.
