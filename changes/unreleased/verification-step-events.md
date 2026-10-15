### Added

- `VerificationStepStarted` and `VerificationStepFinished` on a project's public feed: each step of a batch's plan (`keel.check`, `keel.test`, `js-ts.typecheck`…) as KeelVerify runs it, with its kind and tier at the start, and at the end its outcome as the verdict reads it, its evidence class, the runner's duration, its stored evidence's hash and, for an abstain with no judgement, why. The Lane DO commits them while the batch verifies, fenced on its attempt and chain epoch; a step started and never finished is closed by the event that ended its batch.
