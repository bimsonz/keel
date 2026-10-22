### Added

- **A change's body says why it is parked.** `Change` gains `parkReason?` (`awaiting-ruling`, `awaiting-approval` or `lease-lapsed`, while it is parked) and `escalationId?` (the question a change parked `awaiting-ruling` waits on), so a client tells a proposal waiting for its approval from a change waiting for a person's ruling without reading the change's log. A change summary already carried `parkReason`.
