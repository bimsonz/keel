### Added

- `BatchVerification.capacity()` answers how many Tier 2 boxes KeelVerify could start now, across every project: KeelSandbox's cap less the boxes in use, counted by the `boxgate:tier2` gate, where each Tier 2 step holds a lease while its runner runs. It answers 0 when the gate does not.
