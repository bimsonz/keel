### Changed

- **A change at the infra limit is held while the outage is Keel's.** At `INFRA_FAILURE_LIMIT` consecutive infra failures, the Lane bounces a change only when another batch of the lane has verified since its streak began (the infrastructure works for others), or once two hours (`INFRA_HOLD_MS`) have passed since its first. Until then it requeues the change at the front, as for any earlier infra failure, and logs the hold at error level for the operator. A capacity failure (`uncounted`) still counts nothing.
  - Core: the Lane's state keeps each streak's start (`since`) and how many batches the lane had verified then (`verifiedBefore`), and counts the batches it verifies (`verified`); `onBatch` hands its step the transaction's time.
