### Fixed

- **Agents' declares no longer wait on a project's mirror.**
  - A refill whose source cannot be read (it is gone, or its main fails two reads) forks nothing. Instead it makes a workspace from trunk itself: an empty repo, with trunk's whole history relayed into its main, one a pass.
  - A refill whose forks fail does the same after them.
  - `WorkspaceRefresher.advance` takes `from: null` for an empty workspace. A relay of trunk's whole history gets its own bound of 5 minutes a request (`WHOLE_RELAY_MS`); keel's own takes 101 s, against the 120 s every other git request is given.
  - Every failed fork or fill is logged with its cause; a failed fork used to be collected in silence.
  - On 15 Oct keel/keel's mirror answered every read with Artifacts' internal error, and declares met `workspace.pool_exhausted` once the ready workspaces ran out.
