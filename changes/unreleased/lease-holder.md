### Changed (breaking)

- **The event feed no longer carries lease ids.** `IntentDeclared`, `ChangeAdopted`, `LeaseLapsed` and `LeaseRestarted` are served without `leaseId`, which the spec now marks optional on all four; an agent reads its lease from the answer to `declare` or `adopt`.

### Changed

- **Only the agent holding a change acts under its lease.** Another agent of the change's project that calls `revise`, `rely`, `rebase`, `submit`, `commit`, `abandon` or `refreshWorkspaceToken` under it (or `resolve`'s distinction) is answered `409 change.held_by_other`, naming the holder and when its lease lapses, with `adopt` as the next action; nothing moves and the lease is not renewed. A caller outside the project is still answered `404 change.not_found`.
