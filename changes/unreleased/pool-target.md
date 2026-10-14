### Fixed

- **A project's workspace pool keeps the Worker's `POOL_TARGET` ready, and an existing pool grows to it as it is used** (no route, event or migration). The variable was set (4) but read nowhere: every project's pool was created with 2 ready workspaces, and a workspace is held until its change lands, so on `keel/keel` two declares took both and the next answered `workspace.pool_exhausted`. A new project's pool is now created with `POOL_TARGET` (16), and a claim on a pool made under a lower target raises it to `POOL_TARGET`; a pool kept at none stays at none.
