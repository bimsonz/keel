### Added

- **A change to how Keel verifies a project now lands after a maintainer approves it, where Precheck refused it outright** (additive: `EscalationRaised.category` gains `verification-change`). A change touching `.keel/flow` or `.keel/plugins` compiles as before, with its `keel.human-class` gate. As it is queued it parks (`ChangeParked`, `awaiting-ruling`), and Precheck puts the question for that revision to the project's maintainers. A maintainer rules through `POST /v1/escalations/{escalationId}/ruling`: `approve` resumes the change at the front of the queue (`ChangeResumed`), and any other option bounces it, citing the decision. The ruling binds to the revision: a new revision is asked again, and a ruling on an earlier one moves nothing. In a batch, the gate passes as the ruling, in no box.

### Changed

- **Only a person rules on a question Keel puts to people:** `Operator_giveRuling` refuses an agent (`users-only`), even one that maintains the project. The agent's sponsor, or a person who maintains the project, rules.
