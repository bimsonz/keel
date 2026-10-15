### Fixed

- **A batch of two or more changes parked whenever its members shared a step with a command of the project's own:** a batch's union plan rebuilt each shared step without its `run` (or its `deploy` spec), so the step had no runner, abstained and parked the batch, in no box. The union now keeps both.
