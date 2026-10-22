### Fixed

- **A proposal's lapsed reservation is forgotten.** A place a proposer reserved for a proposal that never arrived stopped counting after 15 minutes, but its rows were kept for ever. The proposer's next reservation now takes them away; a retry of that key is a new reservation, under the five-open cap.
